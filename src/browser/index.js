import { createLogger } from '../logger/index.js';
import { chromium } from 'playwright';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

const logger = createLogger('browser');

/**
 * Launch a Playwright Chromium browser instance.
 * @param {object} options
 * @param {boolean} options.headless
 * @param {string|null} options.authStatePath - path to Playwright storage state JSON
 * @returns {{ browser, context, page }}
 */
export async function launchBrowser({ headless = true, authStatePath = null } = {}) {
    logger.info(`Launching Chromium (headless=${headless})`);

    const browser = await chromium.launch({
        headless,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
        ],
    });

    const contextOptions = {
        viewport: { width: 1280, height: 900 },
        userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'UTC',
    };

    // Load stored auth state if provided
    if (authStatePath && existsSync(authStatePath)) {
        logger.info(`Loading auth state from: ${authStatePath}`);
        const storageState = JSON.parse(await readFile(authStatePath, 'utf-8'));
        contextOptions.storageState = storageState;
    }

    const context = await browser.newContext(contextOptions);

    // Block unnecessary resources to speed up scraping
    await context.route('**/*.{woff,woff2,ttf,otf}', (route) => route.abort());

    const page = await context.newPage();

    // Disable default timeout — scraping sessions can run for hours.
    // Individual operations set their own timeouts where needed.
    page.setDefaultTimeout(0);
    page.setDefaultNavigationTimeout(60000); // 60s for navigation only

    logger.info('Browser launched successfully');
    return { browser, context, page };
}

/**
 * Navigate to a URL, wait for the page to be ready, and detect login walls.
 * Throws if Instagram redirects to the login page (auth state missing/expired).
 */
export async function navigateTo(page, url) {
    logger.info(`Navigating to: ${url}`);
    await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
    });

    // Give Instagram's React app time to hydrate and render the feed
    await page.waitForTimeout(4000);

    // ── Login wall detection ──────────────────────────────────────────────────
    const currentUrl = page.url();
    const isLoginWall =
        currentUrl.includes('/accounts/login') ||
        currentUrl.includes('/challenge/') ||
        currentUrl.includes('/checkpoint/');

    if (isLoginWall) {
        throw new Error(
            `Instagram redirected to login/challenge: ${currentUrl}\n` +
            `Your auth session has expired or is missing.\n` +
            `Run: node save-auth.js  to re-authenticate, then retry with --auth-state=./auth.json`
        );
    }

    // Also check for login form on the page even if URL didn't change
    const hasLoginForm = await page.$('input[name="username"]').then(el => !!el).catch(() => false);
    if (hasLoginForm) {
        throw new Error(
            `Instagram is showing a login form at ${currentUrl}.\n` +
            `Run: node save-auth.js  to save your session, then retry with --auth-state=./auth.json`
        );
    }

    logger.info(`Navigation complete: ${currentUrl}`);
}

/**
 * Close browser and all associated contexts
 */
export async function closeBrowser(browser) {
    if (browser) {
        await browser.close();
        logger.info('Browser closed');
    }
}

/**
 * Take a debug screenshot (useful during development)
 */
export async function takeScreenshot(page, path) {
    await page.screenshot({ path, fullPage: false });
    logger.debug(`Screenshot saved: ${path}`);
}
