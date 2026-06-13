// Audio routing types for per-app volume control via Core Audio process taps

/**
 * What a channel's knob/slider controls:
 * - 'apps': one or more applications, identified by responsible bundle ID
 * - 'other-apps': everything not assigned to another channel (exclusive tap)
 * - 'none': channel is unassigned
 */
export type ChannelAssignment =
  | { type: 'apps'; bundleIDs: string[] }
  | { type: 'other-apps' }
  | { type: 'none' };

/**
 * Represents a single hardware channel (knob or slider)
 */
export interface InputChannel {
  /** Unique identifier: 'k1', 'k2', 'k3', 'k4', 'k5', 's1', 's2', 's3', 's4' */
  id: string;
  /** User-editable channel name: 'Discord', 'Music', 'Game', etc. */
  channelName: string;
  /** Hardware control index (0-8) mapping to physical knob/slider */
  hardwareIndex: number;
  /** Current volume level (0.0 - 1.0) */
  volume: number;
  /** Whether channel is muted */
  muted: boolean;
  /** What this channel controls */
  assignment: ChannelAssignment;
}

/**
 * Per-app volume override set from the UI (APPS section).
 * An app only gets its own tap while volume < 1 or muted.
 */
export interface AppVolume {
  volume: number;
  muted: boolean;
}

/**
 * What pressing a hardware knob button (K1-K5) does:
 * - 'mute-channel': toggle mute of the channel on the same knob
 * - 'switch-output': make the named device the system default output
 * - 'media-*': send the corresponding keyboard media key
 */
export type ButtonAction =
  | { type: 'none' }
  | { type: 'mute-channel' }
  | { type: 'switch-output'; deviceName: string }
  | { type: 'media-play-pause' }
  | { type: 'media-next' }
  | { type: 'media-previous' };

/**
 * Complete audio routing configuration (persisted to disk)
 */
export interface AudioRoutingConfig {
  /** All input channels */
  inputChannels: InputChannel[];
  /** Output device for tapped audio (null = follow system default) */
  outputDeviceId: number | null;
  /** UI-set per-app volumes, keyed by responsible bundle ID */
  appVolumes: Record<string, AppVolume>;
  /** Actions for the 5 knob press buttons */
  buttonActions: ButtonAction[];
}

/**
 * A running application that can be assigned to a channel.
 * Helper processes (browser GPU/renderer processes etc.) are grouped under
 * the responsible application.
 */
export interface RunningApp {
  /** Responsible application bundle ID (assignment key) */
  bundleID: string;
  /** Display name */
  name: string;
  /** All audio-capable pids belonging to this app */
  pids: number[];
  /** Whether the app is currently producing audio */
  isAudible: boolean;
  /** PNG data URL of the app icon, if available */
  icon: string | null;
  /** Whether this is a regular (Dock) application */
  isRegularApp: boolean;
  /** UI-set volume (1.0 when untouched) */
  volume: number;
  /** UI-set mute */
  muted: boolean;
  /** Whether this app is assigned to a hardware channel */
  isAssigned: boolean;
}

/**
 * Runtime state for a channel (includes activity info)
 */
export interface ChannelState extends InputChannel {
  /** Whether audio is currently flowing through this channel's tap */
  isActive: boolean;
  /** Display names of the apps this channel currently controls */
  apps: string[];
  /** Whether the tap for this channel is running */
  isRunning: boolean;
}

/**
 * Complete runtime state (sent to renderer)
 */
export interface AudioRoutingState {
  /** All channels with activity info */
  channels: ChannelState[];
  /** Apps currently known to the audio system */
  runningApps: RunningApp[];
  /** Available output devices for selection */
  availableOutputs: AudioOutputDevice[];
  /** Currently configured output (null = system default) */
  outputDeviceId: number | null;
  /** Actions for the 5 knob press buttons */
  buttonActions: ButtonAction[];
}

/**
 * Audio output device info
 */
export interface AudioOutputDevice {
  /** Core Audio device ID */
  id: number;
  /** Device name */
  name: string;
  /** Whether this is the system default */
  isDefault: boolean;
}

/**
 * Default channel IDs and hardware indices
 */
export const CHANNEL_DEFINITIONS: readonly { id: string; hardwareIndex: number }[] = [
  { id: 'k1', hardwareIndex: 0 },
  { id: 'k2', hardwareIndex: 1 },
  { id: 'k3', hardwareIndex: 2 },
  { id: 'k4', hardwareIndex: 3 },
  { id: 'k5', hardwareIndex: 4 },
  { id: 's1', hardwareIndex: 5 },
  { id: 's2', hardwareIndex: 6 },
  { id: 's3', hardwareIndex: 7 },
  { id: 's4', hardwareIndex: 8 },
] as const;

/**
 * Create default configuration
 */
export function createDefaultConfig(): AudioRoutingConfig {
  const inputChannels: InputChannel[] = CHANNEL_DEFINITIONS.map(def => ({
    id: def.id,
    channelName: def.id.toUpperCase(),
    hardwareIndex: def.hardwareIndex,
    volume: 1.0,
    muted: false,
    assignment: { type: 'none' },
  }));

  return {
    inputChannels,
    outputDeviceId: null,
    appVolumes: {},
    buttonActions: new Array(5).fill(null).map(() => ({ type: 'none' as const })),
  };
}
