/* eslint-disable n/no-process-exit, unicorn/no-process-exit */
import { isAxiosError } from 'axios';
import PQueue from 'p-queue';

import { config } from './common/config/index.ts';
import logger from './common/logger.ts';
import { killBrowserProcesses, safeLaunchBrowser } from './common/playwright.ts';
import { createServer } from './common/server.ts';
import { DeviceLogin } from './device-login.ts';
import { EulaManager } from './eula-manager.ts';
import { sendHealthcheck } from './healthcheck.ts';
import { sendNotification, testNotifiers, verifyNotifiers } from './notify.ts';
import PuppetFreeGames from './puppet/free-games.ts';
import { generateCheckoutUrl } from './purchase.ts';
import { checkForUpdate, logVersionOnError } from './version.ts';

import type { AccountConfig } from './common/config/index.ts';

export async function redeemAccount(account: AccountConfig): Promise<boolean> {
  const L = logger.child({ user: account.email });
  L.info(`Checking free games for ${account.email} `);
  try {
    const deviceLogin = new DeviceLogin({
      user: account.email,
    });

    let deviceAuth = await deviceLogin.refreshDeviceAuth();
    L.trace({ tokenExpiresAt: deviceAuth?.expires_at }, 'Device auth refresh result');

    const browser = await safeLaunchBrowser(L, account.email);

    const freeGames = new PuppetFreeGames({
      email: account.email,
      browser,
    });

    // validate browser EG1 cookie
    let isCookieValid = await freeGames.checkCookie();

    if (!isCookieValid && deviceAuth) {
      L.info('Stored cookie is missing/expired. Refreshing with cached device auth');
      await freeGames.setupCookies(deviceAuth);
      isCookieValid = await freeGames.checkCookie();
    }

    if (!isCookieValid) {
      L.info('Stored cookie is missing/expired. Refreshing with new device auth');
      deviceAuth = await deviceLogin.newDeviceAuthLogin();
      await freeGames.setupCookies(deviceAuth);
      isCookieValid = await freeGames.checkCookie();
    }

    if (!isCookieValid) {
      throw new Error('Could not generate authenticated browser session');
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const eulaManager = new EulaManager(account.email, deviceAuth!);
    await eulaManager.checkEulaStatus();

    // Get purchasable offers
    const offers = await freeGames.getAllFreeGames();
    L.debug('Closing browser');
    await browser.close();
    L.trace('Browser finished closing');

    await verifyNotifiers(account.email, offers.length === 0);

    if (offers.length > 0) {
      L.debug(`Sending checkout link for ${offers.length.toFixed(0)} offer(s)`);
      const checkoutUrl = generateCheckoutUrl(offers);
      L.info({ url: checkoutUrl }, 'Dispatching checkout notification');
      await sendNotification(account.email, 'PURCHASE', checkoutUrl);
    } else {
      L.info('No free games available');
    }
    if (!freeGames.lookupComplete) {
      throw new Error('Not all configured free game lookups succeeded');
    }
    return true;
  } catch (error) {
    if (isAxiosError(error) && error.response) {
      if (error.response.data) L.error(error.response.data);
      else L.error(error.response);
    }
    L.error(error);
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
    successful = results.every((result) => result.status === 'fulfilled' && result.value);
  } finally {
    server.close();
    await killBrowserProcesses(logger);
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
  } catch (error) {
    logger.error(error);
    logVersionOnError();
    await killBrowserProcesses(logger);
    process.exit(1);
  }
}
