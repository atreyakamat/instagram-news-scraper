/**
 * Database module — MySQL via mysql2/promise.
 *
 * Handles connection pooling, schema initialization, session tracking,
 * and idempotent post inserts with parameterized queries.
 */
import mysql from 'mysql2/promise';
import { createLogger } from '../logger/index.js';

const logger = createLogger('database');

// ─── Schema ───────────────────────────────────────────────────────────────────

const CREATE_SESSIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS scrape_sessions (
    id                    INT          AUTO_INCREMENT PRIMARY KEY,
    source_url            VARCHAR(500) NOT NULL,
    start_date_filter     DATE         NOT NULL,
    end_date_filter       DATE         NOT NULL,
    start_time            DATETIME     NOT NULL,
    end_time              DATETIME,
    total_posts_processed INT          DEFAULT 0,
    total_posts_skipped   INT          DEFAULT 0,
    total_errors          INT          DEFAULT 0,
    duration_seconds      INT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const CREATE_POSTS_TABLE = `
  CREATE TABLE IF NOT EXISTS posts (
    id                 INT          AUTO_INCREMENT PRIMARY KEY,
    scrape_session_id  INT          NOT NULL,
    post_identifier    VARCHAR(255) NOT NULL UNIQUE,
    source_url         VARCHAR(500),
    post_url           VARCHAR(500),
    image_url          VARCHAR(2000),
    image_path         VARCHAR(500),
    caption_text       TEXT,
    comments_json      JSON,
    published_at       DATETIME,
    created_at         DATETIME     DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_published_at (published_at),
    INDEX idx_session (scrape_session_id),
    FOREIGN KEY (scrape_session_id) REFERENCES scrape_sessions(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

// ─── Connection ───────────────────────────────────────────────────────────────

/**
 * Create a MySQL connection pool and initialize schema.
 *
 * @param {object} conf
 * @param {string} conf.host
 * @param {number} conf.port
 * @param {string} conf.user
 * @param {string} conf.password
 * @param {string} conf.database
 * @returns {Promise<mysql.Pool>}
 */
export async function initDb({ host, port, user, password, database }) {
  // First connect without database to create it if missing
  const tempPool = mysql.createPool({ host, port, user, password, waitForConnections: true, connectionLimit: 2 });
  await tempPool.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await tempPool.end();

  // Now connect to the target database
  const pool = mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
  });

  await pool.query(CREATE_SESSIONS_TABLE);
  await pool.query(CREATE_POSTS_TABLE);

  logger.info(`MySQL ready: ${user}@${host}:${port}/${database}`);
  return pool;
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

/**
 * Create a new scrape session record.
 * @returns {Promise<number>} session id
 */
export async function createSession(pool, { sourceUrl, startDateFilter, endDateFilter }) {
  const [result] = await pool.query(
    `INSERT INTO scrape_sessions (source_url, start_date_filter, end_date_filter, start_time)
     VALUES (?, ?, ?, NOW())`,
    [sourceUrl, startDateFilter, endDateFilter]
  );
  logger.info(`Created scrape session id=${result.insertId}`);
  return result.insertId;
}

/**
 * Finalize a session with stats.
 */
export async function finalizeSession(pool, sessionId, { processed, skipped, errors, durationSeconds }) {
  await pool.query(
    `UPDATE scrape_sessions
     SET end_time              = NOW(),
         total_posts_processed = ?,
         total_posts_skipped   = ?,
         total_errors          = ?,
         duration_seconds      = ?
     WHERE id = ?`,
    [processed, skipped, errors, durationSeconds, sessionId]
  );
  logger.info(`Finalized session id=${sessionId}: processed=${processed} skipped=${skipped} errors=${errors}`);
}

// ─── Posts ────────────────────────────────────────────────────────────────────

/**
 * Insert a post. Duplicates are silently ignored via INSERT IGNORE (unique on post_identifier).
 * @returns {Promise<boolean>} true if new row was inserted
 */
export async function insertPost(pool, sessionId, postData) {
  const [result] = await pool.query(
    `INSERT IGNORE INTO posts
       (scrape_session_id, post_identifier, source_url, post_url, image_url, image_path,
        caption_text, comments_json, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      postData.postIdentifier,
      postData.sourceUrl || null,
      postData.postUrl || null,
      postData.imageUrl || null,
      postData.imagePath || null,
      postData.captionText || '',
      JSON.stringify(postData.comments || []),
      postData.publishedAt ? postData.publishedAt.toISOString().slice(0, 19).replace('T', ' ') : null,
    ]
  );

  const inserted = result.affectedRows > 0;
  if (inserted) {
    logger.debug(`Inserted post: ${postData.postIdentifier}`);
  } else {
    logger.debug(`Duplicate skipped: ${postData.postIdentifier}`);
  }
  return inserted;
}

/**
 * Get the most recent published_at in the DB (for resumable scraping).
 * @returns {Promise<Date|null>}
 */
export async function getLatestPublishedAt(pool) {
  const [rows] = await pool.query(
    `SELECT published_at FROM posts ORDER BY published_at DESC LIMIT 1`
  );
  return rows.length > 0 && rows[0].published_at ? new Date(rows[0].published_at) : null;
}

/**
 * Get oldest and newest post dates for a session.
 * @returns {Promise<{ oldest: Date|null, newest: Date|null }>}
 */
export async function getPostDateRange(pool, sessionId) {
  const [oldestRows] = await pool.query(
    `SELECT published_at FROM posts WHERE scrape_session_id = ? ORDER BY published_at ASC  LIMIT 1`,
    [sessionId]
  );
  const [newestRows] = await pool.query(
    `SELECT published_at FROM posts WHERE scrape_session_id = ? ORDER BY published_at DESC LIMIT 1`,
    [sessionId]
  );
  return {
    oldest: oldestRows.length > 0 && oldestRows[0].published_at ? new Date(oldestRows[0].published_at) : null,
    newest: newestRows.length > 0 && newestRows[0].published_at ? new Date(newestRows[0].published_at) : null,
  };
}

/**
 * Close the connection pool.
 */
export async function closeDb(pool) {
  await pool.end();
  logger.info('MySQL connection pool closed');
}
