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
  createWavePacket,
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
  brightness: number;      // 0-100
  knobColors: string[];    // 5 knob rings
  sliders: SliderLighting[];   // 4 LED tracks
  sliderLabelColors: string[]; // 4 label backlights
  logoColor: string;
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
    sliders: new Array(4).fill(null).map(() => ({
      color1: DEFAULT_COLOR,
      color2: DEFAULT_COLOR,
      volumeGradient: true,
    })),
    sliderLabelColors: new Array(4).fill(DEFAULT_COLOR),
    logoColor: DEFAULT_COLOR,
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

  return {
    mode: ['custom', 'rainbow', 'wave', 'breath', 'off'].includes(loaded.mode as string)
      ? (loaded.mode as LightingMode) : def.mode,
    brightness: typeof loaded.brightness === 'number'
      ? Math.max(0, Math.min(100, Math.round(loaded.brightness))) : def.brightness,
    knobColors: def.knobColors.map((d, i) => color(loaded.knobColors?.[i], d)),
    sliders: def.sliders.map((d, i) => ({
      color1: color(loaded.sliders?.[i]?.color1, d.color1),
      color2: color(loaded.sliders?.[i]?.color2, d.color2),
      volumeGradient: typeof loaded.sliders?.[i]?.volumeGradient === 'boolean'
        ? loaded.sliders[i].volumeGradient : d.volumeGradient,
    })),
    sliderLabelColors: def.sliderLabelColors.map((d, i) => color(loaded.sliderLabelColors?.[i], d)),
    logoColor: color(loaded.logoColor, def.logoColor),
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
      case 'custom':
        packets = [
          createKnobLightingPacket(c.brightness, c.knobColors),
          createSliderLabelLightingPacket(c.brightness, c.sliderLabelColors),
          createSliderLightingPacket(c.brightness, c.sliders),
          createLogoLightingPacket(c.brightness, c.logoColor),
        ];
        break;
      case 'rainbow':
        packets = [createRainbowPacket(c.brightness, c.animationSpeed)];
        break;
      case 'wave':
        packets = [createWavePacket(c.brightness, c.animationHue, c.animationSpeed)];
        break;
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
