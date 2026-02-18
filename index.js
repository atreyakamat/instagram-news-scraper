#!/usr/bin/env node
import { program } from 'commander';
import { parseISO, isValid } from 'date-fns';
import { run } from './src/orchestrator/index.js';
import { createLogger } from './src/logger/index.js';
import { mkdirSync } from 'fs';

// Ensure logs directory exists
mkdirSync('logs', { recursive: true });

const logger = createLogger('cli');

program
    .name('instagram-news-scraper')
    .description(
        'Production-grade Instagram-style platform scraper with Ollama vision and MongoDB storage'
    )
    .version('1.0.0')
    .requiredOption('--url <url>', 'Platform URL to scrape')
    .option('--start <date>', 'Start date (YYYY-MM-DD, inclusive)', '2021-01-01')
    .option('--end <date>', 'End date (YYYY-MM-DD, inclusive)', '2025-12-31')
    .option('--workers <n>', 'Number of parallel vision workers', '3')
    .option('--mongo-uri <uri>', 'MongoDB connection URI', 'mongodb://localhost:27017')
    .option('--db-name <name>', 'MongoDB database name', 'instagram_scraper')
    .option('--ollama-url <url>', 'Ollama API base URL', 'http://localhost:11434')
    .option('--ollama-model <model>', 'Ollama vision model name', 'llava')
    .option('--auth-state <path>', 'Path to Playwright storage state JSON (for authenticated sessions)')
    .option('--post-selector <selector>', 'Custom CSS selector for post containers')
    .option('--no-headless', 'Run browser in headed mode (for debugging)')
    .parse(process.argv);

const opts = program.opts();

// ── Validate dates ────────────────────────────────────────────────────────────
function parseCliDate(str, label) {
    const d = parseISO(str);
    if (!isValid(d)) {
        logger.error(`Invalid ${label} date: "${str}". Expected format: YYYY-MM-DD`);
        process.exit(1);
    }
    return d;
}

const startDate = parseCliDate(opts.start, '--start');
const endDate = parseCliDate(opts.end, '--end');

if (startDate > endDate) {
    logger.error('--start date must be before or equal to --end date');
    process.exit(1);
}

// ── Validate workers ──────────────────────────────────────────────────────────
const workers = parseInt(opts.workers, 10);
if (isNaN(workers) || workers < 1) {
    logger.error('--workers must be a positive integer');
    process.exit(1);
}

// ── Run ───────────────────────────────────────────────────────────────────────
logger.info('Instagram News Scraper starting...');
logger.info(`  URL:          ${opts.url}`);
logger.info(`  Date range:   ${opts.start} → ${opts.end}`);
logger.info(`  Workers:      ${workers}`);
logger.info(`  MongoDB:      ${opts.mongoUri} / ${opts.dbName}`);
logger.info(`  Ollama:       ${opts.ollamaUrl} (model: ${opts.ollamaModel})`);
logger.info(`  Headless:     ${opts.headless}`);
if (opts.authState) logger.info(`  Auth state:   ${opts.authState}`);
if (opts.postSelector) logger.info(`  Post selector: ${opts.postSelector}`);

run({
    url: opts.url,
    startDate,
    endDate,
    mongoUri: opts.mongoUri,
    dbName: opts.dbName,
    ollamaUrl: opts.ollamaUrl,
    ollamaModel: opts.ollamaModel,
    workers,
    authStatePath: opts.authState || null,
    headless: opts.headless,
    postSelector: opts.postSelector || null,
})
    .then((summary) => {
        logger.info('Scraper finished successfully.');
        process.exit(0);
    })
    .catch((err) => {
        logger.error(`Fatal error: ${err.message}`, { stack: err.stack });
        process.exit(1);
    });
