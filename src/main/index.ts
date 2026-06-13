import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, nativeTheme, screen } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { scanForDevices, PCPanelConnection, DeviceState, DeviceEvent } from './hid';
import { audioRouting } from './audio/routing';
import { ChannelAssignment } from './audio/types';
import { lightingManager, LightingConfig } from './lighting';

let mainWindow: BrowserWindow | null = null;
let connection: PCPanelConnection | null = null;
let scanInterval: NodeJS.Timeout | null = null;
let activityInterval: NodeJS.Timeout | null = null;
let levelsInterval: NodeJS.Timeout | null = null;
let tray: Tray | null = null;
let isQuitting = false;

// Request single instance lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running - quit immediately
  app.quit();
} else {
  // This is the primary instance - handle second-instance event
  app.on('second-instance', () => {
    // Someone tried to run a second instance, show our popover instead
    showPopover();
  });
}

// Safe logging that won't crash on EPIPE
function log(...args: unknown[]): void {
  try {
    console.log(...args);
  } catch {
    // Ignore write errors
  }
}

function logError(...args: unknown[]): void {
  try {
    console.error(...args);
  } catch {
    // Ignore write errors
  }
}

function createTray(): void {
  // Mixer-sliders glyph; createFromPath picks up the @2x file for retina
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  const trayIcon = nativeImage.createFromPath(iconPath);
  trayIcon.setTemplateImage(true); // Makes icon adapt to dark/light mode on macOS

  tray = new Tray(trayIcon);
  tray.setToolTip('PC Panel Pro');

  // Left-click toggles the popover; right-click shows the menu
  tray.on('click', () => {
    togglePopover();
  });

  tray.on('right-click', () => {
    tray?.popUpContextMenu(Menu.buildFromTemplate([
      {
        label: 'Quit PC Panel Pro',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]));
  });
}

// Popovers hide on blur; clicking the tray icon while open first blurs the
// window, so without this timestamp the click would immediately re-open it
let lastBlurHide = 0;
let fadeTimer: NodeJS.Timeout | null = null;

function cancelFade(): void {
  if (fadeTimer) {
    clearInterval(fadeTimer);
    fadeTimer = null;
  }
}

function showPopover(): void {
  if (!mainWindow) {
    createWindow();
  }
  if (!mainWindow) return;

  cancelFade();
  mainWindow.setOpacity(1);

  // Anchor flush below the menu bar, left-aligned with the tray icon like a
  // native menu; right-align instead when that would clip the screen edge
  if (tray) {
    const trayBounds = tray.getBounds();
    const [width] = mainWindow.getSize();
    const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
    const workArea = display.workArea;

    let x = Math.round(trayBounds.x - 2);
    if (x + width > workArea.x + workArea.width - 2) {
      x = Math.round(trayBounds.x + trayBounds.width - width + 2);
    }
    x = Math.max(x, workArea.x + 2);
    const y = Math.round(trayBounds.y + trayBounds.height);

    mainWindow.setPosition(x, y, false);
  }

  // Appears instantly, like a native menu
  mainWindow.show();
  mainWindow.focus();
}

function hidePopover(): void {
  if (!mainWindow || !mainWindow.isVisible() || fadeTimer) return;

  // Native-menu dismiss: fade out over 300ms with ease-in-out
  const duration = 300;
  const start = Date.now();
  fadeTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      cancelFade();
      return;
    }
    const t = Math.min(1, (Date.now() - start) / duration);
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    mainWindow.setOpacity(1 - eased);
    if (t >= 1) {
      cancelFade();
      mainWindow.hide();
      mainWindow.setOpacity(1);
    }
  }, 16);
}

function togglePopover(): void {
  if (Date.now() - lastBlurHide < 300) {
    // The click that blurred (and started hiding) the popover landed on the
    // tray icon — treat it as "close", not "reopen"
    hidePopover();
  } else if (mainWindow?.isVisible() && !fadeTimer) {
    hidePopover();
  } else {
    showPopover();
  }
}

