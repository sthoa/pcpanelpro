export interface ChannelActivityInfo {
  isActive: boolean;
  apps: string[];
}

export interface AudioLevelInfo {
  peak: number;
  rms: number;
}

export interface DeviceState {
  connected: boolean;
  analogValues: number[];
  buttonStates: boolean[];
}

// Audio routing types (mirrored from main/audio/types.ts)
export interface AudioOutputDevice {
  id: number;
  name: string;
  isDefault: boolean;
}

export type ChannelAssignment =
  | { type: 'apps'; bundleIDs: string[] }
  | { type: 'other-apps' }
  | { type: 'none' };

export interface ChannelState {
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

export interface RunningApp {
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

export type ButtonAction =
  | { type: 'none' }
  | { type: 'mute-channel' }
  | { type: 'switch-output'; deviceName: string }
  | { type: 'media-play-pause' }
  | { type: 'media-next' }
  | { type: 'media-previous' };

export interface AudioRoutingState {
  channels: ChannelState[];
  runningApps: RunningApp[];
  availableOutputs: AudioOutputDevice[];
  outputDeviceId: number | null;
  buttonActions: ButtonAction[];
}

export interface KnobChangeEvent {
  type: 'knob-change';
  index: number;
  value: number;
}

export interface ButtonChangeEvent {
  type: 'button-change';
  index: number;
  pressed: boolean;
}

export interface StateResponseEvent {
  type: 'state-response';
  analogValues: number[];
  buttonStates: boolean[];
}

export type DeviceEvent = KnobChangeEvent | ButtonChangeEvent | StateResponseEvent;

export interface ToastData {
  type: 'success' | 'warning' | 'error' | 'info';
  message: string;
  duration?: number;
}

export type LightingMode = 'custom' | 'rainbow' | 'wave' | 'breath' | 'off';

export interface SliderLighting {
  color1: string;
  color2: string;
  volumeGradient: boolean;
}

export interface LightingConfig {
  mode: LightingMode;
  brightness: number;
  knobColors: string[];
  sliders: SliderLighting[];
  sliderLabelColors: string[];
  logoColor: string;
  animationHue: number;
  animationSpeed: number;
}

export interface PCPanelAPI {
  // Event listeners
  onDeviceStatus: (callback: (status: { connected: boolean; message: string }) => void) => void;
  onDeviceEvent: (callback: (event: DeviceEvent) => void) => void;
  onDeviceState: (callback: (state: DeviceState) => void) => void;
  onOutputDevice: (callback: (device: { name: string }) => void) => void;
  onChannelActivity: (callback: (activityInfo: Record<number, ChannelActivityInfo>) => void) => void;
  onAudioLevels: (callback: (levels: Record<string, AudioLevelInfo>) => void) => void;
  onToast: (callback: (toast: ToastData) => void) => void;

  // Device API
  getDeviceState: () => Promise<DeviceState>;
  getOutputDevice: () => Promise<{ name: string } | null>;
  getChannelActivity: () => Promise<Record<number, ChannelActivityInfo>>;
  reconnect: () => Promise<void>;

  // Audio routing API
  getAudioRouting: () => Promise<AudioRoutingState>;
  setChannelLabel: (channelId: string, label: string) => Promise<AudioRoutingState>;
  setChannelVolume: (channelId: string, volume: number) => Promise<boolean>;
  setChannelMuted: (channelId: string, muted: boolean) => Promise<boolean>;
  setChannelAssignment: (channelId: string, assignment: ChannelAssignment) => Promise<AudioRoutingState>;
  setOutputDevice: (deviceId: number | null) => Promise<boolean>;
  getRunningApps: () => Promise<RunningApp[]>;
  getAvailableOutputs: () => Promise<AudioOutputDevice[]>;
  setAppVolume: (bundleID: string, volume: number) => Promise<boolean>;
  setAppMuted: (bundleID: string, muted: boolean) => Promise<boolean>;
  reportContentHeight: (height: number) => void;
  setButtonAction: (buttonIndex: number, action: ButtonAction) => Promise<AudioRoutingState>;
  getLighting: () => Promise<LightingConfig>;
  setLighting: (config: Partial<LightingConfig>) => Promise<LightingConfig>;
  quitApp: () => Promise<void>;
}
