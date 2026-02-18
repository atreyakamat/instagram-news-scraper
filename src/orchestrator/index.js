/**
 * Orchestrator — main pipeline controller.
 *
 * Coordinates: MySQL → Playwright → scroll → extract → download image → insert DB.
 * No vision/AI processing in this version.
 */
import { createLogger } from '../logger/index.js';
import {
    initDb,
    createSession,
    finalizeSession,
    insertPost,
    getLatestPublishedAt,
    getPostDateRange,
    closeDb,
} from '../database/index.js';
import { launchBrowser, navigateTo, closeBrowser } from '../browser/index.js';
import { scrollUntilExhausted, INSTAGRAM_POST_SELECTOR } from '../scroll/controller.js';
import { extractPost, getPostDateFromHandle, isWithinRange } from '../extractor/index.js';
import { downloadImage } from '../image/processor.js';
import { createWorkerPool, enqueuePost, drainQueue } from '../queue/worker.js';

const logger = createLogger('orchestrator');

/**
 * @param {object} options
 * @param {string} options.url
 * @param {Date}   options.startDate
 * @param {Date}   options.endDate
 * @param {object} options.mysql        - { host, port, user, password, database }
 * @param {number} options.workers
 * @param {string|null} options.authStatePath
 * @param {boolean} options.headless
 * @param {string|null} options.postSelector
 */
