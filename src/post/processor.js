/**
 * Post Processor
 *
 * Receives raw normalized post objects from the GraphQL interceptor,
 * applies date range filtering, deduplication (in-memory Set),
 * and pushes qualifying posts into the worker queue.
 */
import { createLogger } from '../logger/index.js';

const logger = createLogger('post-processor');

export class PostProcessor {
    /**
     * @param {object} opts
     * @param {Date} opts.startDate
     * @param {Date} opts.endDate
     * @param {Date|null} opts.latestStoredDate - for resumable scraping
     * @param {function(object): void} opts.onValidPost - called for each in-range post
     */
    constructor({ startDate, endDate, latestStoredDate, keywords = [], onValidPost }) {
        this.startDate = startDate;
        this.endDate = endDate;
        this.latestStoredDate = latestStoredDate;
        // Lowercase for case-insensitive matching
        this.keywords = keywords.map(k => k.toLowerCase());
        this.onValidPost = onValidPost;

        this.seenIds = new Set();
        this.stats = {
            total: 0,
            inRange: 0,
            skipped: 0,
            tooOld: 0,
            tooNew: 0,
            noDate: 0,
            noDup: 0,
            noKeyword: 0,
        };

        // Track whether any post in the latest batch was below the start date
        // (used for boundary termination signaling)
        this._belowBoundary = false;
    }

    /**
     * Process a single incoming post from the interceptor.
     * @param {object} post - normalized post from interceptor
     * @returns {boolean} true if the post was queued for processing
     */
    process(post) {
        this.stats.total++;
        this._belowBoundary = false;

        // ── Deduplication ─────────────────────────────────────────────────────
        if (this.seenIds.has(post.postIdentifier)) {
            this.stats.noDup++;
            logger.debug(`Duplicate: ${post.postIdentifier}`);
            return false;
        }
        this.seenIds.add(post.postIdentifier);

        // ── No date ───────────────────────────────────────────────────────────
        if (!post.publishedAt) {
            this.stats.noDate++;
            logger.warn(`No date for post ${post.postIdentifier} — skipping`);
            return false;
        }

        const ts = post.publishedAt;

        // ── Too new ───────────────────────────────────────────────────────────
        if (ts > this.endDate) {
            this.stats.tooNew++;
            this.stats.skipped++;
            logger.debug(`Too new (${ts.toISOString()}) — skipping`);
            return false;
        }

        // ── Too old ───────────────────────────────────────────────────────────
        if (ts < this.startDate) {
            this.stats.tooOld++;
            this.stats.skipped++;
            this._belowBoundary = true;
            logger.debug(`Too old (${ts.toISOString()}) — below start boundary`);
            return false;
        }

        // ── Resumable: already archived ───────────────────────────────────────
        if (this.latestStoredDate && ts <= this.latestStoredDate) {
            this.stats.skipped++;
            logger.debug(`Already archived — skipping`);
            return false;
        }

        // ── Keyword filter ────────────────────────────────────────────────────
        if (this.keywords.length > 0) {
            const haystack = (post.captionText || '').toLowerCase();
            const matched = this.keywords.some(kw => haystack.includes(kw));
            if (!matched) {
                this.stats.noKeyword++;
                this.stats.skipped++;
                logger.debug(`Keyword filter: no match for ${post.postIdentifier}`);
                return false;
            }
            logger.debug(`Keyword matched for ${post.postIdentifier}`);
        }

        // ── Valid post ────────────────────────────────────────────────────────
        this.stats.inRange++;
        logger.info(`Valid post: ${post.postIdentifier} | ${ts.toISOString()}`);
        this.onValidPost(post);
        return true;
    }

    /**
     * Was the most recent processed post below the start date boundary?
     * Used by the orchestrator to decide whether to stop scrolling.
     */
    get belowBoundary() {
        return this._belowBoundary;
    }

    /**
     * Total unique posts seen (regardless of filter outcome).
     */
    get uniqueSeen() {
        return this.seenIds.size;
    }

    logSummary() {
        logger.info(`Post processor summary: total=${this.stats.total} inRange=${this.stats.inRange} tooOld=${this.stats.tooOld} tooNew=${this.stats.tooNew} noDate=${this.stats.noDate} dup=${this.stats.noDup} keywordFiltered=${this.stats.noKeyword}`);
    }
}
