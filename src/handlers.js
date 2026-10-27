// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the end-to-end
// tests, so the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // The commands. A failure is logged here: the SDK only acks it to Gladys.
  gladys.onSetValue(async (device, feature, value) => {
    try {
      await app.setValue(device, feature, value);
    } catch (err) {
      logger?.warn(`Command ${feature?.external_id} refused: ${err.message}`);
      throw err;
    }
  });

  // Configuration screen button.
  gladys.onAction(ACTIONS.TEST_CONNECTION, () => app.testConnection());

  // Configuration saved by the user: applied one at a time, in order.
  gladys.onConfigUpdated((config) => app.configUpdated(config));

  // Every connection (the first one and each reconnection): the configuration
  // read from Gladys, again and again while it fails (src/app.js
  // connectedFrom), then the Discovery list and the status again.
  gladys.on('connected', async () => {
    try {
      await app.connectedFrom(() => gladys.getConfig());
    } catch (err) {
      logger?.error(`Start failed (${err?.name ?? 'Error'})`);
    }
  });
}
