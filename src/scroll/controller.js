import { createLogger } from '../logger/index.js';

const logger = createLogger('scroll-controller');

// Instagram-specific constants
// Each scroll pause must be generous — Instagram lazy-loads images and JS bundles
const SCROLL_PAUSE_MS = 2500;
const NETWORK_IDLE_TIMEOUT_MS = 6000;
const MAX_STABLE_ITERATIONS = 3;

// Instagram renders each post as an <article> element in the feed
// This is the most reliable structural selector — avoids obfuscated class names
export const INSTAGRAM_POST_SELECTOR = 'article';

/**
 * Infinite scroll controller tuned for Instagram's feed.
 *
 * Instagram-specific behaviour accounted for:
 *  - Posts are rendered inside <article> elements
 *  - Instagram uses React virtual DOM — new articles are appended, not replaced
 *  - Instagram may show a "You're all caught up" banner when feed is exhausted
 *  - Instagram throttles scroll speed; smooth scrolling helps avoid rate limits
 *  - Network idle may never fully settle (polling connections) — we use a timeout fallback
 *
 * Yields batches of newly appeared <article> ElementHandles on each scroll iteration.
 * Stops when:
 *   (a) No new articles appear after MAX_STABLE_ITERATIONS consecutive checks, OR
 *   (b) A post older than startDate is detected, OR
 *   (c) Instagram's "You're all caught up" / end-of-feed indicator is detected
 *
 * @param {import('playwright').Page} page
 * @param {object} options
 * @param {string} options.postSelector - CSS selector for post containers
 * @param {Date} options.startDate - stop if posts older than this are found
 * @param {Function} options.getPostDate - async fn(elementHandle) => Date|null
 * @yields {{ handles: ElementHandle[], reachedOldBoundary: boolean }}
 */
export async function* scrollUntilExhausted(page, options) {
    const { postSelector, startDate, getPostDate } = options;

    let stableCount = 0;
    let lastPostCount = 0;
    let lastScrollHeight = 0;
    let reachedOldBoundary = false;
    let totalIterations = 0;

    // Track seen post handles by their stable identity (shortcode or src)
    const seenIds = new Set();

    logger.info('Starting Instagram infinite scroll loop');

    while (true) {
        // ── Check for Instagram's end-of-feed indicators ─────────────────────
        const feedExhausted = await checkFeedExhausted(page);
        if (feedExhausted) {
            logger.info('Stopping scroll: Instagram end-of-feed indicator detected');
            break;
        }

        // ── Get current DOM state ─────────────────────────────────────────────
        const currentScrollHeight = await page.evaluate(() => document.body.scrollHeight);
        const allHandles = await page.$$(postSelector);
        const currentPostCount = allHandles.length;
        totalIterations++;

        // ── Early warning: no posts found at all ──────────────────────────────
        if (totalIterations === 1 && currentPostCount === 0) {
            logger.warn(
                `No posts found with selector "${postSelector}" on first check.\n` +
                `This usually means:\n` +
                `  1. Instagram is showing a login wall (re-run: node save-auth.js)\n` +
                `  2. The page hasn't fully loaded yet (try --no-headless to debug)\n` +
                `  3. The post selector doesn't match this platform's HTML`
            );
        }

        logger.debug(
            `Scroll check: posts=${currentPostCount}, scrollHeight=${currentScrollHeight}, stable=${stableCount}`
        );

        // ── Identify new handles ──────────────────────────────────────────────
        const newHandles = [];
        for (const handle of allHandles) {
            const id = await getHandleId(handle);
            if (id && !seenIds.has(id)) {
                seenIds.add(id);
                newHandles.push(handle);
            }
        }

        // ── Date boundary check on new handles ───────────────────────────────
        if (newHandles.length > 0 && startDate) {
            for (const handle of newHandles) {
                const postDate = await getPostDate(handle);
                if (postDate && postDate < startDate) {
                    logger.info(
                        `Found post older than start date (${postDate.toISOString()}). Signaling boundary stop.`
                    );
                    reachedOldBoundary = true;
                    break;
                }
            }
        }

        // ── Yield new handles ─────────────────────────────────────────────────
        if (newHandles.length > 0) {
            logger.info(`Scroll batch: ${newHandles.length} new post(s) found (total seen: ${seenIds.size})`);
            yield { handles: newHandles, reachedOldBoundary };
        }

        if (reachedOldBoundary) {
            logger.info('Stopping scroll: reached date boundary');
            break;
        }

        // ── Stabilization check ───────────────────────────────────────────────
        const hasGrown =
            currentPostCount > lastPostCount || currentScrollHeight > lastScrollHeight;

        if (!hasGrown) {
            stableCount++;
            logger.debug(
                `No DOM growth (stable iteration ${stableCount}/${MAX_STABLE_ITERATIONS})`
            );
            if (stableCount >= MAX_STABLE_ITERATIONS) {
                logger.info('Stopping scroll: content exhausted (no new posts after max stable iterations)');
                break;
            }
        } else {
            stableCount = 0;
        }

        lastPostCount = currentPostCount;
        lastScrollHeight = currentScrollHeight;

        // ── Scroll to bottom ──────────────────────────────────────────────────
        // Use smooth scrolling — helps Instagram's lazy loader trigger correctly
        await page.evaluate(() =>
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
        );

        // Keepalive: move the mouse slightly so the page doesn't go idle
        await page.mouse.move(640, 400).catch(() => { });

        // Wait for network to settle (with timeout fallback for Instagram's polling)
        await waitForNetworkIdle(page, NETWORK_IDLE_TIMEOUT_MS);

        // Additional render stabilization — Instagram needs time to inject new articles
        try {
            await page.waitForTimeout(SCROLL_PAUSE_MS);
        } catch {
            // Page was closed externally — exit the loop gracefully
            logger.warn('Page closed during scroll pause — stopping loop');
            break;
        }
    }

    logger.info(`Scroll loop complete. Total unique posts discovered: ${seenIds.size}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get a stable string ID for a post handle.
 * Uses the Instagram shortcode from the post link URL, falling back to img src.
 */
async function getHandleId(handle) {
    return handle.evaluate((article) => {
        // Prefer shortcode from post URL
        const link =
            article.querySelector('a[href*="/p/"]') ||
            article.querySelector('a[href*="/reel/"]') ||
            article.querySelector('a[href*="/tv/"]');
        if (link) {
            const match = link.getAttribute('href')?.match(/\/(p|reel|tv)\/([^/]+)/);
            if (match) return match[2]; // shortcode
        }
        // Fallback: image src (truncated to avoid huge strings)
        const img = article.querySelector('img[src]');
        return img ? img.getAttribute('src')?.slice(0, 120) : null;
    });
}

/**
 * Detect Instagram's end-of-feed signals:
 *  - "You're all caught up" text
 *  - SVG-based end banner
 *  - "No more posts" type indicators
 */
async function checkFeedExhausted(page) {
    return page.evaluate(() => {
        const bodyText = document.body.innerText || '';
        const exhaustedPhrases = [
            "you're all caught up",
            "you've seen all new posts",
            'no more posts',
            'all caught up',
        ];
        return exhaustedPhrases.some((phrase) =>
            bodyText.toLowerCase().includes(phrase)
        );
    });
}

/**
 * Wait for network idle with a timeout fallback.
 * Instagram keeps long-polling connections open, so networkidle may never fire.
 */
async function waitForNetworkIdle(page, timeout) {
    try {
        await page.waitForLoadState('networkidle', { timeout });
    } catch {
        // Timeout is expected on Instagram — continue
        logger.debug('Network idle timeout (non-fatal), continuing scroll');
    }
}
