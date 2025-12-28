import {
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  extendedColorLight,
  PlatformConfig,
  PlatformMatterbridge,
} from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

import { merossToggleX, merossSetRgbAndBrightness, rgbToInt } from './merossHttp.js';

type MerossDeviceConfig = {
  id: string;
  name: string;
  ip: string;
  key: string;
  channel?: number;
};

type MerossPlatformConfig = PlatformConfig & {
  devices: MerossDeviceConfig[];
};

export default function initializePlugin(
  matterbridge: PlatformMatterbridge,
  log: AnsiLogger,
  config: PlatformConfig,
): TemplatePlatform {
  return new TemplatePlatform(matterbridge, log, config as MerossPlatformConfig);
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

// Hue/Sat (0..254) -> RGB int (0xRRGGBB)
function hsvToRgbInt(hue254: number, sat254: number): number {
  const h = (clamp(hue254, 0, 254) / 254) * 360;
  const s = clamp(sat254, 0, 254) / 254;
  const v = 1;

  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;

  let r1 = 0,
    g1 = 0,
    b1 = 0;
  if (h < 60) [r1, g1, b1] = [c, x, 0];
  else if (h < 120) [r1, g1, b1] = [x, c, 0];
  else if (h < 180) [r1, g1, b1] = [0, c, x];
  else if (h < 240) [r1, g1, b1] = [0, x, c];
  else if (h < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];

  const r = Math.round((r1 + m) * 255);
  const g = Math.round((g1 + m) * 255);
  const b = Math.round((b1 + m) * 255);
  return rgbToInt(r, g, b);
}

export class TemplatePlatform extends MatterbridgeDynamicPlatform {
  declare config: MerossPlatformConfig;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: MerossPlatformConfig) {
    super(matterbridge, log, config);

    if (
      this.verifyMatterbridgeVersion === undefined ||
      typeof this.verifyMatterbridgeVersion !== 'function' ||
      !this.verifyMatterbridgeVersion('3.4.0')
    ) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.4.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }

    this.log.info(`Initializing Platform...`);
  }

  override async onStart(reason?: string) {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);

    await this.ready;
    await this.clearSelect();

    await this.discoverDevices();
  }

  override async onConfigure() {
    await super.onConfigure();
    this.log.info('onConfigure called');
  }

  override async onChangeLoggerLevel(logLevel: LogLevel) {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string) {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices();
  }

  private validateDevices(): MerossDeviceConfig[] {
    const devices = this.config.devices;

    if (!Array.isArray(devices) || devices.length === 0) {
      throw new Error('Config error: devices[] is required and must contain at least one device');
    }

    const seen = new Set<string>();
    for (const d of devices) {
      if (!d?.id || !d?.name || !d?.ip || !d?.key) {
        throw new Error(`Config error: each device requires id, name, ip, key`);
      }
      if (seen.has(d.id)) {
        throw new Error(`Config error: duplicate device id "${d.id}"`);
      }
      seen.add(d.id);
    }
    return devices;
  }

  private async discoverDevices() {
    this.log.info('Discovering devices...');

    const devices = this.validateDevices();

    for (const d of devices) {
      const channel = Number(d.channel ?? 0);

      // Cache PAR DEVICE (important pour envoyer rgb+luminance ensemble)
      let lastRgb = 0xffffff;
      let lastLum = 100;

      this.log.info(`Registering Meross light id=${d.id} name="${d.name}" ip=${d.ip} ch=${channel}`);

      const light = new MatterbridgeEndpoint(extendedColorLight, { id: d.id })
        .createDefaultBridgedDeviceBasicInformationClusterServer(
          d.name,
          `SN-${d.id}`,
          this.matterbridge.aggregatorVendorId,
          'Matterbridge',
          d.name,
          10000,
          '1.0.0',
        )
        .createDefaultPowerSourceWiredClusterServer()
        .addRequiredClusterServers()

        // ON / OFF
        .addCommandHandler('on', async () => {
          this.log.info(`Meross ON -> ${d.ip} (${d.name}) ch=${channel}`);
          await merossToggleX(d.ip, d.key, channel, true);
        })
        .addCommandHandler('off', async () => {
          this.log.info(`Meross OFF -> ${d.ip} (${d.name}) ch=${channel}`);
          await merossToggleX(d.ip, d.key, channel, false);
        })

        // Brightness (LevelControl)
        .addCommandHandler('moveToLevel', async (data) => {
          const raw = Number((data.request as any)?.level ?? (data.request as any)?.newLevel ?? NaN);
          this.log.debug?.(`[${d.id}] moveToLevel request=${JSON.stringify(data.request)}`);
          if (!Number.isFinite(raw)) return;

          lastLum = Math.round((clamp(raw, 0, 254) / 254) * 100);
          await merossSetRgbAndBrightness(d.ip, d.key, channel, lastRgb, lastLum);
        })
        .addCommandHandler('moveToLevelWithOnOff', async (data) => {
          const raw = Number((data.request as any)?.level ?? (data.request as any)?.newLevel ?? NaN);
          this.log.debug?.(`[${d.id}] moveToLevelWithOnOff request=${JSON.stringify(data.request)}`);
          if (!Number.isFinite(raw)) return;

          lastLum = Math.round((clamp(raw, 0, 254) / 254) * 100);

          if (lastLum > 0) await merossToggleX(d.ip, d.key, channel, true);
          await merossSetRgbAndBrightness(d.ip, d.key, channel, lastRgb, lastLum);
        })

        // Couleur (Hue/Sat) - ColorControl
        .addCommandHandler('moveToHueAndSaturation', async (data) => {
          const hue = Number((data.request as any)?.hue ?? NaN);
          const sat = Number((data.request as any)?.saturation ?? NaN);
          this.log.debug?.(`[${d.id}] moveToHueAndSaturation request=${JSON.stringify(data.request)}`);
          if (!Number.isFinite(hue) || !Number.isFinite(sat)) return;

          lastRgb = hsvToRgbInt(hue, sat);
          await merossSetRgbAndBrightness(d.ip, d.key, channel, lastRgb, lastLum);
        })

        // XY (optionnel)
        .addCommandHandler('moveToColor', async (data) => {
          this.log.info(`[${d.id}] moveToColor received: ${JSON.stringify(data.request)}`);
        });

      await this.registerDevice(light);
    }
  }
}
