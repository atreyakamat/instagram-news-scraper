#!/usr/bin/env node
import { program } from 'commander';
import { parseISO, isValid } from 'date-fns';
import { run } from './src/orchestrator/index.js';
import { createLogger } from './src/logger/index.js';
import { mkdirSync } from 'fs';

mkdirSync('logs', { recursive: true });

const logger = createLogger('cli');

program
    .name('instagram-news-scraper')
    .description(
        'Production-grade Instagram scraper with Playwright, local image downloads, and MySQL storage'
    )
    .version('3.0.0')
    .requiredOption('--url <url>', 'Platform URL to scrape')
    .option('--start <date>', 'Start date inclusive (YYYY-MM-DD)', '2021-01-01')
    .option('--end <date>', 'End date inclusive (YYYY-MM-DD)', '2025-12-31')
    .option('--workers <n>', 'Parallel download workers', '3')
    .option('--mysql-host <host>', 'MySQL host', 'localhost')
    .option('--mysql-port <port>', 'MySQL port', '3306')
    .option('--mysql-user <user>', 'MySQL user', 'root')
    .option('--mysql-password <pw>', 'MySQL password', '')
    .option('--mysql-database <db>', 'MySQL database name', 'instagram_clone_archive')
    .option('--auth-state <path>', 'Playwright storage state JSON path')
    .option('--post-selector <sel>', 'Custom CSS selector for posts')
    .option('--no-headless', 'Run browser in headed mode')
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
logger.info('Instagram News Scraper v3.0.0 starting...');
logger.info(`  URL:          ${opts.url}`);
logger.info(`  Date range:   ${opts.start} → ${opts.end}`);
logger.info(`  Workers:      ${workers}`);
logger.info(`  MySQL:        ${opts.mysqlUser}@${opts.mysqlHost}:${opts.mysqlPort}/${opts.mysqlDatabase}`);
logger.info(`  Headless:     ${opts.headless}`);
if (opts.authState) logger.info(`  Auth state:   ${opts.authState}`);
if (opts.postSelector) logger.info(`  Post selector: ${opts.postSelector}`);

// ── Run ───────────────────────────────────────────────────────────────────────
run({
    url: opts.url,
    startDate,
    endDate,
    mysql: {
        host: opts.mysqlHost,
        port: parseInt(opts.mysqlPort, 10),
        user: opts.mysqlUser,
        password: opts.mysqlPassword,
        database: opts.mysqlDatabase,
    },
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
