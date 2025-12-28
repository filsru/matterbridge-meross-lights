// src/merossHttp.ts
import crypto from 'node:crypto';

export type MerossMethod = 'GET' | 'SET';

export type MerossRequest<TPayload = any> = {
  header: {
    from: string;
    messageId: string;
    method: MerossMethod;
    namespace: string;
    payloadVersion: number;
    timestamp: number;
    sign: string;
  };
  payload: TPayload;
};

export function createMerossMessageId(): string {
  // identique à ton pre-script: 16 bytes -> 32 hex
  return crypto.randomBytes(16).toString('hex');
}

export function createMerossTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

export function createMerossSign(messageId: string, key: string, timestamp: number): string {
  // md5(messageId + key + timestamp)
  return crypto.createHash('md5').update(`${messageId}${key}${timestamp}`).digest('hex').toLowerCase();
}

export function buildMerossRequest<TPayload>(
  ip: string,
  key: string,
  namespace: string,
  method: MerossMethod,
  payload: TPayload,
): MerossRequest<TPayload> {
  const messageId = createMerossMessageId();
  const timestamp = createMerossTimestamp();

  return {
    header: {
      from: `http://${ip}/config`,
      messageId,
      method,
      namespace,
      payloadVersion: 1,
      timestamp,
      sign: createMerossSign(messageId, key, timestamp),
    },
    payload,
  };
}

export async function merossPostConfig<TPayload, TResponse = any>(
  ip: string,
  key: string,
  namespace: string,
  method: MerossMethod,
  payload: TPayload,
  timeoutMs = 4000,
): Promise<TResponse> {
  const body = buildMerossRequest(ip, key, namespace, method, payload);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`http://${ip}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`Meross HTTP ${res.status}: ${text}`);

    try {
      return JSON.parse(text) as TResponse;
    } catch {
      return text as unknown as TResponse;
    }
  } finally {
    clearTimeout(t);
  }
}

/** Prise/relais ON/OFF */
export async function merossToggleX(ip: string, key: string, channel: number, on: boolean) {
  return merossPostConfig(
    ip,
    key,
    'Appliance.Control.ToggleX',
    'SET',
    { togglex: { channel, onoff: on ? 1 : 0 } },
  );
}

export async function merossSetBrightness(ip: string, key: string, channel: number, luminance: number) {
  const lum = Math.max(0, Math.min(100, Math.round(luminance)));
  return merossPostConfig(ip, key, 'Appliance.Control.Light', 'SET', {
    light: { capacity: 4, channel, luminance: lum },
  });
}

/**
 * Ampoule: RGB + brightness (ton payload validé).
 * rgb24 = 0xRRGGBB (ex: 0xFF0000 = 16711680)
 */
export async function merossSetRgbAndBrightness(
  ip: string,
  key: string,
  channel: number,
  rgb24: number,
  luminance: number,
) {
  const lum = Math.max(0, Math.min(100, Math.round(luminance)));
  const rgb = rgb24 >>> 0; // force uint32
  return merossPostConfig(ip, key, 'Appliance.Control.Light', 'SET', {
    light: { rgb, capacity: 5, luminance: lum, channel },
  });
}

/** Helper: (r,g,b) 0..255 -> int 0xRRGGBB */
export function rgbToInt(r: number, g: number, b: number): number {
  const rr = Math.max(0, Math.min(255, Math.round(r)));
  const gg = Math.max(0, Math.min(255, Math.round(g)));
  const bb = Math.max(0, Math.min(255, Math.round(b)));
  return (rr << 16) | (gg << 8) | bb;
}
