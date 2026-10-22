/* eslint-disable n/no-process-exit */
import PQueue from 'p-queue';

import { config } from './common/config/index.js';
import { convertImportCookies } from './common/cookie.js';
import logger from './common/logger.js';
import { cleanupTempFiles, killBrowserProcesses, safeLaunchBrowser } from './common/puppeteer.js';
import { createServer } from './common/server.js';
import { DeviceLogin } from './device-login.js';
import { EulaManager } from './eula-manager.js';
import { sendHealthcheck } from './healthcheck.js';
import { NotificationReason } from './interfaces/notification-reason.js';
import { sendNotification, testNotifiers, verifyNotifiers } from './notify.js';
import PuppetFreeGames from './puppet/free-games.js';
import PuppetLogin from './puppet/login.js';
import { generateCheckoutUrl } from './purchase.js';
import { checkForUpdate, logVersionOnError } from './version.js';

import type { AccountConfig } from './common/config/index.js';

export async function redeemAccount(account: AccountConfig): Promise<boolean> {
  const L = logger.child({ user: account.email });
  L.info(`Checking free games for ${account.email} `);
  try {
    await convertImportCookies(account.email);
    const browser = await safeLaunchBrowser(L);
    const cookieLogin = new PuppetLogin({
      email: account.email,
      browser,
    });
    const deviceLogin = new DeviceLogin({
      user: account.email,
    });
    const freeGames = new PuppetFreeGames({
      email: account.email,
      browser,
    });

    // Login
    let usedDeviceAuth = false;
    // attempt token refresh
    let successfulLogin = await deviceLogin.refreshDeviceAuth();
    L.trace({ successfulLogin }, 'Device auth refresh result');
    usedDeviceAuth = successfulLogin;
    if (!successfulLogin) {
      successfulLogin = await cookieLogin.refreshCookieLogin();
      L.trace({ successfulLogin }, 'Cookie auth refresh result');
    }
    if (!successfulLogin) {
      // get new device auth
      await deviceLogin.newDeviceAuthLogin();
      usedDeviceAuth = true;
    }

    if (usedDeviceAuth) {
      const eulaManager = new EulaManager(account.email);
      await eulaManager.checkEulaStatus();
    }

    // Get purchasable offers
    const offers = await freeGames.getAllFreeGames();
    L.debug('Closing browser');
    await browser.close();
    L.trace('Browser finished closing');

    await verifyNotifiers(account.email, offers.length === 0);

    if (offers.length) {
      L.debug(`Sending checkout link for ${offers.length} offer(s)`);
      const checkoutUrl = generateCheckoutUrl(offers);
      L.info({ url: checkoutUrl }, 'Dispatching checkout notification');
      await sendNotification(account.email, NotificationReason.PURCHASE, checkoutUrl);
    } else {
      L.info('No free games available');
    }
    if (!freeGames.lookupComplete) {
      throw new Error('Not all configured free game lookups succeeded');
    }
    return true;
  } catch (e) {
    if (e.response) {
      if (e.response.body) L.error(e.response.body);
      else L.error(e.response);
    }
    L.error(e);
    logVersionOnError();
    return false;
  }
}

export async function main(): Promise<number> {
  await checkForUpdate();
  logger.debug('Starting web server');
  const server = await createServer();
  if (config.testNotifiers) {
    await testNotifiers();
  }
  const queue = new PQueue({
    concurrency: config.accountConcurrency,
    interval: config.intervalTime * 1000,
    intervalCap: 1,
  });
  let successful = false;
  try {
    const results = await Promise.allSettled(
      config.accounts.map(async (account) => queue.add(async () => redeemAccount(account))),
    );
    successful = results.every((result) => result.status === 'fulfilled' && result.value === true);
  } finally {
    server.close();
    await killBrowserProcesses(logger);
    await cleanupTempFiles(logger);
  }
  if (!successful) {
    logger.error('One or more accounts failed; no healthcheck success ping sent');
    return 1;
  }
  await sendHealthcheck();
  logger.info('Exiting successfully');
  return 0;
}

if (process.env.NODE_ENV !== 'test') {
  try {
    process.exit(await main());
  } catch (err) {
    logger.error(err);
    logVersionOnError();
    await killBrowserProcesses(logger);
    await cleanupTempFiles(logger);
    process.exit(1);
  }
}
