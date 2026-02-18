import { createHash } from 'crypto';
import { createLogger } from '../logger/index.js';
import { parseISO, isValid, fromUnixTime } from 'date-fns';

const logger = createLogger('extractor');

// ─── Instagram DOM Knowledge ──────────────────────────────────────────────────
//
// Instagram's feed (as of 2024-2025) renders each post inside an <article> tag.
// Key structural patterns (class names are obfuscated hashes, so we avoid them):
//
//  Post container:   article
//  Image:            article img[src]  (highest-res in srcset)
//                    article video > source  (for video posts — we grab poster)
//  Caption:          article ._a9zs span  (obfuscated but stable role)
//                    OR: article [data-testid="post-comment-root"] first child span
//                    OR: first <h1> inside article (profile posts)
//                    OR: article span with dir="auto" (most reliable structural)
//  Comments:         article ul > li  (each comment is a list item)
//                    username: li a[role="link"]  or  li span > a
//                    text:     li span[dir="auto"]
//  Date/Time:        article time[datetime]  ← most reliable, always present
//  Post link/ID:     article a[href*="/p/"]  or  a[href*="/reel/"]
//                    The shortcode in the URL is the stable post identifier
//
// ─────────────────────────────────────────────────────────────────────────────

// ─── Date Parsing ─────────────────────────────────────────────────────────────

/**
 * Parse a date value from Instagram's DOM into a UTC Date.
 * Instagram always uses ISO 8601 in time[datetime], but we handle fallbacks.
 * @param {string|number|null} raw
 * @returns {Date|null}
 */
export function parseDate(raw) {
    if (!raw) return null;

    // Numeric Unix timestamp (seconds or milliseconds)
    if (typeof raw === 'number' || /^\d{10,13}$/.test(String(raw).trim())) {
        const num = Number(raw);
        const date = num > 1e12 ? new Date(num) : fromUnixTime(num);
        return isValid(date) ? date : null;
    }

    const str = String(raw).trim();

    // ISO 8601 — Instagram's primary format in time[datetime]
    const iso = parseISO(str);
    if (isValid(iso)) return iso;

    // Native Date fallback (handles many locale strings)
    const native = new Date(str);
    if (isValid(native)) return native;

    logger.warn(`Could not parse date: "${str}"`);
    return null;
}

/**
 * Check if a date is within [startDate, endDate] inclusive
 */
export function isWithinRange(date, startDate, endDate) {
    if (!date) return false;
    return date >= startDate && date <= endDate;
}

// ─── Instagram Post Extraction ────────────────────────────────────────────────

/**
 * Extract structured data from a single Instagram post <article> ElementHandle.
 *
 * @param {import('playwright').ElementHandle} postHandle
 * @param {import('playwright').Page} _page  (unused but kept for API consistency)
 * @returns {Promise<{
 *   postIdentifier: string,
 *   postUrl: string|null,
 *   imageUrl: string|null,
 *   captionText: string,
 *   comments: Array<{username:string, text:string}>,
 *   publishedAt: Date|null,
 *   rawDateValue: string|null
 * }>}
 */
