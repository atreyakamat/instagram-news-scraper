import { createLogger } from '../logger/index.js';

const logger = createLogger('image-processor');

/**
 * Download an image into a Buffer using the browser's fetch (inherits cookies/auth).
 *
 * @param {string} imageUrl
 * @param {import('playwright').Page} page
 * @returns {Promise<Buffer>}
 */
export async function downloadImageToBuffer(imageUrl, page) {
    logger.debug(`Downloading image: ${imageUrl}`);

    // Use browser context fetch to inherit session cookies
    const response = await page.evaluate(async (url) => {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching image`);
        const arrayBuffer = await res.arrayBuffer();
        // Convert to base64 inside browser to avoid transferring binary
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }, imageUrl);

    // response is already base64 — convert back to Buffer for consistency
    const buffer = Buffer.from(response, 'base64');
    logger.debug(`Downloaded image: ${buffer.length} bytes`);
    return buffer;
}

/**
 * Convert a Buffer to a base64 string.
 * @param {Buffer} buffer
 * @returns {string}
 */
export function bufferToBase64(buffer) {
    return buffer.toString('base64');
}

/**
 * Download image and immediately return base64 string.
 * Clears the buffer reference after conversion to aid GC.
 *
 * @param {string} imageUrl
 * @param {import('playwright').Page} page
 * @returns {Promise<string>} base64-encoded image
 */
export async function fetchImageAsBase64(imageUrl, page) {
    let buffer = await downloadImageToBuffer(imageUrl, page);
    const b64 = bufferToBase64(buffer);
    buffer = null; // release reference
    return b64;
}