function createWindow(): void {
  // The renderer palette is dark-only; keep the vibrancy material dark too
  nativeTheme.themeSource = 'dark';

  mainWindow = new BrowserWindow({
    width: 510,
    height: 560,
    useContentSize: true,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    transparent: true,
    vibrancy: 'popover',
    visualEffectState: 'active',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Behave like a menu bar popover: float above other windows, follow the
  // active Space, and dismiss when focus is lost or Escape is pressed
  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.on('blur', () => {
    if (!isQuitting) {
      lastBlurHide = Date.now();
      hidePopover();
    }
  });

  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      hidePopover();
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Dev aid: PCPANEL_SCREENSHOT=/path.png captures the window after load
  const screenshotPath = process.env.PCPANEL_SCREENSHOT;
  if (screenshotPath) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow?.show();
      setTimeout(async () => {
        try {
          const image = await mainWindow!.webContents.capturePage();
          fs.writeFileSync(screenshotPath, image.toPNG());
          log('Screenshot saved to', screenshotPath);
        } catch (err) {
          logError('Screenshot failed:', err);
        }
      }, 9000);
    });
  }

  // Hide window instead of closing (keep app running in tray)
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function sendToRenderer(channel: string, data: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

async function connectToDevice(): Promise<void> {
  // If already connected, don't try again
  if (connection?.isConnected()) {
    return;
  }

  const devices = await scanForDevices();

  if (devices.length === 0) {
    sendToRenderer('device-status', { connected: false, message: 'No PC Panel found' });
    return;
  }

  const device = devices[0];

  // Log device info
  if (device.isKnown) {
    log(`Found ${device.profile.name}:`, device.path);
  } else if (device.isPotentialPCPanel) {
    log(`Found potential PCPanel device (unknown model):`, device);
    // Notify user about unknown device
    sendToRenderer('toast', {
      type: 'info',
      message: `Unknown PCPanel detected (VID:${device.vendorId.toString(16)} PID:${device.productId.toString(16)}). Please report this!`,
      duration: 5000
    });
  }

  // Close any existing connection first and give OS time to release device
  if (connection) {
    connection.disconnect();
    connection = null;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  connection = new PCPanelConnection();

  connection.on('connected', () => {
    log(`Connected to ${device.profile.name}`);
    sendToRenderer('device-status', { connected: true, message: `Connected to ${device.profile.name}` });
    lightingManager.attach(connection!);

    // Request current device state to initialize volumes
    setTimeout(() => {
      if (connection) {
        log('Requesting device state...');
        connection.requestState();
      }
    }, 100);

    // Restore the configured lighting (the panel boots dark)
    setTimeout(() => {
      lightingManager.apply();
    }, 300);
  });

  connection.on('disconnected', () => {
    log(`Disconnected from ${device.profile.name}`);
    sendToRenderer('device-status', { connected: false, message: 'Disconnected' });
  });

  connection.on('event', (event: DeviceEvent) => {
    sendToRenderer('device-event', event);

    // Update volume when knob or slider changes
    if (event.type === 'knob-change') {
      audioRouting.handleHardwareChange(event.index, event.value);
    } else if (event.type === 'button-change' && event.pressed) {
      const message = audioRouting.handleButtonPress(event.index);
      if (message) {
        sendToRenderer('toast', { type: 'info', message, duration: 2000 });
      }
    } else if (event.type === 'state-response') {
      // Apply all initial volume values from device state
      log('Received device state, applying initial volumes');
      for (let i = 0; i < event.analogValues.length; i++) {
        audioRouting.handleHardwareChange(i, event.analogValues[i]);
      }
    }
  });

  connection.on('state', (state: DeviceState) => {
    sendToRenderer('device-state', state);
  });

  connection.on('error', (error: Error) => {
    logError('Device error:', error);
    sendToRenderer('device-status', { connected: false, message: `Error: ${error.message}` });
  });

  const success = connection.connect(device.path);
  if (!success) {
    sendToRenderer('device-status', { connected: false, message: 'Failed to connect' });
  }
}

function startDeviceScanning(): void {
  // Initial scan
  connectToDevice();

  // Periodic scan for device connection/disconnection
  scanInterval = setInterval(async () => {
    if (!connection || !connection.isConnected()) {
      await connectToDevice();
    }
  }, 3000);
}

app.whenReady().then(async () => {
  createTray();
  createWindow();

  startDeviceScanning();

  // Start audio routing (per-app process taps)
  setTimeout(() => {
    log('Starting audio routing...');
    audioRouting.initialize();
    log('Audio routing started');

    // Start polling for channel activity
    activityInterval = setInterval(() => {
      const activityInfo = audioRouting.getChannelActivityInfo();
      sendToRenderer('channel-activity', activityInfo);
    }, 500); // Poll every 500ms

    // Start polling for audio levels (faster for smooth meters)
    levelsInterval = setInterval(() => {
      const levels = audioRouting.getAudioLevels();
      sendToRenderer('audio-levels', levels);
    }, 50); // Poll every 50ms for smooth metering
  }, 500);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Handle app quit - intercept Cmd+Q to hide to tray instead of quitting
app.on('before-quit', (event) => {
  // If not intentionally quitting (e.g., from tray menu), hide to tray instead
  if (!isQuitting) {
    event.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
  }
});

app.on('window-all-closed', () => {
  // On macOS with tray, don't quit when windows are closed
  // The app continues running in the background
  if (process.platform !== 'darwin') {
    cleanup();
    app.quit();
  }
});

function cleanup(): void {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
  if (activityInterval) {
    clearInterval(activityInterval);
    activityInterval = null;
  }
  if (levelsInterval) {
    clearInterval(levelsInterval);
    levelsInterval = null;
  }
  if (connection) {
    connection.disconnect();
    connection = null;
  }
  // Stop all audio routing
  audioRouting.shutdown();

  if (tray) {
    tray.destroy();
    tray = null;
  }
}

app.on('will-quit', () => {
  cleanup();
});

// IPC handlers
ipcMain.handle('get-device-state', () => {
  return connection?.getState() ?? {
    connected: false,
    analogValues: new Array(9).fill(0),
    buttonStates: new Array(5).fill(false),
  };
});

ipcMain.handle('reconnect-device', async () => {
  await connectToDevice();
});

ipcMain.handle('get-output-device', () => {
  const state = audioRouting.getState();
  if (state.outputDeviceId !== null) {
    const output = state.availableOutputs.find(o => o.id === state.outputDeviceId);
    if (output) return output;
  }
  // Return default output
  return state.availableOutputs.find(o => o.isDefault) || state.availableOutputs[0] || null;
});

ipcMain.handle('get-channel-activity', () => {
  return audioRouting.getChannelActivityInfo();
});

// Audio routing IPC handlers
ipcMain.handle('get-audio-routing', () => {
  const state = audioRouting.getState();
  log(`get-audio-routing: ${state.channels.length} channels, ${state.runningApps.length} apps`);
  return state;
});

ipcMain.handle('set-channel-label', (_event, channelId: string, label: string) => {
  audioRouting.setChannelLabel(channelId, label);
  return audioRouting.getState();
});

ipcMain.handle('set-channel-volume', (_event, channelId: string, volume: number) => {
  audioRouting.setChannelVolume(channelId, volume);
  return true;
});

ipcMain.handle('set-channel-muted', (_event, channelId: string, muted: boolean) => {
  audioRouting.setChannelMuted(channelId, muted);
  return true;
});

ipcMain.handle('set-channel-assignment', (_event, channelId: string, assignment: ChannelAssignment) => {
  audioRouting.setChannelAssignment(channelId, assignment);
  return audioRouting.getState();
});

ipcMain.handle('set-output-device', (_event, deviceId: number | null) => {
  if (deviceId === null) {
    audioRouting.setOutputDevice(null);
    return true;
  }
  // The header dropdown switches the actual system default output
  return audioRouting.switchSystemOutput(deviceId);
});

ipcMain.handle('get-running-apps', () => {
  return audioRouting.getState().runningApps;
});

ipcMain.handle('set-app-volume', (_event, bundleID: string, volume: number) => {
  audioRouting.setAppVolume(bundleID, volume);
  return true;
});

ipcMain.handle('set-app-muted', (_event, bundleID: string, muted: boolean) => {
  audioRouting.setAppMuted(bundleID, muted);
  return true;
});

ipcMain.handle('set-button-action', (_event, buttonIndex: number, action: import('./audio/types').ButtonAction) => {
  audioRouting.setButtonAction(buttonIndex, action);
  return audioRouting.getState();
});

ipcMain.handle('get-lighting', () => {
  return lightingManager.getConfig();
});

ipcMain.handle('set-lighting', (_event, config: Partial<LightingConfig>) => {
  lightingManager.setConfig(config);
  return lightingManager.getConfig();
});

ipcMain.handle('quit-app', () => {
  isQuitting = true;
  app.quit();
});

// The renderer reports its natural content height (via ResizeObserver) so
// the popover hugs its content as the app list grows and shrinks
ipcMain.on('content-height', (_event, height: number) => {
  if (typeof height !== 'number' || height < 200 || height > 2000) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const clamped = Math.min(Math.ceil(height), 660);
  const [, currentHeight] = mainWindow.getContentSize();
  if (clamped === currentHeight) return;
  // Transparent frameless windows ignore resizes while resizable=false
  mainWindow.setResizable(true);
  mainWindow.setContentSize(510, clamped);
  mainWindow.setResizable(false);
});

ipcMain.handle('get-available-outputs', () => {
  return audioRouting.getAvailableOutputDevices();
});