export async function extractPost(postHandle, _page) {
    const data = await postHandle.evaluate((article) => {
        // ── Post URL & Shortcode (stable identifier) ───────────────────────────
        // Instagram post URLs: /p/<shortcode>/  or  /reel/<shortcode>/
        const postLink =
            article.querySelector('a[href*="/p/"]') ||
            article.querySelector('a[href*="/reel/"]') ||
            article.querySelector('a[href*="/tv/"]');
        const postUrl = postLink ? postLink.getAttribute('href') : null;
        // Extract shortcode from URL: /p/ABC123/ → ABC123
        const shortcodeMatch = postUrl?.match(/\/(p|reel|tv)\/([^/]+)/);
        const shortcode = shortcodeMatch ? shortcodeMatch[2] : null;

        // ── Image URL ──────────────────────────────────────────────────────────
        let imageUrl = null;

        // 1. Try srcset on <img> — pick highest width descriptor
        const imgEl = article.querySelector('img[srcset]') || article.querySelector('img[src]');
        if (imgEl) {
            const srcset = imgEl.getAttribute('srcset') || '';
            if (srcset) {
                const entries = srcset
                    .split(',')
                    .map((s) => s.trim().split(/\s+/))
                    .filter((p) => p[0]);
                // Sort by width descriptor descending (e.g. "1080w" > "640w")
                entries.sort((a, b) => {
                    const wa = parseFloat((a[1] || '0').replace(/[^\d.]/g, '')) || 0;
                    const wb = parseFloat((b[1] || '0').replace(/[^\d.]/g, '')) || 0;
                    return wb - wa;
                });
                imageUrl = entries[0]?.[0] || null;
            }
            // Fallback to src
            if (!imageUrl) imageUrl = imgEl.getAttribute('src');
        }

        // 2. For video posts, grab the poster image
        if (!imageUrl) {
            const videoEl = article.querySelector('video[poster]');
            if (videoEl) imageUrl = videoEl.getAttribute('poster');
        }

        // ── Caption ────────────────────────────────────────────────────────────
        // Instagram renders captions in a <span dir="auto"> inside the post body.
        // The first such span that is NOT inside the comments list is the caption.
        let captionText = '';

        // Strategy 1: span[dir="auto"] outside of the comments <ul>
        const commentsList = article.querySelector('ul');
        const allDirAutoSpans = Array.from(article.querySelectorAll('span[dir="auto"]'));
        for (const span of allDirAutoSpans) {
            // Skip if inside the comments list
            if (commentsList && commentsList.contains(span)) continue;
            // Skip very short strings (likely usernames)
            const text = span.textContent.trim();
            if (text.length > 5) {
                captionText = text;
                break;
            }
        }

        // Strategy 2: <h1> (used on profile/post pages)
        if (!captionText) {
            const h1 = article.querySelector('h1');
            if (h1) captionText = h1.textContent.trim();
        }

        // Strategy 3: data-testid="post-comment-root" first span
        if (!captionText) {
            const captionRoot = article.querySelector('[data-testid="post-comment-root"]');
            if (captionRoot) captionText = captionRoot.textContent.trim();
        }

        // ── Comments ───────────────────────────────────────────────────────────
        // Instagram renders comments as <li> items inside a <ul>
        const comments = [];
        if (commentsList) {
            const commentItems = commentsList.querySelectorAll('li');
            commentItems.forEach((li) => {
                // Username: first <a> link inside the comment (links to profile)
                const usernameEl =
                    li.querySelector('a[role="link"]') ||
                    li.querySelector('span > a') ||
                    li.querySelector('a');
                const username = usernameEl ? usernameEl.textContent.trim() : '';

                // Comment text: span[dir="auto"] inside the li
                const textEl = li.querySelector('span[dir="auto"]');
                const text = textEl ? textEl.textContent.trim() : li.textContent.trim();

                // Exclude "Load more comments" buttons and empty items
                if (text && text.length > 0 && !text.toLowerCase().includes('load more')) {
                    comments.push({ username, text });
                }
            });
        }

        // ── Published Date ─────────────────────────────────────────────────────
        // Instagram ALWAYS has <time datetime="2023-06-15T10:30:00.000Z">
        const timeEl = article.querySelector('time[datetime]');
        const rawDateValue = timeEl ? timeEl.getAttribute('datetime') : null;

        return { postUrl, shortcode, imageUrl, captionText, comments, rawDateValue };
    });

    // Parse date in Node.js context (has access to date-fns)
    const publishedAt = parseDate(data.rawDateValue);

    // Stable post identifier: shortcode (best) → hash of imageUrl → random
    let postIdentifier;
    if (data.shortcode) {
        postIdentifier = data.shortcode;
    } else {
        const identifierSource = data.imageUrl || data.rawDateValue || data.captionText;
        postIdentifier = createHash('sha256')
            .update(identifierSource || Math.random().toString())
            .digest('hex')
            .slice(0, 32);
    }

    // Build full post URL
    const postUrl = data.postUrl
        ? data.postUrl.startsWith('http')
            ? data.postUrl
            : `https://www.instagram.com${data.postUrl}`
        : null;

    return {
        postIdentifier,
        postUrl,
        imageUrl: data.imageUrl,
        captionText: data.captionText,
        comments: data.comments,
        publishedAt,
        rawDateValue: data.rawDateValue,
    };
}

/**
 * Quickly extract the published date from a post handle (used by scroll controller).
 * @param {import('playwright').ElementHandle} handle
 * @returns {Promise<Date|null>}
 */
export async function getPostDateFromHandle(handle) {
    const raw = await handle.evaluate((article) => {
        const timeEl = article.querySelector('time[datetime]');
        return timeEl ? timeEl.getAttribute('datetime') : null;
    });
    return parseDate(raw);
}
