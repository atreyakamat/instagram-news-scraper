import PQueue from 'p-queue';
import { createLogger } from '../logger/index.js';

const logger = createLogger('worker-pool');

/**
 * Create a worker pool with configurable concurrency.
 *
 * @param {number} concurrency - number of parallel workers (default 3)
 * @returns {PQueue}
 */
export function createWorkerPool(concurrency = 3) {
    const queue = new PQueue({ concurrency });

    queue.on('active', () => {
        logger.debug(`Worker pool: ${queue.size} queued, ${queue.pending} running`);
    });

    queue.on('idle', () => {
        logger.info('Worker pool: all jobs complete (idle)');
    });

    queue.on('error', (err) => {
        logger.error(`Worker pool error: ${err.message}`);
    });

    return queue;
}

/**
 * Enqueue a post processing job.
 *
 * @param {PQueue} queue
 * @param {object} postData - extracted post data
 * @param {Function} processFn - async (postData) => void
 * @returns {Promise<void>} resolves when job is complete
 */
export function enqueuePost(queue, postData, processFn) {
    return queue.add(() => processFn(postData), { throwOnTimeout: false });
}

/**
 * Wait for all queued jobs to complete.
 * @param {PQueue} queue
 */
export async function drainQueue(queue) {
    logger.info(`Draining worker pool (${queue.size} remaining jobs)...`);
    await queue.onIdle();
    logger.info('Worker pool drained');
}
