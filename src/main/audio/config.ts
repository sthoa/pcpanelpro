// Configuration persistence for audio routing

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import {
  AppVolume,
  AudioRoutingConfig,
  ButtonAction,
  ChannelAssignment,
  createDefaultConfig,
} from './types';

const CONFIG_FILENAME = 'audio-routing.json';

/**
 * Get the configuration file path
 */
function getConfigPath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, CONFIG_FILENAME);
}

/**
 * Load audio routing configuration from disk
 * Returns default config if file doesn't exist or is invalid
 */
export function loadConfig(): AudioRoutingConfig {
  const configPath = getConfigPath();

  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(data);

      // Validate and merge with defaults to ensure all required fields exist
      return mergeWithDefaults(parsed);
    }
  } catch (err) {
    console.error('Failed to load audio routing config:', err);
  }

  return createDefaultConfig();
}

/**
 * Save audio routing configuration to disk
 */
export function saveConfig(config: AudioRoutingConfig): boolean {
  const configPath = getConfigPath();

  try {
    // Ensure directory exists
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Failed to save audio routing config:', err);
    return false;
  }
}

function isValidAssignment(value: unknown): value is ChannelAssignment {
  if (!value || typeof value !== 'object') return false;
  const a = value as { type?: unknown; bundleIDs?: unknown };
  if (a.type === 'none' || a.type === 'other-apps') return true;
  return a.type === 'apps' && Array.isArray(a.bundleIDs) &&
    a.bundleIDs.every(b => typeof b === 'string');
}

/**
 * Merge loaded config with defaults to handle schema changes.
 * Also migrates configs from the old virtual-device format (which had
 * deviceName/mixBuses/hardwareMapping fields): user labels, volumes, and
 * mute states are preserved; device assignments are reset to 'none'.
 */
function mergeWithDefaults(loaded: Record<string, unknown>): AudioRoutingConfig {
  const defaults = createDefaultConfig();

  const loadedChannels = Array.isArray(loaded.inputChannels)
    ? (loaded.inputChannels as Record<string, unknown>[])
    : [];

  const inputChannels = defaults.inputChannels.map(defaultChannel => {
    const loadedChannel = loadedChannels.find(c => c.id === defaultChannel.id);
    if (!loadedChannel) return defaultChannel;
    return {
      ...defaultChannel,
      channelName: typeof loadedChannel.channelName === 'string'
        ? loadedChannel.channelName : defaultChannel.channelName,
      volume: typeof loadedChannel.volume === 'number'
        ? Math.max(0, Math.min(1, loadedChannel.volume)) : defaultChannel.volume,
      muted: typeof loadedChannel.muted === 'boolean'
        ? loadedChannel.muted : defaultChannel.muted,
      assignment: isValidAssignment(loadedChannel.assignment)
        ? loadedChannel.assignment : defaultChannel.assignment,
    };
  });

  // Prefer the new top-level field; fall back to the legacy personal mix output
  let outputDeviceId: number | null = null;
  if (typeof loaded.outputDeviceId === 'number') {
    outputDeviceId = loaded.outputDeviceId;
  } else if (Array.isArray(loaded.mixBuses)) {
    const personal = (loaded.mixBuses as Record<string, unknown>[]).find(b => b.id === 'personal');
    if (personal && typeof personal.outputDeviceId === 'number') {
      outputDeviceId = personal.outputDeviceId;
    }
  }

  const appVolumes: Record<string, AppVolume> = {};
  if (loaded.appVolumes && typeof loaded.appVolumes === 'object') {
    for (const [bundleID, value] of Object.entries(loaded.appVolumes as Record<string, unknown>)) {
      const v = value as { volume?: unknown; muted?: unknown };
      if (typeof v?.volume === 'number') {
        appVolumes[bundleID] = {
          volume: Math.max(0, Math.min(1, v.volume)),
          muted: v.muted === true,
        };
      }
    }
  }

  const isValidButtonAction = (v: unknown): v is ButtonAction => {
    if (!v || typeof v !== 'object') return false;
    const a = v as { type?: unknown; deviceName?: unknown };
    if (a.type === 'none' || a.type === 'mute-channel' ||
        a.type === 'media-play-pause' || a.type === 'media-next' ||
        a.type === 'media-previous') return true;
    return a.type === 'switch-output' && typeof a.deviceName === 'string';
  };

  const buttonActions = defaults.buttonActions.map((d, i) => {
    const loadedAction = Array.isArray(loaded.buttonActions) ? loaded.buttonActions[i] : undefined;
    return isValidButtonAction(loadedAction) ? loadedAction : d;
  });

  return {
    inputChannels,
    outputDeviceId,
    appVolumes,
    buttonActions,
  };
}

