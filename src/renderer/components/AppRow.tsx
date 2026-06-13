import React, { useRef, useState, useCallback } from 'react';
import { VUMeter, SpeakerIcon } from './VUMeter';
import type { AudioLevelInfo, RunningApp } from '../types';

interface AppRowProps {
  app: RunningApp;
  level?: AudioLevelInfo;
  /** Hardware label (e.g. "K1") when the app is also on a channel */
  channelTag?: string;
  onVolumeChange: (bundleID: string, volume: number) => void;
  onMuteToggle: (bundleID: string, muted: boolean) => void;
}

const VOLUME_SEND_INTERVAL_MS = 50;

export function AppRow({ app, level, channelTag, onVolumeChange, onMuteToggle }: AppRowProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const lastSent = useRef(0);
  // Local volume while dragging so the slider tracks the pointer exactly
  const [dragVolume, setDragVolume] = useState<number | null>(null);

  const volume = dragVolume ?? app.volume;
  const percent = Math.round(volume * 100);
  const meterLevel = level ? Math.min(1, level.rms * 3) : 0;

  const volumeFromPointer = useCallback((clientX: number): number => {
    const track = trackRef.current;
    if (!track) return 1;
    const rect = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const v = volumeFromPointer(e.clientX);
    setDragVolume(v);
    lastSent.current = Date.now();
    onVolumeChange(app.bundleID, v);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (dragVolume === null) return;
    const v = volumeFromPointer(e.clientX);
    setDragVolume(v);
    if (Date.now() - lastSent.current >= VOLUME_SEND_INTERVAL_MS) {
      lastSent.current = Date.now();
      onVolumeChange(app.bundleID, v);
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (dragVolume === null) return;
    const v = volumeFromPointer(e.clientX);
    setDragVolume(null);
    onVolumeChange(app.bundleID, v);
  };

  return (
    <div className={`row app-row ${app.muted ? 'muted' : ''}`}>
      <VUMeter level={meterLevel} muted={app.muted} />

      <div className="row-icon">
        {app.icon ? (
          <img src={app.icon} alt="" draggable={false} />
        ) : (
          <span className="row-icon-chip">{app.name.slice(0, 2)}</span>
        )}
        {app.isAudible && <span className="row-audible-dot" />}
      </div>

      <div className="row-text">
        <div className="row-name-line">
          <span className="row-name">{app.name}</span>
          {channelTag && <span className="row-tag" title={`Assigned to ${channelTag}`}>{channelTag}</span>}
        </div>
      </div>

      <button
        className={`row-mute ${app.muted ? 'is-muted' : ''}`}
        title={app.muted ? 'Unmute' : 'Mute'}
        onClick={(e) => {
          e.stopPropagation();
          onMuteToggle(app.bundleID, !app.muted);
        }}
      >
        <SpeakerIcon muted={app.muted} />
      </button>

      <div
        className="row-slider interactive"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => setDragVolume(null)}
      >
        <div className="row-slider-track" ref={trackRef}>
          <div className="row-slider-fill" style={{ width: `${percent}%` }} />
          <div className="row-slider-unity" />
          <div className="row-slider-thumb" style={{ left: `${percent}%` }} />
        </div>
      </div>

      <span className="row-percent">{percent}%</span>
    </div>
  );
}
