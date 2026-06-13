// PC Panel USB HID Protocol Constants

// ============================================================================
// Device Registry
// ============================================================================

export interface DeviceProfile {
  vendorId: number;
  productId: number;
  name: string;
  analogCount: number;  // Total knobs + sliders
  knobCount: number;    // Number of rotary knobs
  sliderCount: number;  // Number of sliders
  buttonCount: number;
}

// Known PCPanel vendor ID (STMicroelectronics)
export const PCPANEL_VENDOR_ID = 0x0483;

// Known device profiles - add new devices here as they're discovered
export const KNOWN_DEVICES: DeviceProfile[] = [
  {
    vendorId: 0x0483,
    productId: 0xa3c5,
    name: 'PC Panel Pro',
    analogCount: 9,
    knobCount: 5,
    sliderCount: 4,
    buttonCount: 5,
  },
  // PC Panel Mini - uncomment and adjust when verified:
  // {
  //   vendorId: 0x0483,
  //   productId: 0x????,  // Need to discover this
  //   name: 'PC Panel Mini',
  //   analogCount: 4,
  //   knobCount: 4,
  //   sliderCount: 0,
  //   buttonCount: 4,
  // },
];

// Heuristic patterns for detecting unknown PCPanel devices
export const DETECTION_HINTS = {
  vendorIds: [0x0483], // STMicroelectronics - known PCPanel manufacturer
  productPatterns: [/pcpanel/i, /panel/i],
  manufacturerPatterns: [/pcpanel/i, /stmicroelectronics/i],
};

// Default profile for unknown devices (conservative - assumes Pro-sized device)
export const UNKNOWN_DEVICE_PROFILE: Omit<DeviceProfile, 'vendorId' | 'productId' | 'name'> = {
  analogCount: 9,
  knobCount: 5,
  sliderCount: 4,
  buttonCount: 5,
};

// ============================================================================
// Legacy exports for backward compatibility
// ============================================================================

// Primary device (PC Panel Pro) - kept for compatibility
export const VENDOR_ID = KNOWN_DEVICES[0].vendorId;
export const PRODUCT_ID = KNOWN_DEVICES[0].productId;
export const ANALOG_COUNT = KNOWN_DEVICES[0].analogCount;
export const BUTTON_COUNT = KNOWN_DEVICES[0].buttonCount;

// ============================================================================
// Protocol Constants
// ============================================================================

// Input message codes (device -> computer)
export const INPUT_CODE_KNOB_CHANGE = 0x01;
export const INPUT_CODE_BUTTON_CHANGE = 0x02;
export const INPUT_CODE_STATE_RESPONSE = 0x03;

// Output message codes (computer -> device)
export const OUTPUT_CODE_REQUEST_STATE = 0x01;

// Packet size
export const PACKET_SIZE = 64;

// ============================================================================
// Event Types
// ============================================================================

export interface KnobChangeEvent {
  type: 'knob-change';
  index: number; // 0-N
  value: number; // 0-255
}

export interface ButtonChangeEvent {
  type: 'button-change';
  index: number; // 0-N
  pressed: boolean;
}

export interface StateResponseEvent {
  type: 'state-response';
  analogValues: number[]; // N values, 0-255
  buttonStates: boolean[]; // M buttons
}

export type DeviceEvent = KnobChangeEvent | ButtonChangeEvent | StateResponseEvent;

// ============================================================================
// Packet Parsing
// ============================================================================

