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

    logger.info('Browser launched successfully');
    return { browser, context, page };
}

/**
 * Navigate to a URL and wait for the page to be ready
 */
export async function navigateTo(page, url) {
    logger.info(`Navigating to: ${url}`);
    await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
    });
    // Give the page a moment to render initial content
    await page.waitForTimeout(2000);
    logger.info('Navigation complete');
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
