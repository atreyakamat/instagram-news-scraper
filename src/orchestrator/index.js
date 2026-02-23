/**
 * Orchestrator v4 — GraphQL Interception Pipeline
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
import { attachInterceptor } from '../network/interceptor.js';
import { driveScroll } from '../scroll/controller.js';
import { PostProcessor } from '../post/processor.js';
import { downloadImage } from '../image/downloader.js';
import PQueue from 'p-queue';

const logger = createLogger('orchestrator');

export async function run(opts) {
    const {
        url,
        startDate,
        endDate,
        mysql: mysqlConf,
        workers,
        authStatePath,
        headless,
        keywords = [],
    } = opts;

    const startTime = Date.now();

    const stats = {
        processed: 0,
        skipped: 0,
        errors: 0,
        images: 0,
        imageFails: 0,
    };

    let totalIntercepted = 0;

    // ── MySQL ─────────────────────────────────────────
    logger.info('Connecting to MySQL...');
    const pool = await initDb(mysqlConf);

    const latestStored = await getLatestPublishedAt(pool, url);
    if (latestStored) {
        logger.info(`Resuming: latest stored post at ${latestStored.toISOString()}`);
    }

    const sessionId = await createSession(pool, {
        sourceUrl: url,
        startDateFilter: startDate.toISOString().slice(0, 10),
        endDateFilter: endDate.toISOString().slice(0, 10),
    });

    // ── Worker Pool ───────────────────────────────────
    const queue = new PQueue({ concurrency: workers });

    queue.on('error', (err) => {
        logger.error(`Worker pool error: ${err.message}`);
        stats.errors++;
    });

    let pendingNewPosts = 0;
    let dateBoundaryHit = false;

    const processor = new PostProcessor({
        startDate,
        endDate,
        latestStoredDate: latestStored,
        keywords,
        onValidPost: (post) => {
            pendingNewPosts++;

            queue.add(async () => {
                let imagePath = null;

                const downloadUrl = post.videoUrl || post.imageUrl;

                if (downloadUrl) {
                    try {
                        imagePath = await downloadImage({
                            imageUrl: downloadUrl,
                            postIdentifier: post.postIdentifier,
                            publishedAt: post.publishedAt,
                        });
                        stats.images++;
                    } catch (err) {
                        stats.imageFails++;
                        stats.errors++;
                        logger.error(
                            `Media download failed [${post.postIdentifier}]: ${err.message}`
                        );
                    }
                }

                try {
                    const inserted = await insertPost(pool, sessionId, {
                        ...post,
                        sourceUrl: url,
                        imagePath,
                    });

                    if (inserted) {
                        stats.processed++;
                        const captionPreview = (post.captionText || '')
                            .slice(0, 60)
                            .replace(/\n/g, ' ');

                        logger.info(
                            `Stored [${post.postIdentifier}] | ${post.mediaType || 'image'} | ${post.publishedAt.toISOString()} | "${captionPreview}" | file: ${imagePath || 'N/A'}`
                        );
                    }
                } catch (err) {
                    stats.errors++;
                    logger.error(
                        `DB insert failed [${post.postIdentifier}]: ${err.message}`
                    );
                }

                delete post.rawNode;
            });
        },
    });

    // ── Browser ───────────────────────────────────────
    logger.info('Launching browser...');
    const { browser, page } = await launchBrowser({
        headless,
        authStatePath,
    });

    const interceptor = attachInterceptor(page, (post) => {
        totalIntercepted++;
        const wasValid = processor.process(post);

        if (!wasValid && processor.belowBoundary) {
            dateBoundaryHit = true;
        }
    });

    try {
        await navigateTo(page, url);
    } catch (err) {
        logger.error(`Navigation failed: ${err.message}`);
        interceptor.stop();
        await closeBrowser(browser);
        await closeDb(pool);
        throw err;
    }

    logger.info(`Scraping: ${url}`);
    logger.info(
        `Date range: ${startDate.toISOString().slice(0, 10)} → ${endDate
            .toISOString()
            .slice(0, 10)}`
    );
    logger.info(`Workers: ${workers}`);
    logger.info(
        `Keywords: ${keywords.length > 0 ? keywords.join(', ') : '(all posts)'}`
    );

    // ── Scroll Loop ───────────────────────────────────
    const scroller = driveScroll(page);
    await scroller.next();

    let lastBatchIntercepted = 0;

    while (true) {
        const hadNewData = totalIntercepted > lastBatchIntercepted;
        lastBatchIntercepted = totalIntercepted;

        const batchStartPending = pendingNewPosts;

        const { value, done } = await scroller.next(hadNewData);
        if (done) break;

        const newInBatch = pendingNewPosts - batchStartPending;

        logger.info(
            `Scroll #${value.iteration}: ${newInBatch} new post(s) queued | total valid: ${processor.stats.inRange} | intercepted: ${totalIntercepted} | queue: ${queue.size}`
        );

        if (dateBoundaryHit) {
            logger.info('Date boundary hit — stopping scroll');
            break;
        }
    }

    // ── Drain Queue ───────────────────────────────────
    logger.info(
        `Scroll complete. Draining worker queue (${queue.size} remaining)...`
    );
    await queue.onIdle();
    logger.info('Queue drained');

    // ── Cleanup ───────────────────────────────────────
    interceptor.stop();
    await closeBrowser(browser);

    processor.logSummary();

    const duration = Math.round((Date.now() - startTime) / 1000);

    await finalizeSession(pool, sessionId, {
        processed: stats.processed,
        skipped: processor.stats.skipped,
        errors: stats.errors,
        durationSeconds: duration,
    });

    const dateRange = await getPostDateRange(pool, sessionId);
    await closeDb(pool);

    const summary = {
        dateRangeApplied: `${startDate
            .toISOString()
            .slice(0, 10)} → ${endDate.toISOString().slice(0, 10)}`,
        totalPostsSeen: processor.uniqueSeen,
        totalPostsStored: stats.processed,
        totalPostsSkipped: processor.stats.skipped,
        imagesDownloaded: stats.images,
        imagesFailed: stats.imageFails,
        oldestStoredPost: dateRange.oldest?.toISOString() || 'N/A',
        newestStoredPost: dateRange.newest?.toISOString() || 'N/A',
        totalErrors: stats.errors,
        runtimeSeconds: duration,
    };

    logger.info('════════════════════════════════════════════════════');
    logger.info('                  SCRAPE COMPLETE                   ');
    logger.info('════════════════════════════════════════════════════');
    Object.entries(summary).forEach(([k, v]) =>
        logger.info(`  ${k}: ${v}`)
    );
    logger.info('════════════════════════════════════════════════════');

    return summary;
}