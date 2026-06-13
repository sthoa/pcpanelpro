import React, { useRef, useState } from 'react';
import type { LightingConfig, LightingMode } from '../types';

interface LightsPageProps {
  lighting: LightingConfig;
  onChange: (patch: Partial<LightingConfig>) => void;
}

// 'wave' is intentionally omitted: its firmware effect hangs the panel and
// drops it off USB. The wave opcode is the trigger (the packet is otherwise
// identical to breath), so it can't be fixed host-side.
const MODES: { id: LightingMode; label: string }[] = [
  { id: 'custom', label: 'Custom' },
  { id: 'rainbow', label: 'Rainbow' },
  { id: 'breath', label: 'Breath' },
  { id: 'off', label: 'Off' },
];

// Black or white text for legibility on a given hex background
function contrastText(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '#fff';
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? 'rgba(0,0,0,0.7)' : '#fff';
}

function Swatch({ value, title, onChange }: {
  value: string; title: string; onChange: (v: string) => void;
}) {
  return (
    <input
      type="color"
      className="lights-swatch"
      value={value}
      title={title}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function Slider({ value, max, onChange, white }: {
  value: number; max: number; onChange: (v: number) => void; white?: boolean;
}) {
  // Paint a white fill up to the current value (native ranges show no fill)
  const pct = max > 0 ? (value / max) * 100 : 0;
  const style = white
    ? { background: `linear-gradient(to right, #fff 0 ${pct}%, var(--track) ${pct}% 100%)` }
    : undefined;
  return (
    <input
      className="lights-range"
      style={style}
      type="range"
      min={0}
      max={max}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

// Per-control brightness as a draggable bar, sized like the volume bars but
// with a white fill. The sun icon toggles the control's light on/off.
function BrightnessBar({ value, onChange, enabled, onToggle }: {
  value: number; onChange: (v: number) => void; enabled: boolean; onToggle: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const lastSent = useRef(0);
  const [dragValue, setDragValue] = useState<number | null>(null);
  const v = dragValue ?? value;

  const pctFromX = (clientX: number): number => {
    const t = trackRef.current;
    if (!t) return value;
    const r = t.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * 100);
  };

  const handleDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const n = pctFromX(e.clientX);
    setDragValue(n);
    lastSent.current = Date.now();
    onChange(n);
  };
  const handleMove = (e: React.PointerEvent) => {
    if (dragValue === null) return;
    const n = pctFromX(e.clientX);
    setDragValue(n);
    if (Date.now() - lastSent.current >= 60) {  // throttle HID writes during drag
      lastSent.current = Date.now();
      onChange(n);
    }
  };
  const handleUp = (e: React.PointerEvent) => {
    if (dragValue === null) return;
    const n = pctFromX(e.clientX);
    setDragValue(null);
    onChange(n);
  };

  return (
    <div className={`bright-control ${enabled ? '' : 'off'}`} title={`Brightness ${v}%`}>
      <button className="bright-icon-btn" onClick={onToggle}
        title={enabled ? 'Turn light off' : 'Turn light on'}>
        <svg className="bright-icon" width="16" height="16" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
          <line x1="12" y1="2.5" x2="12" y2="4.5" /><line x1="12" y1="19.5" x2="12" y2="21.5" />
          <line x1="2.5" y1="12" x2="4.5" y2="12" /><line x1="19.5" y1="12" x2="21.5" y2="12" />
          <line x1="5.2" y1="5.2" x2="6.6" y2="6.6" /><line x1="17.4" y1="17.4" x2="18.8" y2="18.8" />
          <line x1="5.2" y1="18.8" x2="6.6" y2="17.4" /><line x1="17.4" y1="6.6" x2="18.8" y2="5.2" />
        </svg>
      </button>
      <div className="bright-bar"
        onPointerDown={handleDown} onPointerMove={handleMove}
        onPointerUp={handleUp} onPointerCancel={() => setDragValue(null)}>
        <div className="bright-bar-track" ref={trackRef}>
          <div className="bright-bar-fill" style={{ width: `${v}%` }} />
          <div className="bright-bar-thumb" style={{ left: `${v}%` }} />
        </div>
      </div>
      <span className="bright-pct">{v}%</span>
    </div>
  );
}

export function LightsPage({ lighting, onChange }: LightsPageProps) {
  const setKnobColor = (i: number, color: string) => {
    const knobColors = [...lighting.knobColors];
    knobColors[i] = color;
    onChange({ knobColors });
  };

  const setSlider = (i: number, patch: Partial<LightingConfig['sliders'][0]>) => {
    const sliders = lighting.sliders.map((s, idx) => idx === i ? { ...s, ...patch } : s);
    onChange({ sliders });
  };

  const setLabelColor = (i: number, color: string) => {
    const sliderLabelColors = [...lighting.sliderLabelColors];
    sliderLabelColors[i] = color;
    onChange({ sliderLabelColors });
  };

  const setKnobBrightness = (i: number, b: number) => {
    const knobBrightness = [...lighting.knobBrightness];
    knobBrightness[i] = b;
    onChange({ knobBrightness });
  };

  const setSliderBrightness = (i: number, b: number) => {
    const sliderBrightness = [...lighting.sliderBrightness];
    sliderBrightness[i] = b;
    onChange({ sliderBrightness });
  };

  const toggleKnob = (i: number) => {
    const knobEnabled = [...lighting.knobEnabled];
    knobEnabled[i] = !knobEnabled[i];
    onChange({ knobEnabled });
  };

  const toggleSlider = (i: number) => {
    const sliderEnabled = [...lighting.sliderEnabled];
    sliderEnabled[i] = !sliderEnabled[i];
    onChange({ sliderEnabled });
  };

  const isAnimation = lighting.mode === 'rainbow' || lighting.mode === 'breath';

  return (
    <>
      <div className="section-label">Lighting</div>

      <div className="lights-segment">
        {MODES.map(m => (
          <button
            key={m.id}
            className={lighting.mode === m.id ? 'selected' : ''}
            onClick={() => onChange({ mode: m.id })}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Global controls for the active mode */}
      {lighting.mode !== 'off' && (
        <div className="row-group">
          <div className="lights-row">
            <span className="lights-row-label">Brightness</span>
            <Slider value={lighting.brightness} max={100} white
              onChange={(brightness) => onChange({ brightness })} />
            <span className="lights-value">{lighting.brightness}%</span>
          </div>

          {lighting.mode === 'breath' && (
            <div className="lights-row">
              <span className="lights-row-label">Color</span>
              <Slider value={lighting.animationHue} max={255}
                onChange={(animationHue) => onChange({ animationHue })} />
              <span className="lights-hue-swatch"
                style={{ background: `hsl(${Math.round(lighting.animationHue / 255 * 360)} 90% 55%)` }} />
            </div>
          )}

          {isAnimation && (
            <div className="lights-row">
              <span className="lights-row-label">Speed</span>
              <Slider value={lighting.animationSpeed} max={255}
                onChange={(animationSpeed) => onChange({ animationSpeed })} />
              <span className="lights-value">{Math.round(lighting.animationSpeed / 255 * 100)}%</span>
            </div>
          )}
        </div>
      )}

      {lighting.mode === 'custom' && (
        <>
          <div className="section-divider" />
          <div className="section-label">Knobs</div>
          <div className="row-group">
            {lighting.knobColors.map((color, i) => (
              <div className="lights-row" key={i}>
                <span className="row-icon-chip" style={{ background: color, color: contrastText(color) }}>K{i + 1}</span>
                <Swatch value={color} title="Ring color"
                  onChange={(c) => setKnobColor(i, c)} />
                <BrightnessBar value={lighting.knobBrightness[i]}
                  onChange={(b) => setKnobBrightness(i, b)}
                  enabled={lighting.knobEnabled[i]} onToggle={() => toggleKnob(i)} />
              </div>
            ))}
          </div>

          <div className="section-divider" />
          <div className="section-label">Sliders</div>
          <div className="row-group">
            {lighting.sliders.map((slider, i) => (
              <div className="lights-row" key={i}>
                <span className="row-icon-chip" style={{ background: slider.color1, color: contrastText(slider.color1) }}>S{i + 1}</span>
                <Swatch value={slider.color1} title="Track color"
                  onChange={(c) => setSlider(i, { color1: c, color2: c })} />
                <Swatch value={lighting.sliderLabelColors[i]} title="Label color"
                  onChange={(c) => setLabelColor(i, c)} />
                <button
                  className={`lights-toggle ${slider.volumeGradient ? 'on' : ''}`}
                  title="Light the track only up to the slider position"
                  onClick={() => setSlider(i, { volumeGradient: !slider.volumeGradient })}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="4" y="13" width="4" height="7" rx="1" />
                    <rect x="10" y="9" width="4" height="11" rx="1" />
                    <rect x="16" y="4" width="4" height="16" rx="1" opacity="0.4" />
                  </svg>
                </button>
                <BrightnessBar value={lighting.sliderBrightness[i]}
                  onChange={(b) => setSliderBrightness(i, b)}
                  enabled={lighting.sliderEnabled[i]} onToggle={() => toggleSlider(i)} />
              </div>
            ))}
          </div>

          <div className="section-divider" />
          <div className="section-label">Logo</div>
          <div className="row-group">
            <div className="lights-row">
              <span className="row-icon-chip logo" style={{ background: lighting.logoColor, color: contrastText(lighting.logoColor) }}>◉</span>
              <Swatch value={lighting.logoColor} title="Logo color"
                onChange={(c) => onChange({ logoColor: c })} />
              <BrightnessBar value={lighting.logoBrightness}
                onChange={(b) => onChange({ logoBrightness: b })}
                enabled={lighting.logoEnabled}
                onToggle={() => onChange({ logoEnabled: !lighting.logoEnabled })} />
            </div>
          </div>
        </>
      )}
    </>
  );
}
