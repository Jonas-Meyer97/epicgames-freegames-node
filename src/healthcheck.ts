import axios from './axios-base.js';
import { config } from './common/config/index.js';
import logger from './common/logger.js';

export async function sendHealthcheck(): Promise<void> {
  if (!config.healthcheckUrl) return;
  try {
    await axios.get(config.healthcheckUrl, {
      timeout: config.healthcheckTimeout * 1000,
      maxRedirects: 0,
    });
  } catch {
    // Do not expose the ping token in Axios errors.
    throw new Error('Healthcheck success ping failed');
  }
  logger.info('Healthcheck success ping sent');
}
