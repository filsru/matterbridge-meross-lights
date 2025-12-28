/**
 * This file contains the plugin template.
 *
 * @file module.ts
 * @author Luca Liguori
 * @created 2025-06-15
 * @version 1.3.0
 * @license Apache-2.0
 *
 * Copyright 2025, 2026, 2027 Luca Liguori.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  onOffOutlet,
  PlatformConfig,
  PlatformMatterbridge,
} from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { createHash, randomBytes } from 'node:crypto';

type MerossPlatformConfig = PlatformConfig & {
  ip?: string;
  key?: string;
  name?: string;
  channel?: number;
};

export default function initializePlugin(
  matterbridge: PlatformMatterbridge,
  log: AnsiLogger,
  config: PlatformConfig,
): TemplatePlatform {
  return new TemplatePlatform(matterbridge, log, config);
}

export class TemplatePlatform extends MatterbridgeDynamicPlatform {
  private merossIp?: string;
  private merossKey?: string;
  private deviceName = 'Meross Light';
  private channel = 0;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    // Verify that Matterbridge is the correct version
    if (
      this.verifyMatterbridgeVersion === undefined ||
      typeof this.verifyMatterbridgeVersion !== 'function' ||
      !this.verifyMatterbridgeVersion('3.4.0')
    ) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.4.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }

    const cfg = this.config as MerossPlatformConfig;
    this.merossIp = cfg.ip;
    this.merossKey = cfg.key;
    this.deviceName = cfg.name ?? 'Meross Light';
    this.channel = typeof cfg.channel === 'number' ? cfg.channel : 0;

    this.log.info(`Initializing Platform...`);
    if (!this.merossIp || !this.merossKey) {
      this.log.warn('Meross not configured yet: please set ip and key in the plugin settings.');
    } else {
      this.log.info(`Meross configured for IP ${this.merossIp} (key hidden), channel ${this.channel}.`);
    }
  }

  override async onStart(reason?: string) {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);

    await this.ready;
    await this.clearSelect();

    if (!this.merossIp || !this.merossKey) {
      this.log.warn('Plugin not configured (ip/key missing). Skipping discovery.');
      return;
    }

    await this.discoverDevices();
  }

  override async onConfigure() {
    await super.onConfigure();
    this.log.info('onConfigure called');

    for (const device of this.getDevices()) {
      this.log.info(`Configuring device: ${device.uniqueId}`);
    }
  }

  override async onChangeLoggerLevel(logLevel: LogLevel) {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string) {
    await super.onShutdown(reason);

    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices();
  }

  private async discoverDevices() {
    this.log.info('Discovering devices...');

    // Minimal: expose an outlet to test on/off commands.
    // Next: swap onOffOutlet -> onOffLight + level/color clusters.
    const outlet = new MatterbridgeEndpoint(onOffOutlet, { id: 'meross1' })
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        this.deviceName,
        'MEROSS-SN-LOCAL',
        this.matterbridge.aggregatorVendorId,
        'Matterbridge',
        'Meross via Matterbridge',
        10000,
        '1.0.0',
      )
      .createDefaultPowerSourceWiredClusterServer()
      .addRequiredClusterServers()
      .addCommandHandler('on', async (data) => {
        this.log.info(`Command on called on cluster ${data.cluster}`);
        await this.merossToggle(true);
      })
      .addCommandHandler('off', async (data) => {
        this.log.info(`Command off called on cluster ${data.cluster}`);
        await this.merossToggle(false);
      });

    await this.registerDevice(outlet);
  }

  private md5(input: string): string {
    return createHash('md5').update(input, 'utf8').digest('hex');
  }

  private async merossToggle(on: boolean) {
    if (!this.merossIp || !this.merossKey) {
      this.log.warn('merossToggle called but ip/key are missing.');
      return;
    }

    const messageId = randomBytes(16).toString('hex'); // 32 hex
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = this.md5(`${messageId}${this.merossKey}${timestamp}`);

    const body = {
      header: {
        from: `http://${this.merossIp}/config`,
        messageId,
        method: 'SET',
        namespace: 'Appliance.Control.ToggleX',
        payloadVersion: 1,
        timestamp,
        sign,
      },
      payload: {
        togglex: {
          channel: this.channel,
          onoff: on ? 1 : 0,
        },
      },
    };

    this.log.info(`Sending Meross ToggleX -> ${on ? 'ON' : 'OFF'} to ${this.merossIp}...`);

    const res = await fetch(`http://${this.merossIp}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const text = await res.text().catch(() => '');
    this.log.debug(`Meross HTTP status: ${res.status} ${res.statusText}`);
    if (text) this.log.debug(`Meross response body: ${text}`);
  }
}
