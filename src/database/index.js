import { MongoClient, ObjectId } from 'mongodb';
import { createLogger } from '../logger/index.js';

const logger = createLogger('database');

/**
 * Connect to MongoDB and return { client, db }
 */
export async function connectDb(mongoUri, dbName) {
  const client = new MongoClient(mongoUri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });
  await client.connect();
  logger.info(`Connected to MongoDB at ${mongoUri}, database: ${dbName}`);
  const db = client.db(dbName);
  return { client, db };
}

/**
 * Ensure collections and indexes exist
 */
export async function initCollections(db) {
  // posts collection
  const posts = db.collection('posts');
  await posts.createIndex({ postIdentifier: 1 }, { unique: true });
  await posts.createIndex({ publishedAt: -1 });
  await posts.createIndex({ scrapeSessionId: 1 });

  // scrape_sessions collection
  const sessions = db.collection('scrape_sessions');
  await sessions.createIndex({ startTime: -1 });

  logger.info('MongoDB collections and indexes initialized');
}

/**
 * Create a new scrape session document
 * @returns {ObjectId} inserted session _id
 */
export async function createSession(db, sessionData) {
  const sessions = db.collection('scrape_sessions');
  const doc = {
    sourceUrl: sessionData.sourceUrl,
    startDateFilter: sessionData.startDateFilter,
    endDateFilter: sessionData.endDateFilter,
    startTime: new Date(),
    endTime: null,
    totalPostsProcessed: 0,
    totalPostsSkipped: 0,
    totalErrors: 0,
    durationSeconds: null,
  };
  const result = await sessions.insertOne(doc);
  logger.info(`Created scrape session: ${result.insertedId}`);
  return result.insertedId;
}

/**
 * Update session with final stats
 */
export async function finalizeSession(db, sessionId, stats) {
  const sessions = db.collection('scrape_sessions');
  const endTime = new Date();
  await sessions.updateOne(
    { _id: sessionId },
    {
      $set: {
        endTime,
        totalPostsProcessed: stats.processed,
        totalPostsSkipped: stats.skipped,
        totalErrors: stats.errors,
        durationSeconds: stats.durationSeconds,
      },
    }
  );
  logger.info(`Finalized session ${sessionId}: ${JSON.stringify(stats)}`);
}

/**
 * Insert or update a post document (upsert on postIdentifier)
 * Returns true if inserted (new), false if already existed
 */
export async function insertPost(db, sessionId, postData) {
  const posts = db.collection('posts');
  const doc = {
    scrapeSessionId: sessionId,
    postIdentifier: postData.postIdentifier,
    sourceUrl: postData.sourceUrl,
    postUrl: postData.postUrl || null,
    imageUrl: postData.imageUrl,
    extractedImageText: postData.extractedImageText || null,
    captionText: postData.captionText || '',
    comments: postData.comments || [],
    publishedAt: postData.publishedAt,
    createdAt: new Date(),
  };

  const result = await posts.updateOne(
    { postIdentifier: postData.postIdentifier },
    { $setOnInsert: doc },
    { upsert: true }
  );

  const wasInserted = result.upsertedCount > 0;
  if (wasInserted) {
    logger.debug(`Inserted post: ${postData.postIdentifier}`);
  } else {
    logger.debug(`Skipped duplicate post: ${postData.postIdentifier}`);
  }
  return wasInserted;
}

/**
 * Get the most recent publishedAt date stored in the DB (for resumable scraping)
 * @returns {Date|null}
 */
export async function getLatestPublishedAt(db) {
  const posts = db.collection('posts');
  const doc = await posts.findOne({}, { sort: { publishedAt: -1 }, projection: { publishedAt: 1 } });
  return doc ? doc.publishedAt : null;
}

/**
 * Get session summary stats
 */
export async function getSessionSummary(db, sessionId) {
  const sessions = db.collection('scrape_sessions');
  return sessions.findOne({ _id: sessionId });
}

/**
 * Get oldest and newest post dates for a session
 */
export async function getPostDateRange(db, sessionId) {
  const posts = db.collection('posts');
  const [oldest, newest] = await Promise.all([
    posts.findOne({ scrapeSessionId: sessionId }, { sort: { publishedAt: 1 }, projection: { publishedAt: 1 } }),
    posts.findOne({ scrapeSessionId: sessionId }, { sort: { publishedAt: -1 }, projection: { publishedAt: 1 } }),
  ]);
  return {
    oldest: oldest ? oldest.publishedAt : null,
    newest: newest ? newest.publishedAt : null,
  };
}
