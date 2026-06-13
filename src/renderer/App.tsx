import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ChannelRow } from './components/ChannelRow';
import { AppRow } from './components/AppRow';
import { Toast } from './components/Toast';
import { AppPicker } from './components/AppPicker';
import { LightsPage } from './components/LightsPage';
import type { PCPanelAPI, DeviceState, AudioRoutingState, ButtonAction, ChannelAssignment, ToastData, AudioLevelInfo, LightingConfig } from './types';

// Access the preload-exposed API
const pcpanel = (window as unknown as { pcpanel: PCPanelAPI }).pcpanel;

const KNOB_LABELS = ['K1', 'K2', 'K3', 'K4', 'K5'];
const SLIDER_LABELS = ['S1', 'S2', 'S3', 'S4'];

// Clockwise circular arrow with a filled triangular head, SF-symbol style
function ReconnectIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path d="M20.5 12a8.5 8.5 0 1 1-3-6.5" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" />
      <path d="M21.6 1.9v6h-6Z" fill="currentColor" transform="rotate(8 18.6 4.9)" />
    </svg>
  );
}

// Lightbulb outline with filled base, SF-symbol style
function LightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2.5a6.5 6.5 0 0 1 3.6 11.9c-.7.5-1.1 1.2-1.1 2v.6h-5v-.6c0-.8-.4-1.5-1.1-2A6.5 6.5 0 0 1 12 2.5Z" />
      <line x1="9.8" y1="20.5" x2="14.2" y2="20.5" />
    </svg>
  );
}

