# PC Panel Pro - macOS Controller

A macOS application for controlling per-app audio volume using the PC Panel Pro hardware mixer — like the official Windows app or SoundSource.

## Features

- **Per-App Volume Control**: Assign any running app (or "all other apps") to a knob or slider; the hardware then controls that app's volume directly
- **Core Audio Process Taps**: Uses the public tapping API (macOS 14.4+) — no kernel extensions, no virtual devices, no changing app output devices
- **Real-time Volume Control**: Hardware knob/slider movements instantly adjust the assigned apps' volume
- **Audio Activity Detection**: Per-channel level meters and activity indicators
- **Menu Bar Agent**: Runs in the background with a menu bar icon
- **React UI**: Interface for assigning apps, renaming channels, and monitoring levels

## How it works

Each channel creates a Core Audio **process tap** over the assigned apps' audio. The tap mutes those apps at the system output and delivers their samples to the app, which replays them through the real output device at the knob-controlled gain. Apps don't need to be reconfigured and are unaware anything changed.

The first time a channel is assigned, macOS asks for **System Audio Recording** permission — this is required for process taps and must be granted.

## Prerequisites

- macOS 14.4 or later (process tap API)
- Node.js 18+ and npm
- Xcode Command Line Tools (`xcode-select --install`)
- PC Panel Pro hardware device

## Quick Start

```bash
# Clone the repository
git clone <repo-url>
cd pcpanel

# Install npm dependencies
npm install

# Build the native addon
npm run build:native

# Build and run the app
npm run start
```

## Install as an app

```bash
npm run pack
cp -R "release/mac-arm64/PC Panel Pro.app" /Applications/
xattr -dr com.apple.quarantine "/Applications/PC Panel Pro.app"
rm -rf release   # avoid duplicate Launchpad/Spotlight entries
```

The packaged app is already a menu bar agent (`LSUIElement`) and carries the
`NSAudioCaptureUsageDescription` required for the permission prompt. Add it to
**System Settings → General → Login Items** to start at login.

Note: the app is ad-hoc signed, so macOS re-asks for System Audio Recording
(and input monitoring) permission after each rebuild/reinstall.

## Usage

1. **Assign Apps to Channels**: Click "Assign apps…" under a knob/slider and pick one or more running apps. One channel can also be set to "All other apps".
2. **Control Volume**: Turn the corresponding knob or move the slider on your PC Panel Pro hardware.
3. **Monitor Activity**: The app shows live level meters per channel.
4. **Rename Channels**: Click a channel name to rename it.

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Build the Electron app |
| `npm run start` | Build and run the app |
| `npm run build:native` | Rebuild the native audio addon |
| `npm run rebuild` | Rebuild native modules for Electron |
| `npm run pack` | Build everything and package the .app |
| `npm run dist` | Package distributable dmg/zip |

## Project Structure

```
pcpanel/
├── src/
│   ├── main/                 # Electron main process
│   │   ├── index.ts          # App entry point, window management, tray
│   │   ├── preload.ts        # IPC bridge for renderer
│   │   ├── audio/            # Per-app routing (taps, config, types)
│   │   └── hid/              # USB HID communication
│   └── renderer/             # React UI
│       ├── App.tsx           # Main React component
│       ├── components/       # UI components (Knob, Slider, AppPicker, ...)
│       └── styles.css        # Styling
├── native/                   # Node.js native addon (N-API)
│   ├── binding.gyp           # Build configuration
│   └── src/
│       ├── audio_passthrough.mm  # Device passthrough/mixer (legacy)
│       └── process_tap.mm        # Per-app process taps (macOS 14.4+)
├── driver/                   # Legacy Core Audio HAL plugin (no longer used)
├── scripts/                  # Build/setup scripts
├── package.json
└── tsconfig.json
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    PC Panel Pro Hardware                     │
│                 (5 knobs, 4 sliders, 5 buttons)              │
└─────────────────────────────┬───────────────────────────────┘
                              │ USB HID
┌─────────────────────────────▼───────────────────────────────┐
│                      Electron App                            │
│  • Reads knob/slider positions via HID                       │
│  • Maps each channel to assigned apps (by bundle ID)         │
│  • Reconciles taps as apps launch/quit every 2s              │
└─────────────────────────────┬───────────────────────────────┘
                              │ CoreAudio process tap API
┌─────────────────────────────▼───────────────────────────────┐
│            One process tap + aggregate per channel           │
│  • Tap captures assigned apps' audio and mutes the original  │
│  • IOProc applies knob gain and plays to the output device   │
│  • Peak/RMS measured for UI meters                           │
└─────────────────────────────────────────────────────────────┘
```

## Legacy virtual-device driver

Earlier versions used a HAL driver (`PCPanelAudio.driver`) that created 9
virtual output devices. It is no longer needed. If it's still installed,
remove it with:

```bash
sudo rm -rf /Library/Audio/Plug-Ins/HAL/PCPanelAudio.driver
sudo killall coreaudiod
```

The `driver/` sources and `npm run build:driver` / `npm run install:driver`
scripts remain in the repo for reference only.

## Troubleshooting

### Channels don't affect app volume

1. Check System Audio Recording permission: **System Settings → Privacy & Security → Screen & System Audio Recording → System Audio Recording** — "PC Panel Pro" must be enabled
2. Re-open the assignment picker and confirm the app is still assigned (assignments follow the app's bundle ID)
3. Some apps split audio across helper processes; the app groups them by responsible process, but a relaunch of the target app will be picked up within ~2 seconds

### App can't connect to hardware

1. Ensure PC Panel Pro is connected via USB
2. Check if another app is using the device
3. Try unplugging and reconnecting the device

### Build errors

1. Ensure Xcode Command Line Tools are installed: `xcode-select --install`
2. Native addon requires the macOS 14.4 SDK or newer

## License

MIT
