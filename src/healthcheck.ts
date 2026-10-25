import axios from './axios-base.ts';
import { config } from './common/config/index.ts';
import logger from './common/logger.ts';

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
