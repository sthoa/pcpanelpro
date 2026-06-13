// Lighting manager: persists the RGB configuration and pushes it to the
// PC Panel Pro whenever it changes or the device (re)connects.

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { PCPanelConnection } from './hid/connection';
import {
  createKnobLightingPacket,
  createSliderLightingPacket,
  createSliderLabelLightingPacket,
  createLogoLightingPacket,
  createStaticAllPacket,
  createRainbowPacket,
  createBreathPacket,
} from './hid/protocol';

export type LightingMode = 'custom' | 'rainbow' | 'wave' | 'breath' | 'off';

export interface SliderLighting {
  color1: string;          // bottom of the LED track
  color2: string;          // top of the LED track
  volumeGradient: boolean; // light only up to the slider position
}

export interface LightingConfig {
  mode: LightingMode;
  brightness: number;      // 0-100, global
  knobColors: string[];    // 5 knob rings
  knobBrightness: number[];    // 5, 0-100, per knob
  knobEnabled: boolean[];      // 5, light on/off per knob
  sliders: SliderLighting[];   // 4 LED tracks
  sliderBrightness: number[];  // 4, 0-100, per slider (track + label)
  sliderEnabled: boolean[];    // 4, light on/off per slider
  sliderLabelColors: string[]; // 4 label backlights
  logoColor: string;
  logoBrightness: number;  // 0-100
  logoEnabled: boolean;    // logo light on/off
  animationHue: number;    // 0-255, wave/breath
  animationSpeed: number;  // 0-255
}

const CONFIG_FILENAME = 'lighting.json';
const DEFAULT_COLOR = '#0a84ff';

export function createDefaultLighting(): LightingConfig {
  return {
    mode: 'custom',
    brightness: 100,
    knobColors: new Array(5).fill(DEFAULT_COLOR),
    knobBrightness: new Array(5).fill(100),
    knobEnabled: new Array(5).fill(true),
    sliders: new Array(4).fill(null).map(() => ({
      color1: DEFAULT_COLOR,
      color2: DEFAULT_COLOR,
      volumeGradient: true,
    })),
    sliderBrightness: new Array(4).fill(100),
    sliderEnabled: new Array(4).fill(true),
    sliderLabelColors: new Array(4).fill(DEFAULT_COLOR),
    logoColor: DEFAULT_COLOR,
    logoBrightness: 100,
    logoEnabled: true,
    animationHue: 150,
    animationSpeed: 100,
  };
}

function configPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILENAME);
}

const HEX = /^#[0-9a-f]{6}$/i;

function sanitize(loaded: Partial<LightingConfig> | null): LightingConfig {
  const def = createDefaultLighting();
  if (!loaded || typeof loaded !== 'object') return def;

  const color = (v: unknown, fallback: string) =>
    typeof v === 'string' && HEX.test(v) ? v : fallback;
  const pct = (v: unknown, fallback: number) =>
    typeof v === 'number' ? Math.max(0, Math.min(100, Math.round(v))) : fallback;
  const bool = (v: unknown, fallback: boolean) =>
    typeof v === 'boolean' ? v : fallback;

  return {
    // 'wave' is excluded — its firmware effect hangs the panel; a saved
    // 'wave' falls back to the default mode
    mode: ['custom', 'rainbow', 'breath', 'off'].includes(loaded.mode as string)
      ? (loaded.mode as LightingMode) : def.mode,
    brightness: typeof loaded.brightness === 'number'
      ? Math.max(0, Math.min(100, Math.round(loaded.brightness))) : def.brightness,
    knobColors: def.knobColors.map((d, i) => color(loaded.knobColors?.[i], d)),
    knobBrightness: def.knobBrightness.map((d, i) => pct(loaded.knobBrightness?.[i], d)),
    knobEnabled: def.knobEnabled.map((d, i) => bool(loaded.knobEnabled?.[i], d)),
    sliders: def.sliders.map((d, i) => ({
      color1: color(loaded.sliders?.[i]?.color1, d.color1),
      color2: color(loaded.sliders?.[i]?.color2, d.color2),
      volumeGradient: typeof loaded.sliders?.[i]?.volumeGradient === 'boolean'
        ? loaded.sliders[i].volumeGradient : d.volumeGradient,
    })),
    sliderBrightness: def.sliderBrightness.map((d, i) => pct(loaded.sliderBrightness?.[i], d)),
    sliderEnabled: def.sliderEnabled.map((d, i) => bool(loaded.sliderEnabled?.[i], d)),
    sliderLabelColors: def.sliderLabelColors.map((d, i) => color(loaded.sliderLabelColors?.[i], d)),
    logoColor: color(loaded.logoColor, def.logoColor),
    logoBrightness: pct(loaded.logoBrightness, def.logoBrightness),
    logoEnabled: bool(loaded.logoEnabled, def.logoEnabled),
    animationHue: typeof loaded.animationHue === 'number'
      ? Math.max(0, Math.min(255, Math.round(loaded.animationHue))) : def.animationHue,
    animationSpeed: typeof loaded.animationSpeed === 'number'
      ? Math.max(0, Math.min(255, Math.round(loaded.animationSpeed))) : def.animationSpeed,
  };
}

