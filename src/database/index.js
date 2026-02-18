/**
 * Database module — uses Node.js built-in `node:sqlite` (Node >= 22.5.0).
 * No native compilation required. Run with: node --experimental-sqlite
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { createLogger } from '../logger/index.js';

const logger = createLogger('database');

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS scrape_sessions (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    source_url            TEXT    NOT NULL,
    start_date_filter     TEXT    NOT NULL,
    end_date_filter       TEXT    NOT NULL,
    start_time            TEXT    NOT NULL,
    end_time              TEXT,
    total_posts_processed INTEGER DEFAULT 0,
    total_posts_skipped   INTEGER DEFAULT 0,
    total_errors          INTEGER DEFAULT 0,
    duration_seconds      INTEGER
  );

  CREATE TABLE IF NOT EXISTS posts (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    scrape_session_id    INTEGER NOT NULL REFERENCES scrape_sessions(id),
    post_identifier      TEXT    NOT NULL UNIQUE,
    source_url           TEXT,
    post_url             TEXT,
    image_url            TEXT,
    extracted_image_text TEXT,
    caption_text         TEXT,
    comments_json        TEXT,
    published_at         TEXT,
    created_at           TEXT    DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_posts_published_at ON posts(published_at);
  CREATE INDEX IF NOT EXISTS idx_posts_session      ON posts(scrape_session_id);
`;

// ─── Connection ───────────────────────────────────────────────────────────────

/**
 * Open (or create) the SQLite database and apply schema.
 * Pass ':memory:' for an in-memory database (useful for tests).
 * @param {string} dbPath
 * @returns {DatabaseSync}
 */
export function initDb(dbPath) {
  if (dbPath !== ':memory:') {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);

  // node:sqlite executes each statement separately
  for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
    db.exec(stmt + ';');
  }

  logger.info(`SQLite database ready: ${dbPath}`);
  return db;
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

/**
 * Create a new scrape session row.
 * @returns {number} inserted session id
 */
export function createSession(db, { sourceUrl, startDateFilter, endDateFilter }) {
  const stmt = db.prepare(`
    INSERT INTO scrape_sessions (source_url, start_date_filter, end_date_filter, start_time)
    VALUES (?, ?, ?, datetime('now'))
  `);
  const result = stmt.run(sourceUrl, startDateFilter, endDateFilter);
  const id = Number(result.lastInsertRowid);
  logger.info(`Created scrape session id=${id}`);
  return id;
}

/**
 * Update session with final stats.
 */
export function finalizeSession(db, sessionId, { processed, skipped, errors, durationSeconds }) {
  db.prepare(`
    UPDATE scrape_sessions
    SET end_time              = datetime('now'),
        total_posts_processed = ?,
        total_posts_skipped   = ?,
        total_errors          = ?,
        duration_seconds      = ?
    WHERE id = ?
  `).run(processed, skipped, errors, durationSeconds, sessionId);
  logger.info(`Finalized session id=${sessionId}: processed=${processed} skipped=${skipped} errors=${errors}`);
}

// ─── Posts ────────────────────────────────────────────────────────────────────

/**
 * Insert a post row. Silently ignores duplicates (UNIQUE on post_identifier).
 * @returns {boolean} true if inserted (new), false if duplicate
 */
export function insertPost(db, sessionId, postData) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO posts
      (scrape_session_id, post_identifier, source_url, post_url, image_url,
       extracted_image_text, caption_text, comments_json, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    sessionId,
    postData.postIdentifier,
    postData.sourceUrl || null,
    postData.postUrl || null,
    postData.imageUrl || null,
    postData.extractedImageText ? JSON.stringify(postData.extractedImageText) : null,
    postData.captionText || '',
    postData.comments ? JSON.stringify(postData.comments) : '[]',
    postData.publishedAt ? postData.publishedAt.toISOString() : null
  );

  const inserted = Number(result.changes) > 0;
  if (inserted) {
    logger.debug(`Inserted post: ${postData.postIdentifier}`);
  } else {
    logger.debug(`Duplicate skipped: ${postData.postIdentifier}`);
  }
  return inserted;
}

/**
 * Get the most recent published_at stored in the DB (for resumable scraping).
 * @returns {Date|null}
 */
export function getLatestPublishedAt(db) {
  const row = db.prepare(
    `SELECT published_at FROM posts ORDER BY published_at DESC LIMIT 1`
  ).get();
  return row?.published_at ? new Date(row.published_at) : null;
}

/**
 * Get oldest and newest post dates for a given session.
 * @returns {{ oldest: Date|null, newest: Date|null }}
 */
export function getPostDateRange(db, sessionId) {
  const oldest = db.prepare(
    `SELECT published_at FROM posts WHERE scrape_session_id = ? ORDER BY published_at ASC  LIMIT 1`
  ).get(sessionId);
  const newest = db.prepare(
    `SELECT published_at FROM posts WHERE scrape_session_id = ? ORDER BY published_at DESC LIMIT 1`
  ).get(sessionId);
  return {
    oldest: oldest?.published_at ? new Date(oldest.published_at) : null,
    newest: newest?.published_at ? new Date(newest.published_at) : null,
  };
}

/**
 * Get a session row by id.
 */
export function getSession(db, sessionId) {
  return db.prepare(`SELECT * FROM scrape_sessions WHERE id = ?`).get(sessionId);
}