/**
 * Update the action of one knob press button
 */
export function updateButtonAction(
  config: AudioRoutingConfig,
  buttonIndex: number,
  action: ButtonAction
): AudioRoutingConfig {
  return {
    ...config,
    buttonActions: config.buttonActions.map((a, i) => i === buttonIndex ? action : a),
  };
}

/**
 * Update a single channel's name
 */
export function updateChannelLabel(
  config: AudioRoutingConfig,
  channelId: string,
  channelName: string
): AudioRoutingConfig {
  return {
    ...config,
    inputChannels: config.inputChannels.map(channel =>
      channel.id === channelId
        ? { ...channel, channelName }
        : channel
    ),
  };
}

/**
 * Update a channel's volume
 */
export function updateChannelVolume(
  config: AudioRoutingConfig,
  channelId: string,
  volume: number
): AudioRoutingConfig {
  const clampedVolume = Math.max(0, Math.min(1, volume));
  return {
    ...config,
    inputChannels: config.inputChannels.map(channel =>
      channel.id === channelId
        ? { ...channel, volume: clampedVolume }
        : channel
    ),
  };
}

/**
 * Update a channel's mute state
 */
export function updateChannelMuted(
  config: AudioRoutingConfig,
  channelId: string,
  muted: boolean
): AudioRoutingConfig {
  return {
    ...config,
    inputChannels: config.inputChannels.map(channel =>
      channel.id === channelId
        ? { ...channel, muted }
        : channel
    ),
  };
}

/**
 * Update a channel's assignment. Keeps assignments exclusive:
 * a bundle ID assigned here is removed from all other channels, and at most
 * one channel can hold the 'other-apps' assignment.
 */
export function updateChannelAssignment(
  config: AudioRoutingConfig,
  channelId: string,
  assignment: ChannelAssignment
): AudioRoutingConfig {
  const assignedBundleIDs = new Set(
    assignment.type === 'apps' ? assignment.bundleIDs : []
  );

  return {
    ...config,
    inputChannels: config.inputChannels.map(channel => {
      if (channel.id === channelId) {
        return { ...channel, assignment };
      }

      // Steal 'other-apps' from any other channel that held it
      if (assignment.type === 'other-apps' && channel.assignment.type === 'other-apps') {
        return { ...channel, assignment: { type: 'none' as const } };
      }

      // Steal any bundle IDs now claimed by the target channel
      if (assignedBundleIDs.size > 0 && channel.assignment.type === 'apps') {
        const remaining = channel.assignment.bundleIDs.filter(b => !assignedBundleIDs.has(b));
        if (remaining.length !== channel.assignment.bundleIDs.length) {
          return {
            ...channel,
            assignment: remaining.length > 0
              ? { type: 'apps' as const, bundleIDs: remaining }
              : { type: 'none' as const },
          };
        }
      }

      return channel;
    }),
  };
}

/**
 * Update the output device for tapped audio
 */
export function updateOutputDevice(
  config: AudioRoutingConfig,
  outputDeviceId: number | null
): AudioRoutingConfig {
  return { ...config, outputDeviceId };
}

/**
 * Update a UI-set per-app volume. Entries at full volume and unmuted are
 * dropped so the config only holds real overrides.
 */
export function updateAppVolume(
  config: AudioRoutingConfig,
  bundleID: string,
  patch: Partial<AppVolume>
): AudioRoutingConfig {
  const current = config.appVolumes[bundleID] ?? { volume: 1, muted: false };
  const next: AppVolume = {
    volume: Math.max(0, Math.min(1, patch.volume ?? current.volume)),
    muted: patch.muted ?? current.muted,
  };

  const appVolumes = { ...config.appVolumes };
  if (next.volume >= 1 && !next.muted) {
    delete appVolumes[bundleID];
  } else {
    appVolumes[bundleID] = next;
  }

  return { ...config, appVolumes };
}
