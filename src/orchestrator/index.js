import { createLogger } from '../logger/index.js';
import {
    initDb,
    createSession,
    finalizeSession,
    insertPost,
    getLatestPublishedAt,
    getPostDateRange,
} from '../database/index.js';
import { launchBrowser, navigateTo, closeBrowser } from '../browser/index.js';
import { scrollUntilExhausted, INSTAGRAM_POST_SELECTOR } from '../scroll/controller.js';
import { extractPost, getPostDateFromHandle, isWithinRange } from '../extractor/index.js';
import { fetchImageAsBase64 } from '../image/processor.js';
import { queryWithRetry } from '../vision/client.js';
import { createWorkerPool, enqueuePost, drainQueue } from '../queue/worker.js';

const logger = createLogger('orchestrator');

/**
 * Main orchestrator — wires all modules together.
 *
 * @param {object} options
 * @param {string} options.url
 * @param {Date}   options.startDate
 * @param {Date}   options.endDate
 * @param {string} options.dbPath
 * @param {string} options.ollamaUrl
 * @param {string} options.ollamaModel
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
        dbPath,
        ollamaUrl,
        ollamaModel,
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
        inferenceSuccesses: 0,
        inferenceFails: 0,
    };

    // ── In-memory dedup set ───────────────────────────────────────────────────
    const processedIds = new Set();

    // ── Database ──────────────────────────────────────────────────────────────
    const db = initDb(dbPath);

    // Resumable: find latest already-stored date to skip re-processing
    const latestStoredDate = getLatestPublishedAt(db);
    if (latestStoredDate) {
        logger.info(`Resuming: latest stored post date is ${latestStoredDate.toISOString()}`);
    }

    const sessionId = createSession(db, {
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
     * Per-post job: vision inference → SQLite insert
     */
    async function processPost(postData) {
        const inferenceStart = Date.now();
        let extractedImageText = null;

        if (postData.imageUrl) {
            try {
                logger.info(`[${postData.postIdentifier.slice(0, 10)}] Downloading + inferring image...`);
                const base64 = await fetchImageAsBase64(postData.imageUrl, page);
                extractedImageText = await queryWithRetry(base64, ollamaModel, ollamaUrl);
                stats.inferenceSuccesses++;
                logger.info(
                    `[${postData.postIdentifier.slice(0, 10)}] Inference done in ${Date.now() - inferenceStart}ms`
                );
            } catch (err) {
                stats.inferenceFails++;
                stats.errors++;
                logger.error(`[${postData.postIdentifier.slice(0, 10)}] Inference failed: ${err.message}`);
            }
        } else {
            logger.warn(`[${postData.postIdentifier.slice(0, 10)}] No image URL — skipping vision`);
        }

        try {
            const inserted = insertPost(db, sessionId, {
                ...postData,
                sourceUrl: url,
                extractedImageText,
            });
            if (inserted) {
                stats.processed++;
                logger.info(
                    `[${postData.postIdentifier.slice(0, 10)}] Stored | published: ${postData.publishedAt?.toISOString()}`
                );
            } else {
                logger.debug(`[${postData.postIdentifier.slice(0, 10)}] DB duplicate — skipped`);
            }
        } catch (err) {
            stats.errors++;
            logger.error(`[${postData.postIdentifier.slice(0, 10)}] DB insert error: ${err.message}`);
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
                `Scroll batch: ${handles.length} new post(s) | total discovered: ${stats.discovered} | queue depth: ${queue.size}`
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
                    logger.debug(`In-memory dup: ${postData.postIdentifier.slice(0, 10)}`);
                    continue;
                }
                processedIds.add(postData.postIdentifier);

                // Date missing
                if (!postData.publishedAt) {
                    logger.warn(`No date for post ${postData.postIdentifier.slice(0, 10)} — skipping`);
                    stats.skipped++;
                    continue;
                }

                // Date range filter
                if (!isWithinRange(postData.publishedAt, startDate, endDate)) {
                    logger.debug(
                        `Out of range (${postData.publishedAt.toISOString()}) — skipping`
                    );
                    stats.skipped++;
                    continue;
                }

                // Resumable: skip already-archived posts
                if (latestStoredDate && postData.publishedAt <= latestStoredDate) {
                    logger.debug(`Already archived — skipping`);
                    stats.skipped++;
                    continue;
                }

                // Enqueue for async vision + DB processing
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
    logger.info(`Scroll complete. Draining worker queue (${queue.size} remaining)...`);
    await drainQueue(queue);

    // ── Finalize session ──────────────────────────────────────────────────────
    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    finalizeSession(db, sessionId, {
        processed: stats.processed,
        skipped: stats.skipped,
        errors: stats.errors,
        durationSeconds,
    });

    await closeBrowser(browser);

    // ── Final summary ─────────────────────────────────────────────────────────
    const dateRange = getPostDateRange(db, sessionId);
    db.close();

    const summary = {
        dateRangeApplied: `${startDate.toISOString().slice(0, 10)} → ${endDate.toISOString().slice(0, 10)}`,
        totalPostsScanned: stats.discovered,
        totalPostsStored: stats.processed,
        totalPostsSkipped: stats.skipped,
        oldestStoredPost: dateRange.oldest?.toISOString() || 'N/A',
        newestStoredPost: dateRange.newest?.toISOString() || 'N/A',
        visionInferenceSuccesses: stats.inferenceSuccesses,
        visionInferenceFails: stats.inferenceFails,
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
