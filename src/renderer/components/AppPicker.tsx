import React, { useState, useEffect } from 'react';
import type { ChannelAssignment, RunningApp } from '../types';

interface AppPickerProps {
  channelName: string;
  assignment: ChannelAssignment;
  runningApps: RunningApp[];
  /** Bundle IDs assigned to other channels (shown with a hint) */
  assignedElsewhere: Record<string, string>;
  /** Name of the channel currently holding 'other-apps', if any */
  otherAppsHolder: string | null;
  onSave: (assignment: ChannelAssignment) => void;
  onCancel: () => void;
}

export function AppPicker({
  channelName,
  assignment,
  runningApps,
  assignedElsewhere,
  otherAppsHolder,
  onSave,
  onCancel,
}: AppPickerProps) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(assignment.type === 'apps' ? assignment.bundleIDs : [])
  );
  const [otherApps, setOtherApps] = useState(assignment.type === 'other-apps');

  // Apps assigned but not currently running still need to be listed so the
  // user can unassign them
  const [staleBundleIDs, setStaleBundleIDs] = useState<string[]>([]);
  useEffect(() => {
    if (assignment.type !== 'apps') return;
    const running = new Set(runningApps.map(a => a.bundleID));
    setStaleBundleIDs(assignment.bundleIDs.filter(b => !running.has(b)));
  }, []);

  const toggleApp = (bundleID: string) => {
    setOtherApps(false);
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(bundleID)) {
        next.delete(bundleID);
      } else {
        next.add(bundleID);
      }
      return next;
    });
  };

  const toggleOtherApps = () => {
    setOtherApps(prev => {
      if (!prev) setSelected(new Set());
      return !prev;
    });
  };

  const handleSave = () => {
    if (otherApps) {
      onSave({ type: 'other-apps' });
    } else if (selected.size > 0) {
      onSave({ type: 'apps', bundleIDs: [...selected] });
    } else {
      onSave({ type: 'none' });
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onCancel();
    }
  };

  return (
    <div className="channel-name-editor-overlay" onClick={handleOverlayClick}>
      <div className="app-picker">
        <label>Assign apps to {channelName}</label>

        <div className="app-picker-list">
          <div
            className={`app-picker-item ${otherApps ? 'selected' : ''}`}
            onClick={toggleOtherApps}
          >
            <span className="app-picker-icon other-apps-icon">∗</span>
            <span className="app-picker-name">
              All other apps
              {otherAppsHolder && !otherApps && (
                <span className="app-picker-hint"> (on {otherAppsHolder})</span>
              )}
            </span>
            <span className="app-picker-check">{otherApps ? '✓' : ''}</span>
          </div>

          {runningApps.map(app => {
            const isSelected = selected.has(app.bundleID);
            const elsewhere = assignedElsewhere[app.bundleID];
            return (
              <div
                key={app.bundleID}
                className={`app-picker-item ${isSelected ? 'selected' : ''}`}
                onClick={() => toggleApp(app.bundleID)}
              >
                {app.icon ? (
                  <img className="app-picker-icon" src={app.icon} alt="" />
                ) : (
                  <span className="app-picker-icon app-picker-icon-placeholder" />
                )}
                <span className="app-picker-name">
                  {app.name}
                  {app.isAudible && <span className="app-picker-audible" title="Playing audio" />}
                  {elsewhere && !isSelected && (
                    <span className="app-picker-hint"> (on {elsewhere})</span>
                  )}
                </span>
                <span className="app-picker-check">{isSelected ? '✓' : ''}</span>
              </div>
            );
          })}

          {staleBundleIDs.map(bundleID => {
            const isSelected = selected.has(bundleID);
            return (
              <div
                key={bundleID}
                className={`app-picker-item stale ${isSelected ? 'selected' : ''}`}
                onClick={() => toggleApp(bundleID)}
              >
                <span className="app-picker-icon app-picker-icon-placeholder" />
                <span className="app-picker-name">
                  {bundleID}
                  <span className="app-picker-hint"> (not running)</span>
                </span>
                <span className="app-picker-check">{isSelected ? '✓' : ''}</span>
              </div>
            );
          })}
        </div>

        <div className="channel-name-editor-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" className="primary" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}
