import React from 'react';
import type { LightingConfig, LightingMode } from '../types';

interface LightsPageProps {
  lighting: LightingConfig;
  onChange: (patch: Partial<LightingConfig>) => void;
}

const MODES: { id: LightingMode; label: string }[] = [
  { id: 'custom', label: 'Custom' },
  { id: 'rainbow', label: 'Rainbow' },
  { id: 'wave', label: 'Wave' },
  { id: 'breath', label: 'Breath' },
  { id: 'off', label: 'Off' },
];

const KNOB_LABELS = ['K1', 'K2', 'K3', 'K4', 'K5'];
const SLIDER_LABELS = ['S1', 'S2', 'S3', 'S4'];

function PercentSlider({ value, max, onChange }: {
  value: number; max: number; onChange: (v: number) => void;
}) {
  return (
    <input
      className="lights-range"
      type="range"
      min={0}
      max={max}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
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

  const isAnimation = lighting.mode === 'rainbow' || lighting.mode === 'wave' || lighting.mode === 'breath';

  return (
    <>
      <div className="section-label">Lighting</div>

      <div className="lights-modes">
        {MODES.map(m => (
          <button
            key={m.id}
            className={`lights-mode ${lighting.mode === m.id ? 'selected' : ''}`}
            onClick={() => onChange({ mode: m.id })}
          >
            {m.label}
          </button>
        ))}
      </div>

      {lighting.mode !== 'off' && (
        <div className="lights-row">
          <span className="lights-row-name">Brightness</span>
          <PercentSlider
            value={lighting.brightness}
            max={100}
            onChange={(brightness) => onChange({ brightness })}
          />
          <span className="row-percent">{lighting.brightness}%</span>
        </div>
      )}

      {isAnimation && (
        <>
          {lighting.mode !== 'rainbow' && (
            <div className="lights-row">
              <span className="lights-row-name">Hue</span>
              <PercentSlider
                value={lighting.animationHue}
                max={255}
                onChange={(animationHue) => onChange({ animationHue })}
              />
              <span
                className="lights-hue-swatch"
                style={{ background: `hsl(${Math.round(lighting.animationHue / 255 * 360)} 100% 50%)` }}
              />
            </div>
          )}
          <div className="lights-row">
            <span className="lights-row-name">Speed</span>
            <PercentSlider
              value={lighting.animationSpeed}
              max={255}
              onChange={(animationSpeed) => onChange({ animationSpeed })}
            />
            <span className="row-percent">{Math.round(lighting.animationSpeed / 255 * 100)}%</span>
          </div>
        </>
      )}

      {lighting.mode === 'custom' && (
        <>
          <div className="section-label">Knobs</div>
          <div className="row-group">
            {KNOB_LABELS.map((label, i) => (
              <div className="lights-row" key={label}>
                <span className="row-icon-chip">{label}</span>
                <span className="lights-row-name">Knob {i + 1}</span>
                <input
                  type="color"
                  className="lights-color"
                  value={lighting.knobColors[i]}
                  onChange={(e) => setKnobColor(i, e.target.value)}
                  title="Ring color"
                />
              </div>
            ))}
          </div>

          <div className="section-label">Sliders</div>
          <div className="row-group">
            {SLIDER_LABELS.map((label, i) => (
              <div className="lights-row" key={label}>
                <span className="row-icon-chip">{label}</span>
                <span className="lights-row-name">Slider {i + 1}</span>
                <label className="lights-check" title="Light the track only up to the slider position">
                  <input
                    type="checkbox"
                    checked={lighting.sliders[i].volumeGradient}
                    onChange={(e) => setSlider(i, { volumeGradient: e.target.checked })}
                  />
                  Track volume
                </label>
                <input
                  type="color"
                  className="lights-color"
                  value={lighting.sliders[i].color1}
                  onChange={(e) => setSlider(i, { color1: e.target.value, color2: e.target.value })}
                  title="Track color"
                />
                <input
                  type="color"
                  className="lights-color"
                  value={lighting.sliderLabelColors[i]}
                  onChange={(e) => setLabelColor(i, e.target.value)}
                  title="Label color"
                />
              </div>
            ))}
          </div>

          <div className="section-label">Logo</div>
          <div className="row-group">
            <div className="lights-row">
              <span className="row-icon-chip">⭘</span>
              <span className="lights-row-name">Logo</span>
              <input
                type="color"
                className="lights-color"
                value={lighting.logoColor}
                onChange={(e) => onChange({ logoColor: e.target.value })}
                title="Logo color"
              />
            </div>
          </div>
        </>
      )}
    </>
  );
}
