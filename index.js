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
        'Production-grade Instagram scraper with Playwright, Ollama vision, and SQLite storage'
    )
    .version('2.0.0')
    .requiredOption('--url <url>', 'Platform URL to scrape')
    .option('--start <date>', 'Start date inclusive (YYYY-MM-DD)', '2021-01-01')
    .option('--end <date>', 'End date inclusive (YYYY-MM-DD)', '2025-12-31')
    .option('--workers <n>', 'Parallel Ollama vision workers', '3')
    .option('--db <path>', 'SQLite database file path', 'data/scraper.db')
    .option('--ollama-url <url>', 'Ollama API base URL', 'http://localhost:11434')
    .option('--ollama-model <model>', 'Ollama vision model name', 'llava')
    .option('--auth-state <path>', 'Path to Playwright storage state JSON (for authenticated sessions)')
    .option('--post-selector <sel>', 'Custom CSS selector for post containers')
    .option('--no-headless', 'Run browser in headed mode (for debugging)')
    .parse(process.argv);

const opts = program.opts();

// ── Validate dates ────────────────────────────────────────────────────────────
function parseCliDate(str, flag) {
    const d = parseISO(str);
    if (!isValid(d)) {
        logger.error(`Invalid ${flag} date: "${str}". Expected YYYY-MM-DD`);
        process.exit(1);
    }
    return d;
}

const startDate = parseCliDate(opts.start, '--start');
const endDate = parseCliDate(opts.end, '--end');

if (startDate > endDate) {
    logger.error('--start must be before or equal to --end');
    process.exit(1);
}

const workers = parseInt(opts.workers, 10);
if (isNaN(workers) || workers < 1) {
    logger.error('--workers must be a positive integer');
    process.exit(1);
}

// ── Banner ────────────────────────────────────────────────────────────────────
logger.info('Instagram News Scraper v2.0.0 starting...');
logger.info(`  URL:          ${opts.url}`);
logger.info(`  Date range:   ${opts.start} → ${opts.end}`);
logger.info(`  Workers:      ${workers}`);
logger.info(`  Database:     ${opts.db}`);
logger.info(`  Ollama:       ${opts.ollamaUrl} (model: ${opts.ollamaModel})`);
logger.info(`  Headless:     ${opts.headless}`);
if (opts.authState) logger.info(`  Auth state:   ${opts.authState}`);
if (opts.postSelector) logger.info(`  Post selector: ${opts.postSelector}`);

// ── Run ───────────────────────────────────────────────────────────────────────
run({
    url: opts.url,
    startDate,
    endDate,
    dbPath: opts.db,
    ollamaUrl: opts.ollamaUrl,
    ollamaModel: opts.ollamaModel,
    workers,
    authStatePath: opts.authState || null,
    headless: opts.headless,
    postSelector: opts.postSelector || null,
})
    .then(() => process.exit(0))
    .catch((err) => {
        logger.error(`Fatal error: ${err.message}`, { stack: err.stack });
        process.exit(1);
    });
