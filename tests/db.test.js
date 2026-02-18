/**
 * Database module unit test
 * Run: node tests/db.test.js
 *
 * Requires a local MongoDB instance running at mongodb://localhost:27017
 */
import { connectDb, initCollections, createSession, finalizeSession, insertPost, getLatestPublishedAt } from '../src/database/index.js';

const TEST_DB = 'instagram_scraper_test';
const MONGO_URI = 'mongodb://localhost:27017';

let client, db;

async function setup() {
    ({ client, db } = await connectDb(MONGO_URI, TEST_DB));
    await initCollections(db);
    // Clean slate
    await db.collection('posts').deleteMany({});
    await db.collection('scrape_sessions').deleteMany({});
    console.log('✓ Setup: connected and cleaned test DB');
}

async function teardown() {
    await db.dropDatabase();
    await client.close();
    console.log('✓ Teardown: dropped test DB and closed connection');
}

async function testCreateSession() {
    const sessionId = await createSession(db, {
        sourceUrl: 'https://example.com',
        startDateFilter: '2021-01-01',
        endDateFilter: '2025-12-31',
    });
    console.assert(sessionId, 'Session ID should be truthy');
    console.log('✓ testCreateSession: session created with id', sessionId);
    return sessionId;
}

async function testInsertPost(sessionId) {
    const postData = {
        postIdentifier: 'test-post-001',
        sourceUrl: 'https://example.com',
        imageUrl: 'https://example.com/img/1.jpg',
        extractedImageText: {
            detected_text: 'Hello World',
            scene_description: 'A test image',
            objects_detected: ['text'],
            additional_context: 'Unit test',
        },
        captionText: 'Test caption',
        comments: [{ username: 'user1', text: 'Nice post!' }],
        publishedAt: new Date('2023-06-15T10:00:00Z'),
    };

    const inserted = await insertPost(db, sessionId, postData);
    console.assert(inserted === true, 'First insert should return true (new)');
    console.log('✓ testInsertPost: first insert returned true (new document)');

    // Insert same post again — should be idempotent
    const insertedAgain = await insertPost(db, sessionId, postData);
    console.assert(insertedAgain === false, 'Second insert should return false (duplicate)');
    console.log('✓ testInsertPost: second insert returned false (idempotent)');

    // Verify only one document exists
    const count = await db.collection('posts').countDocuments({ postIdentifier: 'test-post-001' });
    console.assert(count === 1, `Expected 1 document, got ${count}`);
    console.log('✓ testInsertPost: exactly 1 document in collection');
}

async function testGetLatestPublishedAt() {
    const latest = await getLatestPublishedAt(db);
    console.assert(latest instanceof Date, 'Should return a Date');
    console.assert(
        latest.toISOString() === '2023-06-15T10:00:00.000Z',
        `Expected 2023-06-15T10:00:00.000Z, got ${latest?.toISOString()}`
    );
    console.log('✓ testGetLatestPublishedAt:', latest.toISOString());
}

async function testFinalizeSession(sessionId) {
    await finalizeSession(db, sessionId, {
        processed: 1,
        skipped: 0,
        errors: 0,
        durationSeconds: 42,
    });
    const session = await db.collection('scrape_sessions').findOne({ _id: sessionId });
    console.assert(session.totalPostsProcessed === 1, 'totalPostsProcessed should be 1');
    console.assert(session.durationSeconds === 42, 'durationSeconds should be 42');
    console.assert(session.endTime instanceof Date, 'endTime should be a Date');
    console.log('✓ testFinalizeSession: session finalized correctly');
}

// ── Run all tests ─────────────────────────────────────────────────────────────
(async () => {
    try {
        await setup();
        const sessionId = await testCreateSession();
        await testInsertPost(sessionId);
        await testGetLatestPublishedAt();
        await testFinalizeSession(sessionId);
        await teardown();
        console.log('\n✅ All database tests passed!');
    } catch (err) {
        console.error('\n❌ Test failed:', err.message);
        console.error(err.stack);
        if (client) await client.close();
        process.exit(1);
    }
})();
