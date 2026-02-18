/**
 * Database module unit test (SQLite)
 * Run: node tests/db.test.js
 *
 * Uses an in-memory SQLite database — no external services required.
 */
import { initDb, createSession, finalizeSession, insertPost, getLatestPublishedAt, getPostDateRange } from '../src/database/index.js';

// Use in-memory SQLite for tests
const db = initDb(':memory:');

function assert(condition, message) {
    if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function testCreateSession() {
    const id = createSession(db, {
        sourceUrl: 'https://www.instagram.com/test/',
        startDateFilter: '2021-01-01',
        endDateFilter: '2025-12-31',
    });
    assert(typeof id === 'number' && id > 0, `Session id should be a positive number, got ${id}`);
    console.log('✓ testCreateSession: id =', id);
    return id;
}

function testInsertPost(sessionId) {
    const postData = {
        postIdentifier: 'ABC123shortcode',
        sourceUrl: 'https://www.instagram.com/test/',
        postUrl: 'https://www.instagram.com/p/ABC123/',
        imageUrl: 'https://cdn.example.com/img/1.jpg',
        extractedImageText: {
            detected_text: 'Breaking News',
            scene_description: 'A news broadcast',
            objects_detected: ['text', 'logo'],
            additional_context: 'Evening bulletin',
        },
        captionText: 'Test caption with emoji 🎉',
        comments: [{ username: 'user1', text: 'Great post!' }],
        publishedAt: new Date('2023-06-15T10:00:00Z'),
    };

    const inserted = insertPost(db, sessionId, postData);
    assert(inserted === true, 'First insert should return true');
    console.log('✓ testInsertPost: first insert → true (new row)');

    // Duplicate — should be silently ignored
    const insertedAgain = insertPost(db, sessionId, postData);
    assert(insertedAgain === false, 'Second insert should return false (duplicate)');
    console.log('✓ testInsertPost: second insert → false (idempotent)');

    // Verify only one row exists
    const count = db.prepare(`SELECT COUNT(*) as c FROM posts WHERE post_identifier = ?`).get('ABC123shortcode');
    assert(count.c === 1, `Expected 1 row, got ${count.c}`);
    console.log('✓ testInsertPost: exactly 1 row in DB');
}

function testGetLatestPublishedAt() {
    const latest = getLatestPublishedAt(db);
    assert(latest instanceof Date, 'Should return a Date');
    assert(
        latest.toISOString() === '2023-06-15T10:00:00.000Z',
        `Expected 2023-06-15T10:00:00.000Z, got ${latest?.toISOString()}`
    );
    console.log('✓ testGetLatestPublishedAt:', latest.toISOString());
}

function testFinalizeSession(sessionId) {
    finalizeSession(db, sessionId, {
        processed: 1,
        skipped: 2,
        errors: 0,
        durationSeconds: 42,
    });
    const row = db.prepare(`SELECT * FROM scrape_sessions WHERE id = ?`).get(sessionId);
    assert(row.total_posts_processed === 1, 'total_posts_processed should be 1');
    assert(row.total_posts_skipped === 2, 'total_posts_skipped should be 2');
    assert(row.duration_seconds === 42, 'duration_seconds should be 42');
    assert(row.end_time !== null, 'end_time should be set');
    console.log('✓ testFinalizeSession: all fields correct');
}

function testGetPostDateRange(sessionId) {
    const range = getPostDateRange(db, sessionId);
    assert(range.oldest instanceof Date, 'oldest should be a Date');
    assert(range.newest instanceof Date, 'newest should be a Date');
    console.log('✓ testGetPostDateRange: oldest =', range.oldest?.toISOString(), '| newest =', range.newest?.toISOString());
}

function testCommentsJson(sessionId) {
    // Insert a second post with multiple comments
    insertPost(db, sessionId, {
        postIdentifier: 'DEF456shortcode',
        sourceUrl: 'https://www.instagram.com/test/',
        postUrl: 'https://www.instagram.com/p/DEF456/',
        imageUrl: 'https://cdn.example.com/img/2.jpg',
        extractedImageText: null,
        captionText: 'Another post',
        comments: [
            { username: 'alice', text: 'Hello!' },
            { username: 'bob', text: 'World!' },
        ],
        publishedAt: new Date('2022-03-10T08:00:00Z'),
    });
    const row = db.prepare(`SELECT comments_json FROM posts WHERE post_identifier = ?`).get('DEF456shortcode');
    const parsed = JSON.parse(row.comments_json);
    assert(Array.isArray(parsed) && parsed.length === 2, 'comments_json should be an array of 2');
    assert(parsed[0].username === 'alice', 'First comment username should be alice');
    console.log('✓ testCommentsJson: comments stored and parsed correctly');
}

// ── Run ───────────────────────────────────────────────────────────────────────
try {
    const sessionId = testCreateSession();
    testInsertPost(sessionId);
    testGetLatestPublishedAt();
    testFinalizeSession(sessionId);
    testGetPostDateRange(sessionId);
    testCommentsJson(sessionId);
    db.close();
    console.log('\n✅ All database tests passed!');
} catch (err) {
    console.error('\n❌ Test failed:', err.message);
    console.error(err.stack);
    process.exit(1);
}
