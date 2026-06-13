// Audio routing manager for per-app volume control.
// Each channel owns a Core Audio process tap (macOS 14.4+) that captures the
// assigned apps' audio (muting them at the system output) and replays it
// through the real output device at the hardware-controlled volume.

import * as path from 'path';
import { app } from 'electron';
import {
  AudioRoutingConfig,
  AudioRoutingState,
  AudioOutputDevice,
  ChannelAssignment,
  ChannelState,
  RunningApp,
} from './types';
import { ButtonAction } from './types';
import {
  loadConfig,
  saveConfig,
  updateButtonAction,
  updateChannelLabel,
  updateChannelVolume,
  updateChannelMuted,
  updateChannelAssignment,
  updateOutputDevice,
  updateAppVolume,
} from './config';

/**
 * Get the path to the native audio addon.
 * Works in both development and packaged modes.
 */
function getNativeModulePath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'native', 'pcpanel_audio.node');
  } else {
    return path.join(__dirname, '../../../native/build/Release/pcpanel_audio.node');
  }
}

// Load the native addon
// eslint-disable-next-line @typescript-eslint/no-var-requires
const audioAddon = require(getNativeModulePath());

interface NativeAudioDevice {
  id: number;
  name: string;
  hasOutput: boolean;
  hasInput: boolean;
}

interface NativeProcess {
  pid: number;
  bundleID: string;
  name: string;
  responsiblePid: number;
  responsibleBundleID: string;
  responsibleName: string;
  isRunningOutput: boolean;
  isSelf: boolean;
  isRegularApp: boolean;
}

/** Tap id used for UI-adjusted apps (vs hardware channel ids like 'k1') */
function appTapId(bundleID: string): string {
  return `app:${bundleID}`;
}

interface NativeTapStatus {
  running: boolean;
  exclusive: boolean;
  gain: number;
  muted: boolean;
  peak: number;
  rms: number;
  active: boolean;
  pids: number[];
  outputDeviceId: number;
}

const RECONCILE_INTERVAL_MS = 2000;

function sortedPids(pids: number[]): number[] {
  return [...pids].sort((a, b) => a - b);
}

function pidsEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * AudioRoutingManager - manages per-app process taps
 */
class AudioRoutingManager {
  private config: AudioRoutingConfig;
  private isInitialized = false;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconcileInterval: ReturnType<typeof setInterval> | null = null;
  private runningApps: RunningApp[] = [];
  private selfPids: number[] = [];
  private iconCache: Map<string, string | null> = new Map();
  private lastStatus: Record<string, NativeTapStatus> = {};

  constructor() {
    this.config = loadConfig();
  }

  /**
   * Initialize the audio routing system and start the reconcile loop that
   * keeps taps in sync with running processes and the output device.
   */
  initialize(): void {
    if (this.isInitialized) {
      console.log('AudioRoutingManager already initialized');
      return;
    }

    console.log('Initializing AudioRoutingManager (process taps)...');
    this.reconcile();
    this.reconcileInterval = setInterval(() => this.reconcile(), RECONCILE_INTERVAL_MS);
    this.isInitialized = true;
  }

  /**
   * Shutdown the audio routing system
   */
  shutdown(): void {
    if (!this.isInitialized) return;

    console.log('Shutting down AudioRoutingManager...');

    if (this.reconcileInterval) {
      clearInterval(this.reconcileInterval);
      this.reconcileInterval = null;
    }

    try {
      audioAddon.tapStopAll();
    } catch (err) {
      console.error('Failed to stop taps:', err);
    }

    this.saveConfigNow();
    this.isInitialized = false;
    console.log('AudioRoutingManager shutdown complete');
  }

  // ============================================================
  // Reconcile loop
  // ============================================================

