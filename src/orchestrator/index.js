import { createLogger } from '../logger/index.js';
import { connectDb, initCollections, createSession, finalizeSession, insertPost, getLatestPublishedAt, getPostDateRange } from '../database/index.js';
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
 * @param {Date} options.startDate
 * @param {Date} options.endDate
 * @param {string} options.mongoUri
 * @param {string} options.dbName
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
        mongoUri,
        dbName,
        ollamaUrl,
        ollamaModel,
        workers,
        authStatePath,
        headless,
        postSelector,
    } = options;

    const startTime = Date.now();

    // ── Stats tracking ────────────────────────────────────────────────────────
    const stats = {
        discovered: 0,
        processed: 0,
        skipped: 0,
        errors: 0,
        inferenceSuccesses: 0,
        inferenceFails: 0,
    };

    // ── In-memory deduplication set ───────────────────────────────────────────
    const processedIds = new Set();

    // ── Database setup ────────────────────────────────────────────────────────
    logger.info('Connecting to MongoDB...');
    const { client, db } = await connectDb(mongoUri, dbName);
    await initCollections(db);

    // Resumable scraping: check if we have a previous latest date
    const latestStoredDate = await getLatestPublishedAt(db);
    if (latestStoredDate) {
        logger.info(`Resuming: latest stored post date is ${latestStoredDate.toISOString()}`);
    }

    const sessionId = await createSession(db, {
        sourceUrl: url,
        startDateFilter: startDate.toISOString().slice(0, 10),
        endDateFilter: endDate.toISOString().slice(0, 10),
    });

    // ── Browser setup ─────────────────────────────────────────────────────────
    logger.info('Launching browser...');
    const { browser, page } = await launchBrowser({ headless, authStatePath });
    await navigateTo(page, url);

    // ── Worker pool ───────────────────────────────────────────────────────────
    const queue = createWorkerPool(workers);

    /**
     * Process a single post: vision inference + DB insert
     */
    async function processPost(postData) {
        const inferenceStart = Date.now();
        let extractedImageText = null;

        if (postData.imageUrl) {
            try {
                logger.info(`Processing image for post ${postData.postIdentifier.slice(0, 8)}...`);
                const base64 = await fetchImageAsBase64(postData.imageUrl, page);
                extractedImageText = await queryWithRetry(base64, ollamaModel, ollamaUrl);
                stats.inferenceSuccesses++;
                const inferenceMs = Date.now() - inferenceStart;
                logger.info(
                    `Vision inference complete in ${inferenceMs}ms for post ${postData.postIdentifier.slice(0, 8)}`
                );
            } catch (err) {
                stats.inferenceFails++;
                stats.errors++;
                logger.error(`Vision inference failed for ${postData.postIdentifier.slice(0, 8)}: ${err.message}`);
            }
        } else {
            logger.warn(`No image URL for post ${postData.postIdentifier.slice(0, 8)}, skipping vision`);
        }

        try {
            const wasInserted = await insertPost(db, sessionId, {
                ...postData,
                sourceUrl: url,
                extractedImageText,
            });

            if (wasInserted) {
                stats.processed++;
                logger.info(
                    `Stored post ${postData.postIdentifier.slice(0, 8)} | published: ${postData.publishedAt?.toISOString()}`
                );
            } else {
                logger.debug(`Duplicate post skipped in DB: ${postData.postIdentifier.slice(0, 8)}`);
            }
        } catch (err) {
            stats.errors++;
            logger.error(`DB insert failed for ${postData.postIdentifier.slice(0, 8)}: ${err.message}`);
        }
    }

    // ── Scroll + extract loop ─────────────────────────────────────────────────
    // Use Instagram's <article> selector by default; allow CLI override for non-standard layouts
    const selector = postSelector || INSTAGRAM_POST_SELECTOR;
    logger.info(`Using post selector: "${selector}"`);
    logger.info(`Date range: ${startDate.toISOString().slice(0, 10)} → ${endDate.toISOString().slice(0, 10)}`);

    try {
        const scrollGen = scrollUntilExhausted(page, {
            postSelector: selector,
            startDate,
            getPostDate: getPostDateFromHandle,
        });

        for await (const { handles, reachedOldBoundary } of scrollGen) {
            logger.info(`Scroll batch: ${handles.length} new post(s) found`);
            stats.discovered += handles.length;

            for (const handle of handles) {
                let postData;
                try {
                    postData = await extractPost(handle, page);
                } catch (err) {
                    logger.warn(`Extraction failed for a post handle: ${err.message}`);
                    stats.errors++;
                    continue;
                }

                // In-memory dedup
                if (processedIds.has(postData.postIdentifier)) {
                    logger.debug(`In-memory duplicate: ${postData.postIdentifier.slice(0, 8)}`);
                    continue;
                }
                processedIds.add(postData.postIdentifier);

                // Date range filter
                if (!postData.publishedAt) {
                    logger.warn(`Could not parse date for post ${postData.postIdentifier.slice(0, 8)}, skipping`);
                    stats.skipped++;
                    continue;
                }

                if (!isWithinRange(postData.publishedAt, startDate, endDate)) {
                    logger.debug(
                        `Post ${postData.postIdentifier.slice(0, 8)} out of range (${postData.publishedAt.toISOString()}), skipping`
                    );
                    stats.skipped++;
                    continue;
                }

                // Resumable: skip posts already stored from a previous run
                if (latestStoredDate && postData.publishedAt <= latestStoredDate) {
                    logger.debug(`Post already archived (before latest stored date), skipping`);
                    stats.skipped++;
                    continue;
                }

                // Enqueue for vision + DB processing
                enqueuePost(queue, postData, processPost);
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
    logger.info('Scroll complete. Waiting for all workers to finish...');
    await drainQueue(queue);

    // ── Finalize ──────────────────────────────────────────────────────────────
    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    await finalizeSession(db, sessionId, {
        processed: stats.processed,
        skipped: stats.skipped,
        errors: stats.errors,
        durationSeconds,
    });

    await closeBrowser(browser);
    await client.close();

    // ── Summary ───────────────────────────────────────────────────────────────
    const dateRange = await getPostDateRange(db, sessionId).catch(() => ({ oldest: null, newest: null }));

    // Re-open connection briefly to get date range
    const { client: c2, db: db2 } = await connectDb(mongoUri, dbName);
    const finalDateRange = await getPostDateRange(db2, sessionId);
    await c2.close();

    const summary = {
        dateRangeApplied: `${startDate.toISOString().slice(0, 10)} → ${endDate.toISOString().slice(0, 10)}`,
        totalPostsScanned: stats.discovered,
        totalPostsStored: stats.processed,
        totalPostsSkipped: stats.skipped,
        oldestStoredPost: finalDateRange.oldest?.toISOString() || 'N/A',
        newestStoredPost: finalDateRange.newest?.toISOString() || 'N/A',
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
