// -----------------------------------------------------------------------------
// Entry point: SDK wiring only (src/handlers.js registers every handler BEFORE
// connect(), and delegates to the DanthermApp of src/app.js).
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { DanthermApp } from './src/app.js';
import { registerHandlers } from './src/handlers.js';

const gladys = new GladysIntegration();
const app = new DanthermApp({ gladys });

registerHandlers(gladys, app, logger);
gladys.handleShutdown(() => app.shutdown());

logger.info('Starting the Dantherm / Pluggit integration...');
// /data first: a stop kept unconfirmed leaves at once, before Gladys answers.
app.boot().catch((err) => logger.error(`Boot failed (${err?.name ?? 'Error'})`));
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