class LightingManager {
  private config: LightingConfig;
  private connection: PCPanelConnection | null = null;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    let loaded: Partial<LightingConfig> | null = null;
    try {
      if (fs.existsSync(configPath())) {
        loaded = JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
      }
    } catch (err) {
      console.error('Failed to load lighting config:', err);
    }
    this.config = sanitize(loaded);
  }

  getConfig(): LightingConfig {
    return this.config;
  }

  setConfig(config: Partial<LightingConfig>): void {
    this.config = sanitize({ ...this.config, ...config });
    this.scheduleSave();
    this.apply();
  }

  /** Track the active device connection; pushes lighting on connect */
  attach(connection: PCPanelConnection): void {
    this.connection = connection;
  }

  /** Build and send the packets for the current config */
  apply(): boolean {
    if (!this.connection || !this.connection.isConnected()) {
      return false;
    }

    const c = this.config;
    let packets: Buffer[];

    switch (c.mode) {
      case 'custom': {
        // Effective brightness = global × per-control, both 0-100
        const knobB = c.knobBrightness.map(b => (c.brightness * b) / 100);
        const sliderB = c.sliderBrightness.map(b => (c.brightness * b) / 100);
        // Disabled controls send static black (LED off). A null/NONE color
        // would instead leave the LED at its previous state, not turn it off.
        const OFF = '#000000';
        const knobColors = c.knobColors.map((col, i) => c.knobEnabled[i] ? col : OFF);
        const sliderLabelColors = c.sliderLabelColors.map((col, i) => c.sliderEnabled[i] ? col : OFF);
        const sliders = c.sliders.map((s, i) =>
          c.sliderEnabled[i] ? s : { color1: OFF, color2: OFF, volumeGradient: false });
        packets = [
          createKnobLightingPacket(knobB, knobColors),
          createSliderLabelLightingPacket(sliderB, sliderLabelColors),
          createSliderLightingPacket(sliderB, sliders),
          createLogoLightingPacket((c.brightness * c.logoBrightness) / 100,
            c.logoEnabled ? c.logoColor : OFF),
        ];
        break;
      }
      case 'rainbow':
        packets = [createRainbowPacket(c.brightness, c.animationSpeed)];
        break;
      case 'wave':
        // Never send the wave packet — its firmware effect hangs the panel
        // and forces a physical USB reconnect. Treated as a no-op.
        console.warn('Lighting: wave mode is unsupported on this hardware; skipping');
        return false;
      case 'breath':
        packets = [createBreathPacket(c.brightness, c.animationHue, c.animationSpeed)];
        break;
      case 'off':
        packets = [createStaticAllPacket(0, '#000000')];
        break;
    }

    const ok = this.connection.sendPackets(packets);
    if (ok) {
      console.log(`Lighting applied (${c.mode}, ${packets.length} packets)`);
    }
    return ok;
  }

  private scheduleSave(): void {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      try {
        fs.writeFileSync(configPath(), JSON.stringify(this.config, null, 2), 'utf-8');
      } catch (err) {
        console.error('Failed to save lighting config:', err);
      }
    }, 1000);
  }
}

export const lightingManager = new LightingManager();
