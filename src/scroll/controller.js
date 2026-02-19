/**
 * Scroll Controller (GraphQL version)
 *
 * Triggers infinite scroll by scrolling to the bottom of the page.
 * Does NOT query DOM selectors — post discovery is handled entirely
 * by the GraphQL interceptor. This module only drives scroll events
 * and detects scroll stabilization.
 *
 * Yields { stable: boolean } on each iteration.
 * Stops when:
 *   (a) No new posts received after MAX_STABLE_ITERATIONS consecutive scrolls, OR
 *   (b) The orchestrator signals a date boundary stop, OR
 *   (c) An "end of feed" text indicator is visible on the page.
 */
import { createLogger } from '../logger/index.js';

const logger = createLogger('scroll');

const SCROLL_PAUSE_MS = 2500;   // Wait after each scroll for new content to load
const NETWORK_IDLE_MS = 5000;   // Timeout for waitForLoadState('networkidle')
const MAX_STABLE_ITERS = 3;      // Stop after this many scrolls with no new posts

/**
 * Infinite scroll driver as an async generator.
 * The caller tells it whether new posts arrived via the `hasNewPosts` argument in `next()`.
 *
 * Usage:
 *   const gen = driveScroll(page);
 *   await gen.next();          // prime
 *   await gen.next(true/false); // pass whether new posts arrived last round
 *
 * @param {import('playwright').Page} page
 */
export async function* driveScroll(page) {
    let stableCount = 0;
    let iteration = 0;

    logger.info('Scroll driver started');

    while (true) {
        iteration++;

        // ── Check for Instagram's end-of-feed indicators ──────────────────────
        const feedDone = await checkFeedExhausted(page).catch(() => false);
        if (feedDone) {
            logger.info('End-of-feed indicator detected — stopping scroll');
            return;
        }

        // ── Scroll to bottom ──────────────────────────────────────────────────
        await page.evaluate(() =>
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
        ).catch(() => { });

        // Keepalive mouse move to prevent page idle detection
        await page.mouse.move(640, 400).catch(() => { });

        // Wait for network to settle
        await waitNetworkIdle(page, NETWORK_IDLE_MS);

        // Additional render stabilization pause
        try {
            await page.waitForTimeout(SCROLL_PAUSE_MS);
        } catch {
            logger.warn('Page closed during scroll — stopping');
            return;
        }

        // ── Yield control to orchestrator ────────────────────────────────────
        // The orchestrator passes back whether new posts were received
        const hasNewPosts = yield { iteration, stable: stableCount >= MAX_STABLE_ITERS };

        if (hasNewPosts) {
            stableCount = 0;
            logger.debug(`Scroll #${iteration}: new posts received — reset stable counter`);
        } else {
            stableCount++;
            logger.debug(`Scroll #${iteration}: no new posts (stable ${stableCount}/${MAX_STABLE_ITERS})`);
        }

        if (stableCount >= MAX_STABLE_ITERS) {
            logger.info(`Scroll stopped: content exhausted after ${MAX_STABLE_ITERS} stable iterations`);
            return;
        }
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function checkFeedExhausted(page) {
    return page.evaluate(() => {
        const text = (document.body.innerText || '').toLowerCase();
        return [
            "you're all caught up",
            "you've seen all new posts",
            'no more posts',
            'all caught up',
            'end of results',
        ].some(p => text.includes(p));
    });
}

async function waitNetworkIdle(page, timeout) {
    try {
        await page.waitForLoadState('networkidle', { timeout });
    } catch {
        // Expected on Instagram — long-polling keeps network active
        logger.debug('Network idle timeout (non-fatal)');
    }
}
