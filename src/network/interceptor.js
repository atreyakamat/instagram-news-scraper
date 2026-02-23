/**
 * GraphQL Network Interceptor
 *
 * Attaches a page.on('response') listener and intercepts all GraphQL API
 * responses. Parses post edges from any discovered nesting structure using
 * a recursive schema search — no hardcoded field paths required.
 *
 * The interceptor emits posts via a callback so the orchestrator can queue
 * them for download + DB insert while scrolling continues independently.
 */
import { createLogger } from '../logger/index.js';

const logger = createLogger('interceptor');

// ─── GraphQL URL patterns for popular Instagram backends / clones ─────────────
const GQL_URL_PATTERNS = [
    '/graphql',
    '/api/graphql',
    '/graphql/query',
    '/graph/query',
    '/graphql/v1',
    '/api/v1/feed',
    '/api/v2/feed',
    '/query',
];

// ─── Field name hints for post arrays (edge/node GraphQL convention) ──────────
const EDGE_ARRAY_HINTS = [
    'edges', 'nodes', 'items', 'feed_items', 'posts',
    'timeline_media', 'media', 'clips',
];

// ─── Field name hints for individual post node objects ───────────────────────
const POST_NODE_HINTS = ['node', 'media', 'post', 'item'];

// ─── Field names for image URL candidates ────────────────────────────────────
const IMAGE_URL_FIELDS = [
    'display_url', 'display_src', 'image_url', 'url', 'thumbnail_url',
    'thumbnail_src', 'src',
];

// ─── Fields for display_resources array (highest-res) ────────────────────────
const DISPLAY_RESOURCES_FIELDS = ['display_resources', 'image_versions2', 'candidates'];

// ─── Field names for post ID ──────────────────────────────────────────────────
const ID_FIELDS = ['id', 'pk', 'post_id', 'media_id', 'shortcode', 'code'];

// ─── Field names for caption text (user-written first, auto-generated last) ───
// accessibility_caption is Instagram's auto-generated label (e.g. "Photo by..."),
// NOT the user's own caption — keep it only as a last resort.
const CAPTION_FIELDS = [
    'edge_media_to_caption', // { edges: [{ node: { text } }] }  ← most reliable
    'caption',               // string OR { text: '...' }
    'description',           // some third-party feeds
    'text',                  // occasionally flat
    'accessibility_caption', // auto-generated — fallback only
];

// ─── Field names for timestamp ────────────────────────────────────────────────
const TIMESTAMP_FIELDS = [
    'taken_at_timestamp', 'taken_at', 'timestamp', 'created_at',
    'date', 'date_gmt', 'published_at',
];

// ─── Field names for comments ─────────────────────────────────────────────────
const COMMENT_FIELDS = [
    'edge_media_to_comment', 'edge_media_preview_comment',
    'comments', 'preview_comments', 'comment_list',
];

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively search an object for arrays that look like post edge lists.
 * Returns all discovered post-like nodes.
 *
 * @param {any} obj
 * @param {number} depth - max recursion depth to avoid infinite loops
 * @returns {object[]} array of post-like node objects
 */
function findPostNodes(obj, depth = 0) {
    if (depth > 12 || obj === null || typeof obj !== 'object') return [];

    const results = [];

    if (Array.isArray(obj)) {
        // Check if this array looks like a post list
        for (const item of obj) {
            if (item && typeof item === 'object') {
                // Try to unwrap edge/node convention
                const node = POST_NODE_HINTS.reduce((acc, k) => acc || item[k], null);
                const candidate = node || item;

                if (looksLikePost(candidate)) {
                    results.push(candidate);
                } else {
                    results.push(...findPostNodes(item, depth + 1));
                }
            }
        }
        return results;
    }

    for (const [key, value] of Object.entries(obj)) {
        if (EDGE_ARRAY_HINTS.includes(key) && Array.isArray(value)) {
            results.push(...findPostNodes(value, depth + 1));
        } else if (typeof value === 'object') {
            results.push(...findPostNodes(value, depth + 1));
        }
    }

    return results;
}

/**
 * Heuristic check: does this object look like a post?
 */
function looksLikePost(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    const keys = Object.keys(obj);
    // Must have at least an ID-like field AND a timestamp-like field
    const hasId = ID_FIELDS.some(f => keys.includes(f));
    const hasTimestamp = TIMESTAMP_FIELDS.some(f => keys.includes(f));
    const hasImage = IMAGE_URL_FIELDS.some(f => keys.includes(f)) ||
        DISPLAY_RESOURCES_FIELDS.some(f => keys.includes(f));
    return hasId && (hasTimestamp || hasImage);
}

/**
 * Extract the highest-resolution image URL from a post node.
 * Also handles video URLs and video thumbnails.
 */