export async function run(options) {
    const {
        url,
        startDate,
        endDate,
        mysql: mysqlConf,
        workers,
        authStatePath,
        headless,
        postSelector,
    } = options;

    const startTime = Date.now();

    // ── Stats ─────────────────────────────────────────────────────────────────
    const stats = {
        discovered: 0,
        processed: 0,
        skipped: 0,
        errors: 0,
        imagesDownloaded: 0,
        imagesFailed: 0,
    };

    // ── In-memory dedup ───────────────────────────────────────────────────────
    const processedIds = new Set();

    // ── MySQL ─────────────────────────────────────────────────────────────────
    logger.info('Connecting to MySQL...');
    const pool = await initDb(mysqlConf);

    // Resumable: skip already-archived posts
    const latestStoredDate = await getLatestPublishedAt(pool);
    if (latestStoredDate) {
        logger.info(`Resuming: latest stored post date is ${latestStoredDate.toISOString()}`);
    }

    const sessionId = await createSession(pool, {
        sourceUrl: url,
        startDateFilter: startDate.toISOString().slice(0, 10),
        endDateFilter: endDate.toISOString().slice(0, 10),
    });

    // ── Browser ───────────────────────────────────────────────────────────────
    logger.info('Launching browser...');
    const { browser, page } = await launchBrowser({ headless, authStatePath });
    await navigateTo(page, url);

    // ── Worker pool ───────────────────────────────────────────────────────────
    const queue = createWorkerPool(workers);

    /**
     * Per-post job: download image → insert into MySQL
     */
    async function processPost(postData) {
        let imagePath = null;

        // Download image to disk
        if (postData.imageUrl) {
            try {
                imagePath = await downloadImage({
                    imageUrl: postData.imageUrl,
                    postIdentifier: postData.postIdentifier,
                    publishedAt: postData.publishedAt,
                    page,
                });
                stats.imagesDownloaded++;
            } catch (err) {
                stats.imagesFailed++;
                stats.errors++;
                logger.error(`[${postData.postIdentifier.slice(0, 12)}] Image download failed: ${err.message}`);
            }
        } else {
            logger.warn(`[${postData.postIdentifier.slice(0, 12)}] No image URL — skipping download`);
        }

        // Insert into MySQL
        try {
            const inserted = await insertPost(pool, sessionId, {
                ...postData,
                imagePath,
            });
            if (inserted) {
                stats.processed++;
                logger.info(
                    `[${postData.postIdentifier.slice(0, 12)}] Stored | published: ${postData.publishedAt?.toISOString()} | image: ${imagePath || 'N/A'}`
                );
            } else {
                logger.debug(`[${postData.postIdentifier.slice(0, 12)}] DB duplicate — skipped`);
            }
        } catch (err) {
            stats.errors++;
            logger.error(`[${postData.postIdentifier.slice(0, 12)}] DB insert error: ${err.message}`);
        }
    }

    // ── Scroll + extract loop ─────────────────────────────────────────────────
    const selector = postSelector || INSTAGRAM_POST_SELECTOR;
    logger.info(`Post selector: "${selector}"`);
    logger.info(`Date range: ${startDate.toISOString().slice(0, 10)} → ${endDate.toISOString().slice(0, 10)}`);

    try {
        const scrollGen = scrollUntilExhausted(page, {
            postSelector: selector,
            startDate,
            getPostDate: getPostDateFromHandle,
        });

        for await (const { handles, reachedOldBoundary } of scrollGen) {
            stats.discovered += handles.length;
            logger.info(
                `Scroll batch: ${handles.length} new post(s) | total: ${stats.discovered} | queue: ${queue.size}`
            );

            for (const handle of handles) {
                // Extract DOM data
                let postData;
                try {
                    postData = await extractPost(handle, page);
                } catch (err) {
                    logger.warn(`Extraction error: ${err.message}`);
                    stats.errors++;
                    continue;
                }

                // In-memory dedup
                if (processedIds.has(postData.postIdentifier)) {
                    logger.debug(`Dup: ${postData.postIdentifier.slice(0, 12)}`);
                    continue;
                }
                processedIds.add(postData.postIdentifier);

                // Date missing
                if (!postData.publishedAt) {
                    logger.warn(`No date for ${postData.postIdentifier.slice(0, 12)} — skipping`);
                    stats.skipped++;
                    continue;
                }

                // Date range filter
                if (!isWithinRange(postData.publishedAt, startDate, endDate)) {
                    logger.debug(`Out of range (${postData.publishedAt.toISOString()}) — skipping`);
                    stats.skipped++;
                    continue;
                }

                // Resumable: skip already-archived
                if (latestStoredDate && postData.publishedAt <= latestStoredDate) {
                    logger.debug(`Already archived — skipping`);
                    stats.skipped++;
                    continue;
                }

                // Enqueue for download + DB insert
                enqueuePost(queue, { ...postData, sourceUrl: url }, processPost);
            }

            if (reachedOldBoundary) {
                logger.info('Date boundary reached — stopping scroll');
                break;
            }
        }
    } catch (err) {
        logger.error(`Scroll loop error: ${err.message}`, { stack: err.stack });
        stats.errors++;
    }

    // ── Drain queue ───────────────────────────────────────────────────────────
    logger.info(`Scroll complete. Draining queue (${queue.size} remaining)...`);
    await drainQueue(queue);

    // ── Finalize ──────────────────────────────────────────────────────────────
    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    await finalizeSession(pool, sessionId, {
        processed: stats.processed,
        skipped: stats.skipped,
        errors: stats.errors,
        durationSeconds,
    });

    await closeBrowser(browser);

    // ── Summary ───────────────────────────────────────────────────────────────
    const dateRange = await getPostDateRange(pool, sessionId);
    await closeDb(pool);

    const summary = {
        dateRangeApplied: `${startDate.toISOString().slice(0, 10)} → ${endDate.toISOString().slice(0, 10)}`,
        totalPostsScanned: stats.discovered,
        totalPostsStored: stats.processed,
        totalPostsSkipped: stats.skipped,
        imagesDownloaded: stats.imagesDownloaded,
        imagesFailed: stats.imagesFailed,
        oldestStoredPost: dateRange.oldest?.toISOString() || 'N/A',
        newestStoredPost: dateRange.newest?.toISOString() || 'N/A',
        totalErrors: stats.errors,
        totalRuntimeSeconds: durationSeconds,
    };

    logger.info('═══════════════════════════════════════════════════');
    logger.info('                 SCRAPE COMPLETE                   ');
    logger.info('═══════════════════════════════════════════════════');
    Object.entries(summary).forEach(([k, v]) => logger.info(`  ${k}: ${v}`));
    logger.info('═══════════════════════════════════════════════════');

    return summary;
}
