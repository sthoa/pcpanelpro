import { contextBridge, ipcRenderer } from 'electron';

// Types for audio routing state (matches main/audio/types.ts)
interface AudioOutputDevice {
  id: number;
  name: string;
  isDefault: boolean;
}

type ChannelAssignment =
  | { type: 'apps'; bundleIDs: string[] }
  | { type: 'other-apps' }
  | { type: 'none' };

interface ChannelState {
  id: string;
  channelName: string;
  hardwareIndex: number;
  volume: number;
  muted: boolean;
  assignment: ChannelAssignment;
  isActive: boolean;
  apps: string[];
  isRunning: boolean;
}

interface RunningApp {
  bundleID: string;
  name: string;
  pids: number[];
  isAudible: boolean;
  icon: string | null;
  isRegularApp: boolean;
  volume: number;
  muted: boolean;
  isAssigned: boolean;
}

interface AudioRoutingState {
  channels: ChannelState[];
  runningApps: RunningApp[];
  availableOutputs: AudioOutputDevice[];
  outputDeviceId: number | null;
}

contextBridge.exposeInMainWorld('pcpanel', {
  // Event listeners
  onDeviceStatus: (callback: (status: { connected: boolean; message: string }) => void) => {
    ipcRenderer.on('device-status', (_event, status) => callback(status));
  },
  onDeviceEvent: (callback: (event: unknown) => void) => {
    ipcRenderer.on('device-event', (_event, data) => callback(data));
  },
  onDeviceState: (callback: (state: unknown) => void) => {
    ipcRenderer.on('device-state', (_event, state) => callback(state));
  },
  onOutputDevice: (callback: (device: { name: string }) => void) => {
    ipcRenderer.on('output-device', (_event, device) => callback(device));
  },
  onChannelActivity: (callback: (activityInfo: Record<number, { isActive: boolean; apps: string[] }>) => void) => {
    ipcRenderer.on('channel-activity', (_event, info) => callback(info));
  },
  onAudioLevels: (callback: (levels: Record<string, { peak: number; rms: number }>) => void) => {
    ipcRenderer.on('audio-levels', (_event, levels) => callback(levels));
  },
  onToast: (callback: (toast: { type: 'success' | 'warning' | 'error' | 'info'; message: string; duration?: number }) => void) => {
    ipcRenderer.on('toast', (_event, toast) => callback(toast));
  },

  // Device API
  getDeviceState: () => ipcRenderer.invoke('get-device-state'),
  getOutputDevice: () => ipcRenderer.invoke('get-output-device'),
  getChannelActivity: () => ipcRenderer.invoke('get-channel-activity') as Promise<Record<number, { isActive: boolean; apps: string[] }>>,
  reconnect: () => ipcRenderer.invoke('reconnect-device'),

  // Audio routing API
  getAudioRouting: () => ipcRenderer.invoke('get-audio-routing') as Promise<AudioRoutingState>,
  setChannelLabel: (channelId: string, label: string) =>
    ipcRenderer.invoke('set-channel-label', channelId, label) as Promise<AudioRoutingState>,
  setChannelVolume: (channelId: string, volume: number) =>
    ipcRenderer.invoke('set-channel-volume', channelId, volume) as Promise<boolean>,
  setChannelMuted: (channelId: string, muted: boolean) =>
    ipcRenderer.invoke('set-channel-muted', channelId, muted) as Promise<boolean>,
  setChannelAssignment: (channelId: string, assignment: ChannelAssignment) =>
    ipcRenderer.invoke('set-channel-assignment', channelId, assignment) as Promise<AudioRoutingState>,
  setOutputDevice: (deviceId: number | null) =>
    ipcRenderer.invoke('set-output-device', deviceId) as Promise<boolean>,
  getRunningApps: () =>
    ipcRenderer.invoke('get-running-apps') as Promise<RunningApp[]>,
  getAvailableOutputs: () =>
    ipcRenderer.invoke('get-available-outputs') as Promise<AudioOutputDevice[]>,
  setAppVolume: (bundleID: string, volume: number) =>
    ipcRenderer.invoke('set-app-volume', bundleID, volume) as Promise<boolean>,
  setAppMuted: (bundleID: string, muted: boolean) =>
    ipcRenderer.invoke('set-app-muted', bundleID, muted) as Promise<boolean>,
  reportContentHeight: (height: number) => ipcRenderer.send('content-height', height),
  setButtonAction: (buttonIndex: number, action: unknown) =>
    ipcRenderer.invoke('set-button-action', buttonIndex, action),
  getLighting: () => ipcRenderer.invoke('get-lighting'),
  setLighting: (config: unknown) => ipcRenderer.invoke('set-lighting', config),
  quitApp: () => ipcRenderer.invoke('quit-app') as Promise<void>,
});