function extractImageUrl(node) {
    // Prefer display_resources / candidates array (highest res last or first)
    for (const field of DISPLAY_RESOURCES_FIELDS) {
        const arr = node[field];
        if (Array.isArray(arr) && arr.length > 0) {
            // Sort by width descending, take the first
            const sorted = [...arr].sort((a, b) => (b.config_width || b.width || 0) - (a.config_width || a.width || 0));
            const src = sorted[0]?.src || sorted[0]?.url || sorted[0]?.display_url;
            if (src) return src;
        }
        // image_versions2 is often { candidates: [...] }
        if (arr && typeof arr === 'object' && !Array.isArray(arr)) {
            const cands = arr.candidates;
            if (Array.isArray(cands) && cands.length > 0) {
                const sorted = [...cands].sort((a, b) => (b.width || 0) - (a.width || 0));
                const src = sorted[0]?.url || sorted[0]?.src;
                if (src) return src;
            }
        }
    }

    // Video posts — extract video_url or highest-quality version from video_versions
    for (const field of ['video_url', 'video_dash_manifest']) {
        if (typeof node[field] === 'string' && node[field].startsWith('http')) return node[field];
    }
    if (Array.isArray(node.video_versions) && node.video_versions.length > 0) {
        const sorted = [...node.video_versions].sort((a, b) => (b.width || 0) - (a.width || 0));
        const src = sorted[0]?.url;
        if (src) return src;
    }

    // Fallback: first matching direct field
    for (const field of IMAGE_URL_FIELDS) {
        if (typeof node[field] === 'string' && node[field].startsWith('http')) {
            return node[field];
        }
    }
    return null;
}

/**
 * Extract caption text from a post node.
 * Instagram caption formats encountered in the wild:
 *   1. edge_media_to_caption: { edges: [{ node: { text: '...' } }] }
 *   2. caption: '...'  (plain string)
 *   3. caption: { text: '...', created_at: ... }  (object)
 *   4. accessibility_caption: 'Photo by ...'  (auto-generated — last resort)
 */
function extractCaption(node) {
    for (const field of CAPTION_FIELDS) {
        const val = node[field];
        if (!val) continue;

        // Plain string
        if (typeof val === 'string' && val.length > 0) {
            // Skip accessibility_caption if it looks auto-generated
            if (field === 'accessibility_caption' && /^Photo by /i.test(val)) continue;
            return val;
        }

        // edge pattern: { edges: [{ node: { text } }] }
        if (typeof val === 'object' && Array.isArray(val.edges)) {
            const text = val.edges[0]?.node?.text;
            if (text && text.length > 0) return text;
        }

        // object with direct text field: { text: '...', ... }
        if (typeof val === 'object' && typeof val.text === 'string' && val.text.length > 0) {
            return val.text;
        }

        // array of caption objects (some variants)
        if (Array.isArray(val) && val.length > 0) {
            const text = val[0]?.text || val[0]?.content || val[0]?.node?.text;
            if (text) return text;
        }
    }
    return '';
}

/**
 * Extract comments from a post node.
 * Returns [{username, text}]
 */
function extractComments(node) {
    for (const field of COMMENT_FIELDS) {
        const val = node[field];
        if (!val) continue;

        // edge_media_to_comment pattern
        if (val.edges && Array.isArray(val.edges)) {
            return val.edges.map(e => ({
                username: e.node?.owner?.username || e.node?.user?.username || null,
                text: e.node?.text || '',
            })).filter(c => c.text);
        }

        // flat array of comment objects
        if (Array.isArray(val)) {
            return val.map(c => ({
                username: c.user?.username || c.username || c.owner?.username || null,
                text: c.text || c.content || '',
            })).filter(c => c.text);
        }
    }
    return [];
}

/**
 * Extract published timestamp. Returns Date or null.
 */
function extractTimestamp(node) {
    for (const field of TIMESTAMP_FIELDS) {
        const val = node[field];
        if (val == null) continue;

        // Unix seconds
        if (typeof val === 'number') {
            const d = val > 1e10 ? new Date(val) : new Date(val * 1000);
            if (!isNaN(d.getTime())) return d;
        }
        // ISO string
        if (typeof val === 'string') {
            const d = new Date(val);
            if (!isNaN(d.getTime())) return d;
        }
    }
    return null;
}

/**
 * Extract unique post ID.
 */
function extractId(node) {
    for (const field of ID_FIELDS) {
        const val = node[field];
        if (val != null && String(val).length > 0) return String(val);
    }
    return null;
}

/**
 * Extract the best video URL from a post node (highest quality).
 */
function extractVideoUrl(node) {
    // Prefer video_versions array sorted by quality
    if (Array.isArray(node.video_versions) && node.video_versions.length > 0) {
        const sorted = [...node.video_versions].sort((a, b) => (b.width || 0) - (a.width || 0));
        const url = sorted[0]?.url;
        if (url) return url;
    }
    // Direct video_url field
    if (typeof node.video_url === 'string' && node.video_url.startsWith('http')) return node.video_url;
    return null;
}

/**
 * Parse a raw post node into a normalized post object.
 * Returns null if essential fields (id or timestamp) are missing.
 */
