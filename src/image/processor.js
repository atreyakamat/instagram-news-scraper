/**
 * Image downloader module.
 *
 * Downloads images via the browser's fetch (inheriting session cookies),
 * saves them to disk in a structured directory: downloads/<year>/<month>/,
 * and returns the relative file path.
 *
 * Includes retry logic with exponential backoff (max 3 retries).
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join, extname } from 'path';
import { createHash } from 'crypto';
import { createLogger } from '../logger/index.js';

const logger = createLogger('image-downloader');

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/**
 * Determine file extension from URL or default to .jpg
 */
function getExtension(imageUrl) {
    try {
        const pathname = new URL(imageUrl).pathname;
        const ext = extname(pathname).split('?')[0].toLowerCase();
        if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif'].includes(ext)) return ext;
    } catch { /* fallback */ }
    return '.jpg';
}

/**
 * Generate a deterministic filename from the post identifier.
 */
function buildFilename(postIdentifier, imageUrl) {
    const hash = createHash('md5').update(postIdentifier + imageUrl).digest('hex').slice(0, 12);
    const ext = getExtension(imageUrl);
    // Sanitize postIdentifier for filesystem safety
    const safeName = postIdentifier.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
    return `${safeName}_${hash}${ext}`;
}

/**
 * Download image bytes from the browser context (inherits cookies/auth).
 */
async function downloadViaPage(imageUrl, page) {
    const base64 = await page.evaluate(async (url) => {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ab = await res.arrayBuffer();
        const bytes = new Uint8Array(ab);
        let bin = '';
        for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }, imageUrl);
    return Buffer.from(base64, 'base64');
}

/**
 * Download an image and save it to disk.
 *
 * @param {object} params
 * @param {string} params.imageUrl       - source image URL
 * @param {string} params.postIdentifier - unique post ID (used for filename)
 * @param {Date}   params.publishedAt    - post date (used for directory structure)
 * @param {import('playwright').Page} params.page - Playwright page for authenticated fetch
 * @param {string} [params.baseDir='downloads'] - root directory for images
 * @returns {Promise<string>} relative file path (e.g. "downloads/2023/06/shortcode_abc123.jpg")
 */
export async function downloadImage({ imageUrl, postIdentifier, publishedAt, page, baseDir = 'downloads' }) {
    const year = publishedAt ? publishedAt.getUTCFullYear().toString() : 'unknown';
    const month = publishedAt ? String(publishedAt.getUTCMonth() + 1).padStart(2, '0') : '00';
    const dir = join(baseDir, year, month);
    mkdirSync(dir, { recursive: true });

    const filename = buildFilename(postIdentifier, imageUrl);
    const filepath = join(dir, filename);

    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            logger.debug(`Downloading image (attempt ${attempt}): ${imageUrl}`);
            let buffer = await downloadViaPage(imageUrl, page);
            writeFileSync(filepath, buffer);
            const size = buffer.length;
            buffer = null; // release reference for GC
            logger.info(`Saved image: ${filepath} (${(size / 1024).toFixed(1)} KB)`);
            return filepath;
        } catch (err) {
            lastErr = err;
            logger.warn(`Download attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
            if (attempt < MAX_RETRIES) {
                const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }

    throw new Error(`Image download failed after ${MAX_RETRIES} retries: ${lastErr?.message}`);
}
