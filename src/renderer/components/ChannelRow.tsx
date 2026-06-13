import React, { useState, useRef, useEffect } from 'react';
import { VUMeter, SpeakerIcon } from './VUMeter';
import type { AudioLevelInfo, ChannelState } from '../types';

interface ChannelRowProps {
  hardwareLabel: string;
  channel?: ChannelState;
  /** Hardware knob/slider position 0-255 */
  value: number;
  level?: AudioLevelInfo;
  /** Icon (data URL) of the first assigned app, if any */
  icon: string | null;
  onAssignClick: (channelId: string) => void;
  onMuteToggle: (channelId: string, muted: boolean) => void;
  onLabelChange: (channelId: string, label: string) => void;
}

// Filled pencil tilted 45°, SF-symbol style
function PencilIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      <path d="M16.7 3.5a2.7 2.7 0 0 1 3.8 3.8l-1.2 1.2-3.8-3.8 1.2-1.2ZM14.1 6.1l3.8 3.8-9.6 9.6-4.5 1.2a0.5 0.5 0 0 1-0.6-0.6l1.3-4.4 9.6-9.6Z" />
    </svg>
  );
}

export function ChannelRow({
  hardwareLabel,
  channel,
  value,
  level,
  icon,
  onAssignClick,
  onMuteToggle,
  onLabelChange,
}: ChannelRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(channel?.channelName || hardwareLabel);
  const inputRef = useRef<HTMLInputElement>(null);

  const channelId = channel?.id || hardwareLabel.toLowerCase();
  const percent = Math.round((value / 255) * 100);
  const muted = channel?.muted ?? false;
  const assigned = (channel?.apps?.length ?? 0) > 0;
  const isOtherApps = channel?.assignment?.type === 'other-apps';

  // RMS scaled for meter visibility (full scale at ~ -10 dBFS)
  const meterLevel = level ? Math.min(1, level.rms * 3) : 0;

  useEffect(() => {
    if (channel?.channelName) {
      setEditValue(channel.channelName);
    }
  }, [channel?.channelName]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const startEditing = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(channel?.channelName || hardwareLabel);
    setIsEditing(true);
  };

  const saveEdit = () => {
    setIsEditing(false);
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== channel?.channelName) {
      onLabelChange(channelId, trimmed);
    }
  };

  const cancelEdit = () => {
    setEditValue(channel?.channelName || hardwareLabel);
    setIsEditing(false);
  };

  const subtitle = assigned
    ? `${hardwareLabel} · ${channel!.apps.join(', ')}`
    : `${hardwareLabel} · click to assign apps`;

  return (
    <div className={`row ${muted ? 'muted' : ''}`} onClick={() => onAssignClick(channelId)}>
      <VUMeter level={meterLevel} muted={muted} />

      <div className="row-icon">
        {icon ? (
          <img src={icon} alt="" draggable={false} />
        ) : (
          <span className={`row-icon-chip ${isOtherApps ? 'star' : ''}`}>
            {isOtherApps ? '∗' : hardwareLabel}
          </span>
        )}
      </div>

      <div className="row-text">
        <div className="row-name-line">
          {isEditing ? (
            <input
              ref={inputRef}
              className="row-name-input"
              type="text"
              value={editValue}
              maxLength={20}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={saveEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveEdit();
                else if (e.key === 'Escape') {
                  e.stopPropagation();
                  cancelEdit();
                }
              }}
            />
          ) : (
            <>
              <span className="row-name">{channel?.channelName || hardwareLabel}</span>
              <button className="row-rename" title="Rename channel" onClick={startEditing}>
                <PencilIcon />
              </button>
            </>
          )}
        </div>
        <span className={`row-subtitle ${assigned ? '' : 'unassigned'}`}>{subtitle}</span>
      </div>

      <button
        className={`row-mute ${muted ? 'is-muted' : ''}`}
        title={muted ? 'Unmute' : 'Mute'}
        onClick={(e) => {
          e.stopPropagation();
          onMuteToggle(channelId, !muted);
        }}
      >
        <SpeakerIcon muted={muted} />
      </button>

      <div className="row-slider">
        <div className="row-slider-track">
          <div className="row-slider-fill" style={{ width: `${percent}%` }} />
          <div className="row-slider-unity" />
          <div className="row-slider-thumb" style={{ left: `${percent}%` }} />
        </div>
      </div>

      <span className="row-percent">{percent}%</span>
    </div>
  );
}
