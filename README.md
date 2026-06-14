# PC Panel Pro — macOS Controller

A macOS menu bar app for per-app audio control with the PC Panel Pro hardware
mixer. Adjust any app's volume with your mouse or the hardware knobs/sliders,
switch the system output, and drive the panel's RGB lighting — all from a
drop-down panel in the menu bar. The interface is modeled on
[FineTune](https://github.com/ronitsingh10/FineTune); the implementation here
is original.

## Features

- **Per-app volume** — a live mixer listing every app currently playing audio,
  each with its own volume slider and mute, controlled by mouse.
- **Hardware control** — map the 5 knobs and 4 sliders to apps (or "all other
  apps"); the hardware and the on-screen sliders stay in sync.
- **System output switcher** — pick the macOS output device from the header, or
  bind a knob press to switch to a specific device.
- **Knob-button actions** — each knob press can toggle mute, switch output, or
  send media keys (play/pause, next, previous).
- **RGB lighting** — per-knob / per-slider colors, or whole-panel rainbow, wave,
  and breath animations.
- **Menu bar popover** — click the menu bar icon and the panel drops down; it
  dismisses on click-away or Escape. Runs as a background agent (no Dock icon).
- **No virtual devices, no kernel extension** — uses Apple's public Core Audio
  process-tap API (macOS 14.4+).

## How it works

Each controlled app gets its own Core Audio **process tap**. The tap captures
that app's audio, mutes the original stream at the system output, and replays
the samples through the real output device at the chosen volume — so apps need
no reconfiguration and are unaware anything changed. An app is tapped only while
it's actually being controlled (volume changed, muted, or assigned to a knob);
everything else plays normally, untouched.

A hardware **channel** (a knob or slider) is a group control: it writes its
position through to its assigned apps' volumes. The app volume is the single
source of truth, so the hardware position and the APPS slider always show the
same number. One channel can be set to **"all other apps"**, which taps
everything not individually controlled.

A background loop reconciles taps every ~2 seconds as apps launch and quit, and
the system default output is followed automatically, so audio moves with it.

The first time an app is controlled, macOS prompts for **System Audio
Recording** permission — this is required for process taps and must be granted.

## Requirements

- **macOS 14.4 or later** (the process-tap API) — required to both run and build
- **Apple Silicon** (the app is packaged for `arm64`)
- **PC Panel Pro** hardware
- For building: **Node.js 18+**, **npm**, and **Xcode Command Line Tools**
  (`xcode-select --install`)

## Build & install

```bash
git clone <repo-url>
cd pcpanel

npm install            # JS dependencies
npm run build:native   # compile the native audio addon
npm run pack           # build + package the .app into release/

cp -R "release/mac-arm64/PC Panel Pro.app" /Applications/
xattr -dr com.apple.quarantine "/Applications/PC Panel Pro.app"
rm -rf release         # avoid duplicate Launchpad/Spotlight entries
```

To run from source during development: `npm run start`.

The packaged app is a menu bar agent (`LSUIElement`) and carries the
`NSAudioCaptureUsageDescription` string for the permission prompt. Add it to
**System Settings → General → Login Items** to start at login.

> The app is **ad-hoc signed** (no Apple Developer ID). macOS re-prompts for
> System Audio Recording after each rebuild/reinstall, and a copy moved to
> another Mac will be quarantined by Gatekeeper until cleared. For
> friction-free distribution the app would need to be signed and notarized.

## Using the app

Click the menu bar icon to open the panel. The title bar has the connection
status, the **output device** switcher (center), and two page toggles on the
right: a sliders icon (hardware channels) and a lightbulb (lighting).

### Apps page (default)

Lists every app producing audio. Drag a row's slider to set that app's volume,
or click the speaker to mute. Rows show a live level meter, the app icon, and —
for apps mapped to a knob/slider — a small hardware tag (e.g. `K1`).

### Knobs & Sliders page (sliders icon)

The 5 knobs and 4 sliders as rows. For each:

- **Assign apps** — click the row to pick one or more apps, or "All other apps".
- **Rename** — hover the name and click the pencil.
- **Mute** — the speaker button.

Below them, **Knob Buttons** assigns an action to each knob's press (K1–K5):

- *Toggle mute* — mute/unmute that knob's channel
- *Play / Pause media*, *Next track*, *Previous track* — sent to the active
  Now Playing app (Spotify, YouTube in a browser, Music, …)
- *Output → \<device\>* — switch the macOS system output to that device

### Lights page (lightbulb icon)

Choose a mode: **Custom** (per-knob ring color, per-slider track + label colors
with an optional volume-tracking fill, and a logo color), or whole-panel
**Rainbow / Wave / Breath** animations with hue and speed. A global brightness
applies to all. Settings persist and are re-applied whenever the panel connects
(it boots dark until the app sends lighting).

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Build the Electron app (main + renderer) |
| `npm run build:native` | Compile the native audio addon |
| `npm run start` | Build and run from source |
| `npm run rebuild` | Rebuild native modules for the Electron ABI |
| `npm run pack` | Build everything and package the `.app` |
| `npm run dist` | Build a distributable `.dmg` / `.zip` |

## Project structure

```
pcpanel/
├── src/
│   ├── main/                       # Electron main process
│   │   ├── index.ts                # Tray popover, window, IPC, HID wiring
│   │   ├── preload.ts              # contextBridge IPC API
│   │   ├── lighting.ts             # RGB config + apply over HID
│   │   ├── audio/                  # routing.ts (taps), config.ts, types.ts
│   │   └── hid/                    # device scan, connection, protocol
│   └── renderer/                   # React UI
│       ├── App.tsx                 # Pages, title bar, output menu
│       ├── components/             # ChannelRow, AppRow, AppPicker,
│       │                           #   LightsPage, VUMeter, Toast
│       └── styles.css
├── native/                         # N-API addon (Objective-C++)
│   ├── binding.gyp
│   └── src/
│       ├── process_tap.mm          # per-app taps, output switch, media keys
│       └── audio_passthrough.mm    # device enumeration / legacy mixer
├── driver/                         # Legacy HAL plugin (unused; see below)
├── scripts/
├── package.json
└── tsconfig.json
```

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     PC Panel Pro hardware                      │
│                 (5 knobs, 4 sliders, 5 buttons)                │
└───────────────┬───────────────────────────────▲───────────────┘
        USB HID │ knob/slider/button events      │ lighting packets
┌───────────────▼───────────────────────────────┴───────────────┐
│                          Electron app                          │
│  • Apps mixer (mouse) + hardware channels (write-through)      │
│  • Reconciles per-app taps every ~2s; follows system output    │
│  • Knob buttons → mute / output switch / media keys            │
└───────────────┬────────────────────────────────────────────────┘
                │ Core Audio process-tap API
┌───────────────▼────────────────────────────────────────────────┐
│                  One process tap per controlled app             │
│  • Captures the app's audio, mutes its original output          │
│  • Applies volume, plays to the system output device            │
│  • Peak/RMS measured for the UI meters                          │
│  • "All other apps" = one exclusive tap of everything else      │
└─────────────────────────────────────────────────────────────────┘
```

Settings persist to `~/Library/Application Support/pcpanelpro/`:
`audio-routing.json` (channel assignments, per-app volumes, knob-button
actions) and `lighting.json`.

## Troubleshooting

**An app's volume won't change.** Confirm **System Settings → Privacy &
Security → Screen & System Audio Recording → System Audio Recording** has "PC
Panel Pro" enabled. After a rebuild the permission may need re-granting.

**Media-key button does nothing.** macOS may require **Accessibility**
permission for synthesized key events — enable "PC Panel Pro" under
**Privacy & Security → Accessibility**.

**A bound output device "not found."** Devices are matched by name; the target
must be connected. Bluetooth outputs (e.g. AirPods) must already be connected to
the Mac — a button press can't wake them from the case.

**Hardware not detected.** Ensure the panel is connected by USB and not in use
by other PCPanel software, then unplug and reconnect; the app rescans every few
seconds.

**Build errors.** Ensure Xcode Command Line Tools are installed and you're on
macOS 14.4+ (the native addon needs the 14.4 SDK headers).

## Legacy virtual-device driver

Earlier versions used a HAL driver (`PCPanelAudio.driver`) that created virtual
output devices. It is no longer used. If it's still installed from an old
version, remove it:

```bash
sudo rm -rf /Library/Audio/Plug-Ins/HAL/PCPanelAudio.driver
sudo killall coreaudiod
```

The `driver/` sources and the `build:driver` / `install:driver` scripts remain
for reference only.

## Credits

- Originally based on [trezy/pcpanel](https://github.com/trezy/pcpanel) by
  Trezy — this project began as a fork of that macOS controller and was
  reworked into a per-app mixer.
- Hardware and original concept: [PCPanel](https://www.getpcpanel.com/)
- UI design inspiration: [FineTune](https://github.com/ronitsingh10/FineTune)
- Lighting/HID protocol reference: the community
  [PCPanel](https://github.com/nvdweem/PCPanel) software

## License

MIT — see [LICENSE](LICENSE). This project is a derivative of the
MIT-licensed [trezy/pcpanel](https://github.com/trezy/pcpanel) and preserves
its original copyright notice alongside changes made here.
