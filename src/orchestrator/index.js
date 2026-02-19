/**
 * Orchestrator v4 — GraphQL Interception Pipeline
 *
 * Coordinates:
 *   1. MySQL init + session creation
 *   2. Browser launch + GraphQL interceptor attachment
 *   3. Scroll driving via two-way async generator
 *   4. Post filtering (PostProcessor)
 *   5. Concurrent image download + DB insert (p-queue worker pool)
 *   6. Date-boundary termination
 *   7. Session finalization + summary report
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

/**
 * @param {object} opts
 * @param {string}       opts.url
 * @param {Date}         opts.startDate
 * @param {Date}         opts.endDate
 * @param {object}       opts.mysql          - { host, port, user, password, database }
 * @param {number}       opts.workers
 * @param {string|null}  opts.authStatePath
 * @param {boolean}      opts.headless
 * @param {string[]}     [opts.keywords]     - caption keyword filter (empty = keep all)
 */
export async function run(opts) {
    const { url, startDate, endDate, mysql: mysqlConf, workers, authStatePath, headless, keywords = [] } = opts;
    const startTime = Date.now();

    // ── Stats ───────────────────────────────────────────────────────────────
    const stats = { processed: 0, skipped: 0, errors: 0, images: 0, imageFails: 0 };

    // Track total posts received by interceptor (regardless of date filter)
    // Used to keep the scroll going even when everything is filtered out
    let totalIntercepted = 0;

    // ── MySQL ───────────────────────────────────────────────────────────────
    logger.info('Connecting to MySQL...');
    const pool = await initDb(mysqlConf);

    const latestStored = await getLatestPublishedAt(pool);
    if (latestStored) {
        logger.info(`Resuming: latest stored post at ${latestStored.toISOString()}`);
    }

    const sessionId = await createSession(pool, {
        sourceUrl: url,
        startDateFilter: startDate.toISOString().slice(0, 10),
        endDateFilter: endDate.toISOString().slice(0, 10),
    });

    // ── Worker pool ─────────────────────────────────────────────────────────
    const queue = new PQueue({ concurrency: workers });

    queue.on('error', err => {
        logger.error(`Worker pool error: ${err.message}`);
        stats.errors++;
    });

    // ── Post processor ──────────────────────────────────────────────────────
    // Batch of inRange posts from the current scroll cycle
    let pendingNewPosts = 0;
    let dateBoundaryHit = false;

    const processor = new PostProcessor({
        startDate,
        endDate,
        latestStoredDate: latestStored,
        keywords,
        onValidPost: (post) => {
            pendingNewPosts++;
            // Enqueue download + insert
            queue.add(async () => {
                let imagePath = null;

                if (post.imageUrl) {
                    try {
                        imagePath = await downloadImage({
                            imageUrl: post.imageUrl,
                            postIdentifier: post.postIdentifier,
                            publishedAt: post.publishedAt,
                        });
                        stats.images++;
                    } catch (err) {
                        stats.imageFails++;
                        stats.errors++;
                        logger.error(`Image download failed [${post.postIdentifier}]: ${err.message}`);
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
                        logger.info(
                            `Stored [${post.postIdentifier}] | ${post.publishedAt.toISOString()} | image: ${imagePath || 'N/A'}`
                        );
                    }
                } catch (err) {
                    stats.errors++;
                    logger.error(`DB insert failed [${post.postIdentifier}]: ${err.message}`);
                }

                // Free rawNode memory
                delete post.rawNode;
            });
        },
    });

    // ── Browser ─────────────────────────────────────────────────────────────
    logger.info('Launching browser...');
    const { browser, page } = await launchBrowser({ headless, authStatePath });

    // Attach GraphQL interceptor BEFORE navigating so we don't miss early responses
    const interceptor = attachInterceptor(page, (post) => {
        totalIntercepted++;
        // Process immediately as it arrives from the network
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
    logger.info(`Date range: ${startDate.toISOString().slice(0, 10)} → ${endDate.toISOString().slice(0, 10)}`);
    logger.info(`Workers: ${workers}`);
    logger.info(`Keywords: ${keywords.length > 0 ? keywords.join(', ') : '(all posts)'}`);

    // ── Scroll loop ─────────────────────────────────────────────────────────
    const scroller = driveScroll(page);

    // Prime the generator (triggers scroll #1, waits, then yields)
    await scroller.next();

    // Track how many posts the interceptor has received to detect real content exhaustion
    let lastBatchIntercepted = 0;

    while (true) {
        // Did the interceptor receive ANY new posts since the last scroll?
        // (independent of date filter — keeps scrolling even when posts are "too new")
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

    // ── Drain queue ──────────────────────────────────────────────────────────
    logger.info(`Scroll complete. Draining worker queue (${queue.size} remaining)...`);
    await queue.onIdle();
    logger.info('Queue drained');

    // ── Cleanup ──────────────────────────────────────────────────────────────
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

    // ── Summary ──────────────────────────────────────────────────────────────
    const summary = {
        dateRangeApplied: `${startDate.toISOString().slice(0, 10)} → ${endDate.toISOString().slice(0, 10)}`,
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
    Object.entries(summary).forEach(([k, v]) => logger.info(`  ${k}: ${v}`));
    logger.info('════════════════════════════════════════════════════');

    return summary;
}
