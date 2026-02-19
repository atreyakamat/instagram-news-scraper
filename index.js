#!/usr/bin/env node
/**
 * CLI entry point — Instagram News Scraper v4
 * Uses GraphQL network interception for reliable post discovery.
 *
 * Usage:
 *   node index.js --url=https://www.instagram.com/username/ \
 *     --start=2021-01-01 --end=2025-12-31 \
 *     --mysql-user=root --mysql-password=secret \
 *     --auth-state=./auth.json
 */
import { program } from 'commander';
import { parseISO, isValid } from 'date-fns';
import { mkdirSync } from 'fs';
import { run } from './src/orchestrator/index.js';
import { createLogger } from './src/logger/index.js';

mkdirSync('logs', { recursive: true });
mkdirSync('downloads', { recursive: true });

const logger = createLogger('cli');

program
    .name('instagram-news-scraper')
    .description('GraphQL-interception scraper with local image downloads and MySQL storage')
    .version('4.0.0')
    .requiredOption('--url <url>', 'Profile URL to scrape')
    .option('--start <date>', 'Start date inclusive (YYYY-MM-DD)', '2021-01-01')
    .option('--end <date>', 'End date inclusive (YYYY-MM-DD)', '2025-12-31')
    .option('--workers <n>', 'Parallel download/insert workers', '3')
    .option('--mysql-host <host>', 'MySQL host', 'localhost')
    .option('--mysql-port <port>', 'MySQL port', '3306')
    .option('--mysql-user <user>', 'MySQL user', 'root')
    .option('--mysql-password <pw>', 'MySQL password', '')
    .option('--mysql-database <db>', 'MySQL database name', 'instagram_clone_archive')
    .option('--auth-state <path>', 'Playwright storage state JSON path')
    .option('--no-headless', 'Run browser in headed mode (debug)')
    .parse(process.argv);

const opts = program.opts();

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

logger.info('Instagram News Scraper v4.0.0 (GraphQL Interception)');
logger.info(`  URL:          ${opts.url}`);
logger.info(`  Date range:   ${opts.start} → ${opts.end}`);
logger.info(`  Workers:      ${workers}`);
logger.info(`  MySQL:        ${opts.mysqlUser}@${opts.mysqlHost}:${opts.mysqlPort}/${opts.mysqlDatabase}`);
logger.info(`  Headless:     ${opts.headless}`);
if (opts.authState) logger.info(`  Auth state:   ${opts.authState}`);

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
})
    .then(() => process.exit(0))
    .catch((err) => {
        logger.error(`Fatal: ${err.message}`, { stack: err.stack });
        process.exit(1);
    });