  /**
   * Refresh the process list and (re)build taps so that each channel taps
   * exactly the pids of its assigned apps. Called periodically and after
   * any assignment/output change.
   */
  private reconcile(): void {
    let processes: NativeProcess[] = [];
    try {
      processes = audioAddon.tapListProcesses() || [];
    } catch (err) {
      console.error('Failed to list audio processes:', err);
      return;
    }

    this.selfPids = processes.filter(p => p.isSelf).map(p => p.pid);

    // Bundle IDs assigned to hardware channels
    const assignedBundleIDs = new Set<string>();
    for (const channel of this.config.inputChannels) {
      if (channel.assignment.type === 'apps') {
        for (const bundleID of channel.assignment.bundleIDs) {
          assignedBundleIDs.add(bundleID);
        }
      }
    }

    this.runningApps = this.groupApps(processes, assignedBundleIDs);

    const outputDeviceId = this.resolveOutputDeviceId();

    let status: Record<string, NativeTapStatus> = {};
    try {
      status = audioAddon.tapGetStatus() || {};
    } catch (err) {
      console.error('Failed to get tap status:', err);
    }

    // Every controlled app gets its own tap ('app:<bundleID>'), whether it's
    // adjusted from the APPS section, assigned to a hardware channel, or both.
    // A hardware channel acts as a group multiplier over its member taps.
    const appTapPids = new Set<number>();
    const desiredAppTaps = new Map<string, number[]>();
    for (const app of this.runningApps) {
      if (app.pids.length === 0) continue;
      const override = this.config.appVolumes[app.bundleID];
      if (!override && !app.isAssigned) continue;
      desiredAppTaps.set(appTapId(app.bundleID), sortedPids(app.pids));
      for (const pid of app.pids) {
        appTapPids.add(pid);
      }
    }

    // Drop app taps whose app quit or no longer needs control
    for (const tapId of Object.keys(status)) {
      if (tapId.startsWith('app:') && !desiredAppTaps.has(tapId)) {
        try {
          audioAddon.tapDestroyChannel(tapId);
        } catch (err) {
          console.error(`Failed to destroy app tap ${tapId}:`, err);
        }
      }
    }

    for (const [tapId, pids] of desiredAppTaps) {
      const st: NativeTapStatus | undefined = status[tapId];
      const bundleID = tapId.slice(4);

      const outputChanged = st !== undefined && outputDeviceId !== null &&
        st.outputDeviceId !== outputDeviceId;
      const pidsChanged = st === undefined || !st.running || st.exclusive ||
        !pidsEqual(sortedPids(st.pids), pids);

      try {
        if (pidsChanged || outputChanged) {
          const ok = audioAddon.tapCreateChannel(tapId, pids, false, outputDeviceId ?? undefined);
          if (!ok) {
            console.warn(`Failed to create app tap ${tapId}`);
            continue;
          }
          console.log(`App tap ${tapId} rebuilt (${pids.length} pids)`);
        }
        audioAddon.tapSetGain(tapId, this.effectiveAppGain(bundleID));
        audioAddon.tapSetMuted(tapId, this.effectiveAppMuted(bundleID));
      } catch (err) {
        console.error(`Failed to rebuild app tap ${tapId}:`, err);
      }
    }

    for (const channel of this.config.inputChannels) {
      const st: NativeTapStatus | undefined = status[channel.id];

      if (channel.assignment.type !== 'other-apps') {
        // 'apps' channels no longer own a tap — their members do
        if (st) {
          try {
            audioAddon.tapDestroyChannel(channel.id);
          } catch (err) {
            console.error(`Failed to destroy tap for ${channel.id}:`, err);
          }
        }
        continue;
      }

      // Exclusive tap: captures everything except individually tapped apps
      // (channel-assigned or UI-adjusted) and ourselves
      const desired = sortedPids([...appTapPids, ...this.selfPids]);

      const outputChanged = st !== undefined && outputDeviceId !== null &&
        st.outputDeviceId !== outputDeviceId;
      const pidsChanged = st === undefined || !st.running || !st.exclusive ||
        !pidsEqual(sortedPids(st.pids), desired);

      if (pidsChanged || outputChanged) {
        try {
          const ok = audioAddon.tapCreateChannel(channel.id, desired, true,
            outputDeviceId ?? undefined);
          if (ok) {
            audioAddon.tapSetGain(channel.id, channel.volume);
            audioAddon.tapSetMuted(channel.id, channel.muted);
            console.log(`Tap ${channel.id} rebuilt (other-apps, ` +
              `${desired.length} excluded pids, output ${outputDeviceId ?? 'default'})`);
          } else {
            console.warn(`Failed to create tap for ${channel.id}`);
          }
        } catch (err) {
          console.error(`Failed to rebuild tap for ${channel.id}:`, err);
        }
      }
    }

    try {
      this.lastStatus = audioAddon.tapGetStatus() || {};
    } catch {
      this.lastStatus = {};
    }
  }