function normalizePost(node) {
    const id = extractId(node);
    if (!id) return null;

    // Build Instagram post URL from shortcode/code field when available
    const shortcode = node.shortcode || node.code || null;
    const postUrl = shortcode
        ? `https://www.instagram.com/p/${shortcode}/`
        : null;

    // Detect post type
    const isVideo = !!(node.is_video || node.video_url || node.video_versions);
    const isCarousel = !!(node.carousel_media || node.sidecar_media || node.__typename === 'GraphSidecar');
    const mediaType = isCarousel ? 'carousel' : isVideo ? 'video' : 'image';

    const videoUrl = isVideo ? extractVideoUrl(node) : null;
    // For images use existing extractor; for videos use thumbnail (display_url / poster)
    const imageUrl = extractImageUrl(node);

    return {
        postIdentifier: id,
        postUrl,
        imageUrl,
        videoUrl,
        mediaType,
        captionText: extractCaption(node),
        comments: extractComments(node),
        publishedAt: extractTimestamp(node),
        rawNode: node, // kept briefly for debugging; cleared after processing
    };
}

// ─── Interceptor attachment ───────────────────────────────────────────────────

/**
 * Detect if a response URL looks like a GraphQL endpoint.
 */
function isGraphQLResponse(url, method) {
    if (!url) return false;
    const lc = url.toLowerCase();
    return GQL_URL_PATTERNS.some(p => lc.includes(p)) ||
        (method === 'POST' && (lc.includes('/api/') || lc.includes('/query')));
}

/**
 * Attach a GraphQL response interceptor to the Playwright page.
 *
 * @param {import('playwright').Page} page
 * @param {function(object): void} onPost - called for each discovered post node
 * @returns {{ stop: function }} call stop() to detach the listener
 */
export function attachInterceptor(page, onPost) {
    let responseCount = 0;
    let schemaLogged = false;

    async function handleResponse(response) {
        try {
            const url = response.url();
            const method = response.request().method();

            if (!isGraphQLResponse(url, method)) return;

            // Only process JSON responses
            const contentType = response.headers()['content-type'] || '';
            if (!contentType.includes('json')) return;

            const status = response.status();
            if (status < 200 || status >= 300) return;

            let body;
            try {
                body = await response.json();
            } catch {
                return; // Not valid JSON
            }

            responseCount++;

            // Log the first GraphQL response schema to help identify structure
            if (!schemaLogged) {
                schemaLogged = true;
                logger.info(`[interceptor] First GraphQL response from: ${url}`);
                logger.info(`[interceptor] Top-level keys: ${Object.keys(body || {}).join(', ')}`);
                // Log structure summary (not full body to avoid log bloat)
                logStructure(body, 0, 3);
            }

            // Discover post nodes recursively
            const nodes = findPostNodes(body);
            if (nodes.length === 0) return;

            logger.info(`[interceptor] GraphQL response #${responseCount}: ${nodes.length} post node(s) found from ${url}`);

            for (const node of nodes) {
                const post = normalizePost(node);
                if (!post) continue;

                // Carousel post — emit each slide as a separate row (same caption/date, unique image)
                const carouselSlides = node.carousel_media || node.sidecar_media;
                if (Array.isArray(carouselSlides) && carouselSlides.length > 1) {
                    logger.info(`[interceptor] Carousel post ${post.postIdentifier}: ${carouselSlides.length} slides`);
                    carouselSlides.forEach((slide, idx) => {
                        const slideIsVideo = !!(slide.is_video || slide.video_url || slide.video_versions);
                        onPost({
                            ...post,
                            postIdentifier: `${post.postIdentifier}_c${idx + 1}`,
                            imageUrl: extractImageUrl(slide) || post.imageUrl,
                            videoUrl: slideIsVideo ? extractVideoUrl(slide) : null,
                            mediaType: slideIsVideo ? 'video' : 'image',
                            // caption always inherited from parent carousel post
                            rawNode: undefined,
                        });
                    });
                } else {
                    onPost(post);
                }
            }
        } catch (err) {
            logger.debug(`[interceptor] Response handling error: ${err.message}`);
        }
    }

    page.on('response', handleResponse);

    return {
        stop: () => page.off('response', handleResponse),
    };
}

/**
 * Log a structural summary of a JSON object (keys + types, not values).
 */
function logStructure(obj, depth, maxDepth) {
    if (depth >= maxDepth || obj === null || typeof obj !== 'object') return;
    const indent = '  '.repeat(depth);
    for (const [k, v] of Object.entries(Array.isArray(obj) ? { '[0]': obj[0] } : obj)) {
        const type = Array.isArray(v) ? `Array[${v.length}]` : typeof v;
        logger.debug(`${indent}${k}: ${type}`);
        if (typeof v === 'object' && v !== null && depth < maxDepth - 1) {
            logStructure(v, depth + 1, maxDepth);
        }
    }
}