export function parseInputPacket(data: Buffer, profile?: DeviceProfile): DeviceEvent | null {
  if (data.length < 3) {
    return null;
  }

  const messageType = data[0];
  const index = data[1];
  const value = data[2];

  // Use provided profile or default to Pro settings
  const analogCount = profile?.analogCount ?? ANALOG_COUNT;
  const buttonCount = profile?.buttonCount ?? BUTTON_COUNT;

  switch (messageType) {
    case INPUT_CODE_KNOB_CHANGE:
      return {
        type: 'knob-change',
        index,
        value,
      };
    case INPUT_CODE_BUTTON_CHANGE:
      return {
        type: 'button-change',
        index,
        pressed: value === 0x01,
      };
    case INPUT_CODE_STATE_RESPONSE:
      // Full state response: analog values + button states
      if (data.length >= 1 + analogCount + buttonCount) {
        const analogValues: number[] = [];
        const buttonStates: boolean[] = [];

        for (let i = 0; i < analogCount; i++) {
          analogValues.push(data[1 + i]);
        }
        for (let i = 0; i < buttonCount; i++) {
          buttonStates.push(data[1 + analogCount + i] === 0x01);
        }

        return {
          type: 'state-response',
          analogValues,
          buttonStates,
        };
      }
      return null;
    default:
      return null;
  }
}

export function createStateRequestPacket(): Buffer {
  const packet = Buffer.alloc(PACKET_SIZE);
  packet[0] = OUTPUT_CODE_REQUEST_STATE;
  return packet;
}

// ============================================================================
// Device Profile Lookup
// ============================================================================

export function findDeviceProfile(vendorId: number, productId: number): DeviceProfile | null {
  return KNOWN_DEVICES.find(
    d => d.vendorId === vendorId && d.productId === productId
  ) ?? null;
}

export function getDeviceProfileOrDefault(vendorId: number, productId: number, name?: string): DeviceProfile {
  const known = findDeviceProfile(vendorId, productId);
  if (known) return known;

  // Return default profile for unknown device
  return {
    vendorId,
    productId,
    name: name ?? `Unknown PCPanel (${vendorId.toString(16)}:${productId.toString(16)})`,
    ...UNKNOWN_DEVICE_PROFILE,
  };
}

// ============================================================================
// Lighting (PC Panel Pro)
// ============================================================================
//
// 64-byte zero-padded output packets. Global brightness (0-100) is baked in
// by scaling every color component. Custom packets carry one 7-byte block per
// control: a mode byte followed by one or two RGB triples.

export const LIGHT_PREFIX_PRO = 0x05;

export const LIGHT_TARGET_SLIDER = 0x00;
export const LIGHT_TARGET_SLIDER_LABEL = 0x01;
export const LIGHT_TARGET_KNOB = 0x02;
export const LIGHT_TARGET_LOGO = 0x03;
export const LIGHT_TARGET_ANIMATION = 0x04;

const ANIM_RAINBOW_HORIZONTAL = 0x01;
const ANIM_WAVE = 0x03;
const ANIM_BREATH = 0x04;
const ANIM_STATIC_ALL = 0x02;