  /**
   * Group raw audio processes into user-recognizable apps keyed by
   * responsible bundle ID.
   */
  private groupApps(processes: NativeProcess[], assignedBundleIDs: Set<string>): RunningApp[] {
    const groups = new Map<string, RunningApp>();

    for (const proc of processes) {
      if (proc.isSelf) continue;
      const key = proc.responsibleBundleID || proc.bundleID || proc.responsibleName || proc.name;
      if (!key) continue;

      let group = groups.get(key);
      if (!group) {
        if (!this.iconCache.has(key)) {
          let icon: string | null = null;
          try {
            icon = audioAddon.tapGetAppIcon(proc.responsiblePid) ?? null;
          } catch {
            icon = null;
          }
          this.iconCache.set(key, icon);
        }
        const override = this.config.appVolumes[key];
        group = {
          bundleID: key,
          name: proc.responsibleName || proc.name || key,
          pids: [],
          isAudible: false,
          icon: this.iconCache.get(key) ?? null,
          isRegularApp: false,
          volume: override?.volume ?? 1,
          muted: override?.muted ?? false,
          isAssigned: assignedBundleIDs.has(key),
        };
        groups.set(key, group);
      }

      group.pids.push(proc.pid);
      if (proc.isRunningOutput) {
        group.isAudible = true;
      }
      if (proc.isRegularApp) {
        group.isRegularApp = true;
      }
    }

    return [...groups.values()].sort((a, b) => {
      if (a.isAudible !== b.isAudible) return a.isAudible ? -1 : 1;
      if ((a.icon !== null) !== (b.icon !== null)) return a.icon !== null ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * The hardware channel an app belongs to, if any
   */
  private channelForBundleID(bundleID: string) {
    return this.config.inputChannels.find(ch =>
      ch.assignment.type === 'apps' && ch.assignment.bundleIDs.includes(bundleID)
    );
  }

  /**
   * An app's tap gain. The app volume is the single source of truth: a
   * hardware knob writes through to its member apps' volumes, so the knob
   * and the APPS slider always show the same value.
   */
  private effectiveAppGain(bundleID: string): number {
    const appVolume = this.config.appVolumes[bundleID]?.volume ?? 1;
    return Math.max(0, Math.min(1, appVolume));
  }

  private effectiveAppMuted(bundleID: string): boolean {
    return this.config.appVolumes[bundleID]?.muted ?? false;
  }

  /**
   * Push gain/mute to all member taps of a channel
   */
  private applyChannelToMembers(channelId: string): void {
    const channel = this.config.inputChannels.find(c => c.id === channelId);
    if (!channel) return;

    if (channel.assignment.type === 'other-apps') {
      try {
        audioAddon.tapSetGain(channel.id, channel.muted ? 0 : channel.volume);
        audioAddon.tapSetMuted(channel.id, channel.muted);
      } catch {
        // Tap may not exist yet
      }
      return;
    }

    if (channel.assignment.type !== 'apps') return;
    for (const bundleID of channel.assignment.bundleIDs) {
      try {
        audioAddon.tapSetGain(appTapId(bundleID), this.effectiveAppGain(bundleID));
        audioAddon.tapSetMuted(appTapId(bundleID), this.effectiveAppMuted(bundleID));
      } catch {
        // App may not be running
      }
    }
  }

  /**
   * The concrete device taps should play to (resolves system default).
   */
  private resolveOutputDeviceId(): number | null {
    if (this.config.outputDeviceId !== null) {
      return this.config.outputDeviceId;
    }
    try {
      const defaultDevice = audioAddon.getDefaultOutputDevice();
      return defaultDevice ? defaultDevice.id : null;
    } catch {
      return null;
    }
  }

  // ============================================================
  // Public API
  // ============================================================

  /**
   * List all audio devices on the system
   */
  listDevices(): NativeAudioDevice[] {
    return audioAddon.listAudioDevices() || [];
  }

  /**
   * Get available output devices for selection
   */
  getAvailableOutputDevices(): AudioOutputDevice[] {
    const devices = this.listDevices();
    const defaultOutput = audioAddon.getDefaultOutputDevice();

    return devices
      .filter((d: NativeAudioDevice) => d.hasOutput && !d.name.startsWith('PCPanel'))
      .map((d: NativeAudioDevice) => ({
        id: d.id,
        name: d.name,
        isDefault: defaultOutput && d.id === defaultOutput.id,
      }));
  }

  /**
   * Set channel volume (0.0 - 1.0). For app channels the hardware writes
   * through to every member app's volume (absolute, not scaling).
   */
  setChannelVolume(channelId: string, volume: number): void {
    const channel = this.config.inputChannels.find(c => c.id === channelId);
    if (!channel) {
      console.error(`Channel not found: ${channelId}`);
      return;
    }

    this.config = updateChannelVolume(this.config, channelId, volume);
    if (channel.assignment.type === 'apps') {
      for (const bundleID of channel.assignment.bundleIDs) {
        this.config = updateAppVolume(this.config, bundleID, { volume });
      }
    }
    this.scheduleSave();
    this.applyChannelToMembers(channelId);
  }

  /**
   * Set channel volume from hardware value (0-255)
   */
  setChannelVolumeFromHardware(channelId: string, hardwareValue: number): void {
    this.setChannelVolume(channelId, hardwareValue / 255);
  }

  /**
   * Handle hardware control change (knob/slider)
   */
  handleHardwareChange(hardwareIndex: number, value: number): void {
    const channel = this.config.inputChannels.find(c => c.hardwareIndex === hardwareIndex);
    if (!channel) {
      console.warn(`No channel for hardware index ${hardwareIndex}`);
      return;
    }
    this.setChannelVolumeFromHardware(channel.id, value);
  }

  /**
   * Set channel muted state
   */
  setChannelMuted(channelId: string, muted: boolean): void {
    const channel = this.config.inputChannels.find(c => c.id === channelId);
    if (!channel) {
      console.error(`Channel not found: ${channelId}`);
      return;
    }

    this.config = updateChannelMuted(this.config, channelId, muted);
    if (channel.assignment.type === 'apps') {
      for (const bundleID of channel.assignment.bundleIDs) {
        this.config = updateAppVolume(this.config, bundleID, { muted });
      }
    }
    this.scheduleSave();
    this.applyChannelToMembers(channelId);
  }

  /**
   * Set channel display label
   */
  setChannelLabel(channelId: string, label: string): void {
    this.config = updateChannelLabel(this.config, channelId, label);
    this.scheduleSave();
  }

  /**
   * Assign apps (or 'other-apps' / nothing) to a channel and rebuild taps.
   */
  setChannelAssignment(channelId: string, assignment: ChannelAssignment): void {
    const channel = this.config.inputChannels.find(c => c.id === channelId);
    if (!channel) {
      console.error(`Channel not found: ${channelId}`);
      return;
    }

    this.config = updateChannelAssignment(this.config, channelId, assignment);
    this.scheduleSave();
    this.reconcile();
  }

  /**
   * Set a UI-controlled per-app volume (APPS section). Unassigned apps get a
   * tap on first adjustment and lose it when back at full volume unmuted;
   * channel-assigned apps always have a tap, and the channel volume scales
   * the value set here.
   */
  setAppVolume(bundleID: string, volume: number): void {
    this.config = updateAppVolume(this.config, bundleID, { volume });

    // Keep a single-app channel's volume in lockstep with its app
    const channel = this.channelForBundleID(bundleID);
    if (channel && channel.assignment.type === 'apps' && channel.assignment.bundleIDs.length === 1) {
      this.config = updateChannelVolume(this.config, channel.id, volume);
    }
    this.scheduleSave();

    const needsTap = !!this.config.appVolumes[bundleID] || !!this.channelForBundleID(bundleID);
    if (needsTap) {
      let applied = false;
      try {
        applied = audioAddon.tapSetGain(appTapId(bundleID), this.effectiveAppGain(bundleID));
      } catch {
        applied = false;
      }
      if (!applied) {
        this.reconcile();  // tap doesn't exist yet
      }
    } else {
      this.reconcile();  // back to 100% — tear the tap down
    }
  }

  /**
   * Mute/unmute an app from the APPS section
   */
  setAppMuted(bundleID: string, muted: boolean): void {
    this.config = updateAppVolume(this.config, bundleID, { muted });

    const channel = this.channelForBundleID(bundleID);
    if (channel && channel.assignment.type === 'apps' && channel.assignment.bundleIDs.length === 1) {
      this.config = updateChannelMuted(this.config, channel.id, muted);
    }
    this.scheduleSave();

    const needsTap = !!this.config.appVolumes[bundleID] || !!this.channelForBundleID(bundleID);
    if (needsTap) {
      let applied = false;
      try {
        applied = audioAddon.tapSetMuted(appTapId(bundleID), this.effectiveAppMuted(bundleID));
      } catch {
        applied = false;
      }
      if (!applied) {
        this.reconcile();
      }
    } else {
      this.reconcile();
    }
  }

  /**
   * Set the output device tapped audio plays to (null = system default)
   */
  setOutputDevice(deviceId: number | null): void {
    this.config = updateOutputDevice(this.config, deviceId);
    this.scheduleSave();
    this.reconcile();
  }

  /**
   * Switch the macOS system default output (like the menu bar sound picker).
   * Tapped audio follows the default, so everything moves together.
   */
  switchSystemOutput(deviceId: number): boolean {
    let ok = false;
    try {
      ok = audioAddon.setDefaultOutputDevice(deviceId);
    } catch (err) {
      console.error('Failed to set default output:', err);
    }
    if (!ok) return false;

    if (this.config.outputDeviceId !== null) {
      this.config = updateOutputDevice(this.config, null);
      this.scheduleSave();
    }
    this.reconcile();
    return true;
  }

  /**
   * Assign an action to a knob press button (index 0-4)
   */
  setButtonAction(buttonIndex: number, action: ButtonAction): void {
    if (buttonIndex < 0 || buttonIndex > 4) return;
    this.config = updateButtonAction(this.config, buttonIndex, action);
    this.scheduleSave();
  }

  getButtonActions(): ButtonAction[] {
    return this.config.buttonActions;
  }

  /**
   * Handle a knob press (button down). Returns a user-facing message for
   * toast feedback, or null when nothing happened.
   */
  handleButtonPress(buttonIndex: number): string | null {
    const action = this.config.buttonActions[buttonIndex];
    if (!action || action.type === 'none') return null;

    if (action.type === 'mute-channel') {
      const channel = this.config.inputChannels.find(c => c.hardwareIndex === buttonIndex);
      if (!channel) return null;
      const muted = !channel.muted;
      this.setChannelMuted(channel.id, muted);
      return `${channel.channelName} ${muted ? 'muted' : 'unmuted'}`;
    }

    if (action.type === 'media-play-pause' || action.type === 'media-next' ||
        action.type === 'media-previous') {
      const mediaKey = action.type === 'media-next' ? 1
        : action.type === 'media-previous' ? 2 : 0;
      try {
        audioAddon.sendMediaKey(mediaKey);
      } catch (err) {
        console.error('Failed to send media key:', err);
        return null;
      }
      return action.type === 'media-play-pause' ? 'Play/Pause'
        : action.type === 'media-next' ? 'Next track' : 'Previous track';
    }

    // switch-output: resolve the stored device name against current devices
    const device = this.listDevices().find(
      (d: NativeAudioDevice) => d.hasOutput && d.name === action.deviceName
    );
    if (!device) {
      return `Output "${action.deviceName.trim()}" not found`;
    }

    let ok = false;
    try {
      ok = audioAddon.setDefaultOutputDevice(device.id);
    } catch (err) {
      console.error('Failed to set default output:', err);
    }
    if (!ok) {
      return `Could not switch to ${device.name.trim()}`;
    }

    // Follow the system default so tapped audio moves with it
    if (this.config.outputDeviceId !== null) {
      this.config = updateOutputDevice(this.config, null);
      this.scheduleSave();
    }
    this.reconcile();
    return `Output: ${device.name.trim()}`;
  }

  /**
   * Get complete routing state for UI
   */
  getState(): AudioRoutingState {
    const appsByBundleID = new Map(this.runningApps.map(a => [a.bundleID, a]));

    const channels: ChannelState[] = this.config.inputChannels.map(channel => {
      const st = this.lastStatus[channel.id];

      let apps: string[] = [];
      if (channel.assignment.type === 'apps') {
        apps = channel.assignment.bundleIDs.map(
          b => appsByBundleID.get(b)?.name ?? b
        );
      } else if (channel.assignment.type === 'other-apps') {
        apps = ['All other apps'];
      }

      const agg = this.aggregateChannelStatus(channel, st);

      return {
        ...channel,
        isActive: agg.isActive,
        apps,
        isRunning: agg.isRunning,
      };
    });

    return {
      channels,
      runningApps: this.runningApps,
      availableOutputs: this.getAvailableOutputDevices(),
      outputDeviceId: this.config.outputDeviceId,
      buttonActions: this.config.buttonActions,
    };
  }

  /**
   * Get current configuration
   */
  getConfig(): AudioRoutingConfig {
    return this.config;
  }

  /**
   * Get channel activity info keyed by hardware index (for the UI poll)
   */
  getChannelActivityInfo(): Record<number, { isActive: boolean; apps: string[] }> {
    try {
      this.lastStatus = audioAddon.tapGetStatus() || {};
    } catch {
      // Keep previous status
    }

    const result: Record<number, { isActive: boolean; apps: string[] }> = {};
    const appsByBundleID = new Map(this.runningApps.map(a => [a.bundleID, a]));

    for (const channel of this.config.inputChannels) {
      const st = this.lastStatus[channel.id];
      let apps: string[] = [];
      if (channel.assignment.type === 'apps') {
        apps = channel.assignment.bundleIDs.map(b => appsByBundleID.get(b)?.name ?? b);
      } else if (channel.assignment.type === 'other-apps') {
        apps = ['All other apps'];
      }
      result[channel.hardwareIndex] = {
        isActive: this.aggregateChannelStatus(channel, st).isActive,
        apps,
      };
    }

    return result;
  }

  /**
   * Activity/running state for a channel: 'other-apps' channels own a tap;
   * 'apps' channels aggregate their member apps' taps
   */
  private aggregateChannelStatus(
    channel: { assignment: ChannelAssignment },
    ownStatus: NativeTapStatus | undefined
  ): { isActive: boolean; isRunning: boolean } {
    if (channel.assignment.type !== 'apps') {
      return {
        isActive: ownStatus?.active ?? false,
        isRunning: ownStatus?.running ?? false,
      };
    }
    let isActive = false;
    let isRunning = false;
    for (const bundleID of channel.assignment.bundleIDs) {
      const st = this.lastStatus[appTapId(bundleID)];
      if (st?.active) isActive = true;
      if (st?.running) isRunning = true;
    }
    return { isActive, isRunning };
  }

  /**
   * Get audio levels for all channels
   * Returns { channelId: { peak, rms } }
   */
  getAudioLevels(): Record<string, { peak: number; rms: number }> {
    const result: Record<string, { peak: number; rms: number }> = {};

    let status: Record<string, NativeTapStatus> = {};
    try {
      status = audioAddon.tapGetStatus() || {};
    } catch {
      return result;
    }

    for (const channel of this.config.inputChannels) {
      if (channel.assignment.type === 'apps') {
        // Channel meter = loudest member app tap
        let peak = 0;
        let rms = 0;
        for (const bundleID of channel.assignment.bundleIDs) {
          const st = status[appTapId(bundleID)];
          if (st) {
            peak = Math.max(peak, st.peak);
            rms = Math.max(rms, st.rms);
          }
        }
        result[channel.id] = { peak, rms };
      } else {
        const st = status[channel.id];
        if (st) {
          result[channel.id] = { peak: st.peak, rms: st.rms };
        }
      }
    }

    // Per-app taps report under their tap id ('app:<bundleID>')
    for (const [id, st] of Object.entries(status)) {
      if (id.startsWith('app:')) {
        result[id] = { peak: st.peak, rms: st.rms };
      }
    }

    return result;
  }

  // ============================================================
  // Persistence
  // ============================================================

  /**
   * Schedule a config save (debounced)
   */
  private scheduleSave(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      this.saveConfigNow();
    }, 1000);
  }

  /**
   * Save config immediately
   */
  private saveConfigNow(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    saveConfig(this.config);
  }
}

export const audioRouting = new AudioRoutingManager();
