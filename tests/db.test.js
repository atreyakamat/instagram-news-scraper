/**
 * Database module unit test (MySQL).
 *
 * Run: node tests/db.test.js
 *
 * Requires a running MySQL server. By default connects to localhost:3306
 * with user root and no password. Override via environment variables:
 *   MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD
 *
 * Uses a throwaway test database that is dropped after tests complete.
 */
import {
    initDb,
    createSession,
    finalizeSession,
    insertPost,
    getLatestPublishedAt,
    getPostDateRange,
    closeDb,
} from '../src/database/index.js';

const TEST_DB = 'instagram_scraper_test_' + Date.now();

const mysqlConf = {
    host: process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: TEST_DB,
};

function assert(condition, message) {
    if (!condition) throw new Error(`Assertion failed: ${message}`);
}

let pool;

async function setup() {
    pool = await initDb(mysqlConf);
    console.log(`✓ Connected to MySQL, test database: ${TEST_DB}`);
}

async function testCreateSession() {
    const id = await createSession(pool, {
        sourceUrl: 'https://www.instagram.com/test/',
        startDateFilter: '2021-01-01',
        endDateFilter: '2025-12-31',
    });
    assert(typeof id === 'number' && id > 0, `Session id should be positive, got ${id}`);
    console.log('✓ testCreateSession: id =', id);
    return id;
}

async function testInsertPost(sessionId) {
    const postData = {
        postIdentifier: 'ABC123shortcode',
        sourceUrl: 'https://www.instagram.com/test/',
        postUrl: 'https://www.instagram.com/p/ABC123/',
        imageUrl: 'https://cdn.example.com/img/1.jpg',
        imagePath: 'downloads/2023/06/ABC123shortcode_abc123.jpg',
        captionText: 'Test caption with emoji 🎉',
        comments: [{ username: 'user1', text: 'Great post!' }],
        publishedAt: new Date('2023-06-15T10:00:00Z'),
    };

    const inserted = await insertPost(pool, sessionId, postData);
    assert(inserted === true, 'First insert should return true');
    console.log('✓ testInsertPost: first insert → true');

    const insertedAgain = await insertPost(pool, sessionId, postData);
    assert(insertedAgain === false, 'Duplicate should return false');
    console.log('✓ testInsertPost: duplicate → false (idempotent)');

    const [rows] = await pool.query(
        `SELECT COUNT(*) AS c FROM posts WHERE post_identifier = ?`, ['ABC123shortcode']
    );
    assert(rows[0].c === 1, `Expected 1 row, got ${rows[0].c}`);
    console.log('✓ testInsertPost: exactly 1 row in DB');
}

async function testGetLatestPublishedAt() {
    const latest = await getLatestPublishedAt(pool);
    assert(latest instanceof Date, 'Should return a Date');
    console.log('✓ testGetLatestPublishedAt:', latest.toISOString());
}

async function testFinalizeSession(sessionId) {
    await finalizeSession(pool, sessionId, {
        processed: 1,
        skipped: 2,
        errors: 0,
        durationSeconds: 42,
    });
    const [rows] = await pool.query(`SELECT * FROM scrape_sessions WHERE id = ?`, [sessionId]);
    assert(rows[0].total_posts_processed === 1, 'total_posts_processed should be 1');
    assert(rows[0].total_posts_skipped === 2, 'total_posts_skipped should be 2');
    assert(rows[0].duration_seconds === 42, 'duration should be 42');
    assert(rows[0].end_time !== null, 'end_time should be set');
    console.log('✓ testFinalizeSession: all fields correct');
}

async function testGetPostDateRange(sessionId) {
    const range = await getPostDateRange(pool, sessionId);
    assert(range.oldest instanceof Date, 'oldest should be Date');
    assert(range.newest instanceof Date, 'newest should be Date');
    console.log('✓ testGetPostDateRange: oldest =', range.oldest?.toISOString());
}

async function testCommentsJson(sessionId) {
    await insertPost(pool, sessionId, {
        postIdentifier: 'DEF456shortcode',
        sourceUrl: 'https://www.instagram.com/test/',
        imageUrl: 'https://cdn.example.com/img/2.jpg',
        imagePath: 'downloads/2022/03/DEF456.jpg',
        captionText: 'Another post',
        comments: [
            { username: 'alice', text: 'Hello!' },
            { username: 'bob', text: 'World!' },
        ],
        publishedAt: new Date('2022-03-10T08:00:00Z'),
    });
    const [rows] = await pool.query(
        `SELECT comments_json FROM posts WHERE post_identifier = ?`, ['DEF456shortcode']
    );
    const parsed = JSON.parse(rows[0].comments_json);
    assert(Array.isArray(parsed) && parsed.length === 2, 'Should have 2 comments');
    assert(parsed[0].username === 'alice', 'First comment user should be alice');
    console.log('✓ testCommentsJson: stored and parsed correctly');
}

async function cleanup() {
    await pool.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await closeDb(pool);
    console.log(`✓ Cleaned up test database: ${TEST_DB}`);
}

// ── Run ───────────────────────────────────────────────────────────────────────
try {
    await setup();
    const sessionId = await testCreateSession();
    await testInsertPost(sessionId);
    await testGetLatestPublishedAt();
    await testFinalizeSession(sessionId);
    await testGetPostDateRange(sessionId);
    await testCommentsJson(sessionId);
    await cleanup();
    console.log('\n✅ All MySQL database tests passed!');
} catch (err) {
    console.error('\n❌ Test failed:', err.message);
    console.error(err.stack);
    // Try to clean up
    try {
        if (pool) {
            await pool.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
            await closeDb(pool);
        }
    } catch { /* ignore cleanup errors */ }
    process.exit(1);
}
