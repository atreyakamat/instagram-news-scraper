/**
 * save-auth.js
 * 
 * Run this script ONCE to log into Instagram manually in a visible browser,
 * then save the session so the scraper can reuse it without logging in again.
 *
 * Usage:
 *   node --experimental-sqlite save-auth.js
 *
 * After running, a file called auth.json will be saved in the project root.
 * Then run the scraper with:
 *   node --experimental-sqlite index.js --url=... --auth-state=./auth.json
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const AUTH_FILE = './auth.json';

console.log('Opening Instagram login page...');
console.log('Please log in manually in the browser window that appears.');
console.log('Once you are fully logged in and can see your feed, press ENTER here to save the session.\n');

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
});

const page = await context.newPage();
await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded' });

// Wait for the user to log in manually
await new Promise((resolve) => {
    process.stdin.setRawMode(false);
    process.stdin.resume();
    process.stdin.once('data', resolve);
});

// Save the browser session (cookies + localStorage)
const storageState = await context.storageState();
writeFileSync(AUTH_FILE, JSON.stringify(storageState, null, 2));

await browser.close();

console.log(`\n✅ Auth state saved to: ${AUTH_FILE}`);
console.log('\nNow run the scraper with:');
console.log(`  node --experimental-sqlite index.js --url=https://www.instagram.com/username/ --auth-state=./auth.json`);
