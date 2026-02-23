/**
 * Image Downloader
 *
 * Downloads images via direct HTTP (axios) rather than browser fetch,
 * so it works in parallel worker threads independently of the page lifecycle.
 * Stores files under downloads/<year>/<month>/<post_id>.ext
 * Retries up to MAX_RETRIES times with exponential backoff.
 */
import axios from 'axios';
import { mkdirSync, writeFileSync } from 'fs';
import { join, extname } from 'path';
import { createLogger } from '../logger/index.js';

const logger = createLogger('downloader');

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1200;

/**
 * Determine file extension from URL, defaulting to .jpg.
 */
function getExtension(imageUrl) {
    try {
        const pathname = new URL(imageUrl).pathname.split('?')[0];
        const ext = extname(pathname).toLowerCase();
        if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.mp4', '.mov', '.webm', '.m4v'].includes(ext)) return ext;
    } catch { /* ignore */ }
    // If the URL contains video CDN patterns, default to .mp4
    if (/video|\.mp4|cdninstagram.*v=/.test(imageUrl)) return '.mp4';
    return '.jpg';
}

/**
 * Download an image and save it to disk.
 *
 * @param {object} opts
 * @param {string} opts.imageUrl
 * @param {string} opts.postIdentifier  - used as the filename
 * @param {Date|null} opts.publishedAt  - determines directory (year/month)
 * @param {string} [opts.baseDir='downloads']
 * @param {string|null} [opts.authCookies] - optional Cookie header value
 * @returns {Promise<string>} relative file path (e.g. downloads/2023/06/ABC123.jpg)
 */
export async function downloadImage({
    imageUrl,
    postIdentifier,
    publishedAt,
    baseDir = 'downloads',
    authCookies = null,
}) {
    const year = publishedAt ? publishedAt.getUTCFullYear().toString() : 'unknown';
    const month = publishedAt ? String(publishedAt.getUTCMonth() + 1).padStart(2, '0') : '00';
    const dir = join(baseDir, year, month);
    mkdirSync(dir, { recursive: true });

    // Sanitize postIdentifier for filesystem safety
    const safeName = postIdentifier.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    const ext = getExtension(imageUrl);
    const filename = `${safeName}${ext}`;
    const filepath = join(dir, filename);

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': 'https://www.instagram.com/',
    };
    if (authCookies) headers['Cookie'] = authCookies;

    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            logger.debug(`Downloading (attempt ${attempt}): ${imageUrl}`);
            const response = await axios.get(imageUrl, {
                responseType: 'arraybuffer',
                headers,
                timeout: 30000,
            });

            writeFileSync(filepath, response.data);
            const kb = (response.data.byteLength / 1024).toFixed(1);
            logger.info(`Saved: ${filepath} (${kb} KB)`);
            return filepath;
        } catch (err) {
            lastErr = err;
            const code = err.response?.status || err.code;
            logger.warn(`Download attempt ${attempt}/${MAX_RETRIES} failed [${code}]: ${err.message}`);
            if (attempt < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, BASE_DELAY_MS * Math.pow(2, attempt - 1)));
            }
        }
    }

    throw new Error(`Image download failed after ${MAX_RETRIES} retries: ${lastErr?.message}`);
}