function parseHexColor(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

function scaled(value: number, brightness: number): number {
  return Math.max(0, Math.min(255, Math.round((brightness / 100) * value)));
}

function writeColor(packet: Buffer, offset: number, hex: string, brightness: number): void {
  const [r, g, b] = parseHexColor(hex);
  packet[offset] = scaled(r, brightness);
  packet[offset + 1] = scaled(g, brightness);
  packet[offset + 2] = scaled(b, brightness);
}

// The hardware has no per-LED brightness register — "brightness" is just RGB
// scaling. So per-control brightness is applied by scaling that control's
// color. Callers pass an effective brightness per control (already combining
// the global brightness with the per-control value).

/** Static color per knob ring; null leaves a knob dark */
export function createKnobLightingPacket(brightnesses: number[], colors: (string | null)[]): Buffer {
  const packet = Buffer.alloc(PACKET_SIZE);
  packet[0] = LIGHT_PREFIX_PRO;
  packet[1] = LIGHT_TARGET_KNOB;
  colors.forEach((color, i) => {
    if (!color) return;
    const offset = 2 + i * 7;
    packet[offset] = 0x01;  // static
    writeColor(packet, offset + 1, color, brightnesses[i] ?? 100);
  });
  return packet;
}

/** Slider LED tracks: a gradient from bottom to top color (same color = solid) */
export function createSliderLightingPacket(
  brightnesses: number[],
  sliders: ({ color1: string; color2: string; volumeGradient: boolean } | null)[]
): Buffer {
  const packet = Buffer.alloc(PACKET_SIZE);
  packet[0] = LIGHT_PREFIX_PRO;
  packet[1] = LIGHT_TARGET_SLIDER;
  sliders.forEach((slider, i) => {
    if (!slider) return;
    const offset = 2 + i * 7;
    const b = brightnesses[i] ?? 100;
    packet[offset] = slider.volumeGradient ? 0x03 : 0x01;
    writeColor(packet, offset + 1, slider.color1, b);
    writeColor(packet, offset + 4, slider.color2, b);
  });
  return packet;
}

/** Static color per slider label */
export function createSliderLabelLightingPacket(brightnesses: number[], colors: (string | null)[]): Buffer {
  const packet = Buffer.alloc(PACKET_SIZE);
  packet[0] = LIGHT_PREFIX_PRO;
  packet[1] = LIGHT_TARGET_SLIDER_LABEL;
  colors.forEach((color, i) => {
    if (!color) return;
    const offset = 2 + i * 7;
    packet[offset] = 0x01;  // static
    writeColor(packet, offset + 1, color, brightnesses[i] ?? 100);
  });
  return packet;
}

/** Static logo color */
export function createLogoLightingPacket(brightness: number, color: string | null): Buffer {
  const packet = Buffer.alloc(PACKET_SIZE);
  packet[0] = LIGHT_PREFIX_PRO;
  packet[1] = LIGHT_TARGET_LOGO;
  if (color) {
    packet[2] = 0x01;  // static
    writeColor(packet, 3, color, brightness);
  }
  return packet;
}

/** Whole-panel single color (also used with black for "off") */
export function createStaticAllPacket(brightness: number, color: string): Buffer {
  const packet = Buffer.alloc(PACKET_SIZE);
  packet[0] = LIGHT_PREFIX_PRO;
  packet[1] = LIGHT_TARGET_ANIMATION;
  packet[2] = ANIM_STATIC_ALL;
  writeColor(packet, 3, color, brightness);
  return packet;
}

/** Whole-panel rainbow animation */
export function createRainbowPacket(brightness: number, speed: number): Buffer {
  const packet = Buffer.alloc(PACKET_SIZE);
  packet[0] = LIGHT_PREFIX_PRO;
  packet[1] = LIGHT_TARGET_ANIMATION;
  packet[2] = ANIM_RAINBOW_HORIZONTAL;
  packet[3] = 0;     // phase shift
  packet[4] = 0xff;  // saturation
  packet[5] = scaled(255, brightness);
  packet[6] = speed & 0xff;
  packet[7] = 0;     // reverse
  return packet;
}

/** Whole-panel wave animation in a hue (0-255) */
export function createWavePacket(brightness: number, hue: number, speed: number): Buffer {
  const packet = Buffer.alloc(PACKET_SIZE);
  packet[0] = LIGHT_PREFIX_PRO;
  packet[1] = LIGHT_TARGET_ANIMATION;
  packet[2] = ANIM_WAVE;
  packet[3] = hue & 0xff;
  packet[4] = 0xff;  // saturation
  packet[5] = scaled(255, brightness);
  packet[6] = speed & 0xff;
  packet[7] = 0;     // reverse
  packet[8] = 0;     // bounce
  return packet;
}

/** Whole-panel breathing animation in a hue (0-255) */
export function createBreathPacket(brightness: number, hue: number, speed: number): Buffer {
  const packet = Buffer.alloc(PACKET_SIZE);
  packet[0] = LIGHT_PREFIX_PRO;
  packet[1] = LIGHT_TARGET_ANIMATION;
  packet[2] = ANIM_BREATH;
  packet[3] = hue & 0xff;
  packet[4] = 0xff;  // saturation
  packet[5] = scaled(255, brightness);
  packet[6] = speed & 0xff;
  return packet;
}