// Three horizontal slider tracks with offset thumbs, SF-symbol style
function ChannelsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round">
      <line x1="3" y1="6" x2="21" y2="6" />
      <circle cx="15" cy="6" r="2.6" fill="currentColor" stroke="none" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <circle cx="8" cy="12" r="2.6" fill="currentColor" stroke="none" />
      <line x1="3" y1="18" x2="21" y2="18" />
      <circle cx="17" cy="18" r="2.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function App() {
  const [connected, setConnected] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Searching for device…');
  const [analogValues, setAnalogValues] = useState<number[]>(new Array(9).fill(0));
  const [buttonStates, setButtonStates] = useState<boolean[]>(new Array(5).fill(false));
  const [routingState, setRoutingState] = useState<AudioRoutingState | null>(null);
  const [audioLevels, setAudioLevels] = useState<Record<string, AudioLevelInfo>>({});
  const [currentToast, setCurrentToast] = useState<ToastData | null>(null);
  const [pickerChannelId, setPickerChannelId] = useState<string | null>(null);
  const [view, setView] = useState<'apps' | 'channels' | 'lights'>('apps');
  const [lighting, setLightingState] = useState<LightingConfig | null>(null);
  const [outputMenuOpen, setOutputMenuOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const handleReconnect = useCallback(() => {
    setConnected(false);
    setStatusMessage('Reconnecting…');
    pcpanel.reconnect();
  }, []);

  const handleLabelChange = useCallback(async (channelId: string, label: string) => {
    try {
      const newState = await pcpanel.setChannelLabel(channelId, label);
      setRoutingState(newState);
    } catch (err) {
      console.error('Failed to update label:', err);
    }
  }, []);

  const handleMuteToggle = useCallback(async (channelId: string, muted: boolean) => {
    // Optimistic update for a snappy mute button
    setRoutingState(prev => prev && {
      ...prev,
      channels: prev.channels.map(ch => ch.id === channelId ? { ...ch, muted } : ch),
    });
    try {
      await pcpanel.setChannelMuted(channelId, muted);
    } catch (err) {
      console.error('Failed to toggle mute:', err);
    }
  }, []);

  const handleAssignClick = useCallback(async (channelId: string) => {
    // Refresh the running app list so the picker is current
    try {
      const newState = await pcpanel.getAudioRouting();
      setRoutingState(newState);
    } catch (err) {
      console.error('Failed to refresh routing state:', err);
    }
    setPickerChannelId(channelId);
  }, []);

  const handleAssignmentSave = useCallback(async (channelId: string, assignment: ChannelAssignment) => {
    setPickerChannelId(null);
    try {
      const newState = await pcpanel.setChannelAssignment(channelId, assignment);
      setRoutingState(newState);
    } catch (err) {
      console.error('Failed to update assignment:', err);
    }
  }, []);

  const handleAppVolumeChange = useCallback((bundleID: string, volume: number) => {
    // Optimistic update so the slider doesn't snap back between refreshes;
    // a single-app channel's row mirrors the same value
    setRoutingState(prev => prev && {
      ...prev,
      runningApps: prev.runningApps.map(a =>
        a.bundleID === bundleID ? { ...a, volume } : a
      ),
      channels: prev.channels.map(ch =>
        ch.assignment.type === 'apps' && ch.assignment.bundleIDs.length === 1 &&
        ch.assignment.bundleIDs[0] === bundleID
          ? { ...ch, volume }
          : ch
      ),
    });
    pcpanel.setAppVolume(bundleID, volume).catch((err) => {
      console.error('Failed to set app volume:', err);
    });
  }, []);

  const handleAppMuteToggle = useCallback((bundleID: string, muted: boolean) => {
    setRoutingState(prev => prev && {
      ...prev,
      runningApps: prev.runningApps.map(a =>
        a.bundleID === bundleID ? { ...a, muted } : a
      ),
    });
    pcpanel.setAppMuted(bundleID, muted).catch((err) => {
      console.error('Failed to toggle app mute:', err);
    });
  }, []);

  const handleButtonActionChange = useCallback(async (buttonIndex: number, value: string) => {
    let action: ButtonAction;
    if (value === 'mute-channel' || value === 'media-play-pause' ||
        value === 'media-next' || value === 'media-previous') {
      action = { type: value };
    } else if (value.startsWith('output:')) {
      action = { type: 'switch-output', deviceName: value.slice(7) };
    } else {
      action = { type: 'none' };
    }
    try {
      const newState = await pcpanel.setButtonAction(buttonIndex, action);
      setRoutingState(newState);
    } catch (err) {
      console.error('Failed to set button action:', err);
    }
  }, []);

  const handleLightingChange = useCallback((patch: Partial<LightingConfig>) => {
    // Optimistic local state; main applies to the device and persists
    setLightingState(prev => prev && { ...prev, ...patch });
    pcpanel.setLighting(patch).catch((err) => {
      console.error('Failed to set lighting:', err);
    });
  }, []);

  const handleOutputDeviceChange = useCallback(async (deviceId: number) => {
    // Optimistic: mark the chosen device as the default immediately
    setRoutingState(prev => prev && {
      ...prev,
      availableOutputs: prev.availableOutputs.map(o => ({ ...o, isDefault: o.id === deviceId })),
    });
    try {
      await pcpanel.setOutputDevice(deviceId);
      const newState = await pcpanel.getAudioRouting();
      setRoutingState(newState);
    } catch (err) {
      console.error('Failed to change output device:', err);
    }
  }, []);

  useEffect(() => {
    pcpanel.onDeviceStatus((status) => {
      setConnected(status.connected);
      setStatusMessage(status.message);
    });

    pcpanel.onDeviceState((state: DeviceState) => {
      setConnected(state.connected);
      setAnalogValues([...state.analogValues]);
      setButtonStates([...state.buttonStates]);

      // Hardware moved: mirror the write-through the routing manager does,
      // so channel rows and assigned app rows update immediately
      setRoutingState(prev => {
        if (!prev) return prev;
        const channels = prev.channels.map(ch => ({
          ...ch,
          volume: state.analogValues[ch.hardwareIndex] / 255,
        }));
        const volumeByBundleID: Record<string, number> = {};
        for (const ch of prev.channels) {
          if (ch.assignment.type !== 'apps') continue;
          for (const bundleID of ch.assignment.bundleIDs) {
            volumeByBundleID[bundleID] = state.analogValues[ch.hardwareIndex] / 255;
          }
        }
        const runningApps = prev.runningApps.map(a =>
          volumeByBundleID[a.bundleID] !== undefined
            ? { ...a, volume: volumeByBundleID[a.bundleID] }
            : a
        );
        return { ...prev, channels, runningApps };
      });
    });

    pcpanel.onChannelActivity((activityInfo) => {
      setRoutingState(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          channels: prev.channels.map(ch => ({
            ...ch,
            isActive: activityInfo[ch.hardwareIndex]?.isActive ?? false,
            apps: activityInfo[ch.hardwareIndex]?.apps ?? [],
          })),
        };
      });
    });

    pcpanel.onAudioLevels((levels) => {
      setAudioLevels(levels);
    });

    pcpanel.onToast((toast) => {
      setCurrentToast(toast);
    });

    pcpanel.getDeviceState().then((state) => {
      if (state.connected) {
        setConnected(true);
        setStatusMessage('Connected');
        setAnalogValues([...state.analogValues]);
        setButtonStates([...state.buttonStates]);
      }
    });

    pcpanel.getAudioRouting().then((state) => {
      setRoutingState(state);
    });

    pcpanel.getLighting().then(setLightingState).catch(() => {});

    // Keep running apps (icons), assignments, and outputs fresh; the first
    // fetch can race the routing manager's initial process scan
    const refreshInterval = setInterval(() => {
      pcpanel.getAudioRouting().then(setRoutingState).catch(() => {});
    }, 5000);
    return () => clearInterval(refreshInterval);
  }, []);

  // Report the panel's natural height so the window hugs its content as the
  // app list grows and shrinks
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const report = () => {
      const panel = document.querySelector('.panel');
      const bar = document.querySelector('.titlebar');
      const foot = document.querySelector('.panel-footer');
      if (!panel || !bar || !foot) return;
      const ps = getComputedStyle(panel);
      pcpanel.reportContentHeight(Math.ceil(
        parseFloat(ps.paddingTop) + parseFloat(ps.paddingBottom) +
        (bar as HTMLElement).offsetHeight + parseFloat(getComputedStyle(bar).marginBottom) +
        content.offsetHeight +
        (foot as HTMLElement).offsetHeight + parseFloat(getComputedStyle(foot).marginTop)
      ));
    };
    const observer = new ResizeObserver(report);
    observer.observe(content);
    report();
    return () => observer.disconnect();
  }, []);

  const getChannelByIndex = (index: number) =>
    routingState?.channels.find(ch => ch.hardwareIndex === index);

  // First assigned app's icon for a channel
  const getChannelIcon = (index: number): string | null => {
    const channel = getChannelByIndex(index);
    if (!channel || !routingState) return null;
    if (channel.assignment.type !== 'apps') return null;
    for (const bundleID of channel.assignment.bundleIDs) {
      const app = routingState.runningApps.find(a => a.bundleID === bundleID);
      if (app?.icon) return app.icon;
    }
    return null;
  };

  const dismissToast = useCallback(() => setCurrentToast(null), []);

  // APPS section: every running app, including channel-assigned ones (their
  // slider works alongside the hardware). Daemons and helpers only appear
  // while audible or adjusted.
  const appRows = (routingState?.runningApps ?? []).filter(a =>
    a.isRegularApp || a.isAudible || a.volume < 1 || a.muted || a.isAssigned
  );

  // Hardware label (K1...S4) per assigned bundle ID, for the row tag
  const channelTagByBundleID: Record<string, string> = {};
  if (routingState) {
    for (const ch of routingState.channels) {
      if (ch.assignment.type !== 'apps') continue;
      const label = ch.hardwareIndex < 5
        ? `K${ch.hardwareIndex + 1}`
        : `S${ch.hardwareIndex - 4}`;
      for (const bundleID of ch.assignment.bundleIDs) {
        channelTagByBundleID[bundleID] = label;
      }
    }
  }

  // Data for the app picker overlay
  const pickerChannel = pickerChannelId
    ? routingState?.channels.find(ch => ch.id === pickerChannelId)
    : undefined;
  const assignedElsewhere: Record<string, string> = {};
  let otherAppsHolder: string | null = null;
  if (routingState && pickerChannel) {
    for (const ch of routingState.channels) {
      if (ch.id === pickerChannel.id) continue;
      if (ch.assignment.type === 'apps') {
        for (const bundleID of ch.assignment.bundleIDs) {
          assignedElsewhere[bundleID] = ch.channelName;
        }
      } else if (ch.assignment.type === 'other-apps') {
        otherAppsHolder = ch.channelName;
      }
    }
  }

  const renderRows = (labels: string[], offset: number) => (
    <div className="row-group">
      {labels.map((label, i) => {
        const index = offset + i;
        const channel = getChannelByIndex(index);
        return (
          <ChannelRow
            key={label}
            hardwareLabel={label}
            channel={channel}
            value={channel ? Math.round(channel.volume * 255) : analogValues[index]}
            level={channel ? audioLevels[channel.id] : undefined}
            icon={getChannelIcon(index)}
            onAssignClick={handleAssignClick}
            onMuteToggle={handleMuteToggle}
            onLabelChange={handleLabelChange}
          />
        );
      })}
    </div>
  );

  return (
    <>
      <Toast toast={currentToast} onDismiss={dismissToast} />

      <div className="panel">
        <header className="titlebar">
          <div className="titlebar-side left">
            <span className={`status-dot ${connected ? 'connected' : ''}`} title={statusMessage} />
            <span className="titlebar-title">PC Panel</span>
          </div>

          <div className="titlebar-center">
            <button
              className="output-select"
              disabled={!routingState}
              onClick={() => setOutputMenuOpen(open => !open)}
              title="System output device"
            >
              {routingState?.availableOutputs.find(o => o.isDefault)?.name.trim() ?? 'Output'}
            </button>

            {outputMenuOpen && routingState && (
              <>
                <div className="output-menu-backdrop" onClick={() => setOutputMenuOpen(false)} />
                <div className="output-menu">
                  {routingState.availableOutputs.map(device => (
                    <div
                      key={device.id}
                      className={`output-menu-item ${device.isDefault ? 'selected' : ''}`}
                      onClick={() => {
                        setOutputMenuOpen(false);
                        handleOutputDeviceChange(device.id);
                      }}
                    >
                      <span className="output-menu-check">{device.isDefault ? '✓' : ''}</span>
                      <span className="output-menu-name">{device.name.trim()}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="titlebar-side right">
            <button
              className={`titlebar-button ${view === 'channels' ? 'active' : ''}`}
              title={view === 'channels' ? 'Back to apps' : 'Hardware channels'}
              onClick={() => setView(v => (v === 'channels' ? 'apps' : 'channels'))}
            >
              <ChannelsIcon />
            </button>
            <button
              className={`titlebar-button ${view === 'lights' ? 'active' : ''}`}
              title={view === 'lights' ? 'Back to apps' : 'Lighting'}
              onClick={() => setView(v => (v === 'lights' ? 'apps' : 'lights'))}
            >
              <LightIcon />
            </button>
            <button className="titlebar-button" title="Reconnect device" onClick={handleReconnect}>
              <ReconnectIcon />
            </button>
          </div>
        </header>

        <main className="panel-body">
          <div className="panel-content" ref={contentRef}>
            {view === 'lights' && lighting ? (
              <LightsPage lighting={lighting} onChange={handleLightingChange} />
            ) : view === 'apps' ? (
              <>
                <div className="section-label">Apps</div>
                <div className="row-group">
                  {appRows.map(app => (
                    <AppRow
                      key={app.bundleID}
                      app={app}
                      level={audioLevels[`app:${app.bundleID}`]}
                      channelTag={channelTagByBundleID[app.bundleID]}
                      onVolumeChange={handleAppVolumeChange}
                      onMuteToggle={handleAppMuteToggle}
                    />
                  ))}
                  {appRows.length === 0 && (
                    <div className="empty-hint">No audio apps running</div>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="section-label">Knobs</div>
                {renderRows(KNOB_LABELS, 0)}

                <div className="section-divider" />

                <div className="section-label">Sliders</div>
                {renderRows(SLIDER_LABELS, 5)}

                <div className="section-divider" />

                <div className="section-label">Knob Buttons</div>
                <div className="row-group">
                  {KNOB_LABELS.map((label, i) => {
                    const action = routingState?.buttonActions?.[i] ?? { type: 'none' as const };
                    const value = action.type === 'switch-output'
                      ? `output:${action.deviceName}`
                      : action.type;
                    return (
                      <div className="lights-row" key={label}>
                        <span className={`row-icon-chip ${buttonStates[i] ? 'pressed' : ''}`}>{label}</span>
                        <span className="lights-row-name">Press {label}</span>
                        <select
                          className="button-action-select"
                          value={value}
                          onChange={(e) => handleButtonActionChange(i, e.target.value)}
                        >
                          <option value="none">Do nothing</option>
                          <option value="mute-channel">Toggle mute</option>
                          <option value="media-play-pause">Play / Pause media</option>
                          <option value="media-next">Next track</option>
                          <option value="media-previous">Previous track</option>
                          {routingState?.availableOutputs.map(device => (
                            <option key={device.id} value={`output:${device.name}`}>
                              Output → {device.name.trim()}
                            </option>
                          ))}
                          {action.type === 'switch-output' &&
                            !routingState?.availableOutputs.some(d => d.name === action.deviceName) && (
                            <option value={`output:${action.deviceName}`}>
                              Output → {action.deviceName.trim()} (not connected)
                            </option>
                          )}
                        </select>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </main>

        <footer className="panel-footer">
          <span className="footer-status">{connected ? 'Connected' : statusMessage}</span>
          <div className="footer-buttons">
            {buttonStates.map((pressed, i) => (
              <span key={i} className={`button-dot ${pressed ? 'pressed' : ''}`} title={`Button ${i + 1}`} />
            ))}
          </div>
          <button className="footer-quit" onClick={() => pcpanel.quitApp()}>Quit</button>
        </footer>
      </div>

      {pickerChannel && routingState && (
        <AppPicker
          channelName={pickerChannel.channelName}
          assignment={pickerChannel.assignment}
          runningApps={routingState.runningApps}
          assignedElsewhere={assignedElsewhere}
          otherAppsHolder={otherAppsHolder}
          onSave={(assignment) => handleAssignmentSave(pickerChannel.id, assignment)}
          onCancel={() => setPickerChannelId(null)}
        />
      )}
    </>
  );
}
