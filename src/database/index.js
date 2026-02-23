/**
 * JSON Database Module
 * Stores scraped data into a JSON file instead of MySQL
 */

import fs from "fs/promises";
import path from "path";
import { createLogger } from "../logger/index.js";

const logger = createLogger("json-db");

const OUTPUT_FILE = path.resolve("scraped_posts.json");

let db = {
  sessions: [],
  posts: []
};

// ─── Init ─────────────────────────────────────

export async function initDb() {
  try {
    const data = await fs.readFile(OUTPUT_FILE, "utf-8");
    db = JSON.parse(data);
    logger.info("Loaded existing JSON database");
  } catch {
    await saveDb();
    logger.info("Created new JSON database");
  }
}

// ─── Save helper ──────────────────────────────

async function saveDb() {
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(db, null, 2));
}

// ─── Sessions ─────────────────────────────────

export async function createSession(_, { sourceUrl, startDateFilter, endDateFilter }) {
  const sessionId = db.sessions.length + 1;

  db.sessions.push({
    id: sessionId,
    source_url: sourceUrl,
    start_date_filter: startDateFilter,
    end_date_filter: endDateFilter,
    start_time: new Date().toISOString(),
    end_time: null,
    total_posts_processed: 0,
    total_posts_skipped: 0,
    total_errors: 0
  });

  await saveDb();
  return sessionId;
}

export async function finalizeSession(_, sessionId, stats) {
  const session = db.sessions.find(s => s.id === sessionId);
  if (!session) return;

  session.end_time = new Date().toISOString();
  session.total_posts_processed = stats.processed;
  session.total_posts_skipped = stats.skipped;
  session.total_errors = stats.errors;
  session.duration_seconds = stats.durationSeconds;

  await saveDb();
}

// ─── Posts ───────────────────────────────────

export async function insertPost(_, sessionId, postData) {
  const exists = db.posts.find(p => p.post_identifier === postData.postIdentifier);
  if (exists) return false;

  db.posts.push({
    scrape_session_id: sessionId,
    post_identifier: postData.postIdentifier,
    source_url: postData.sourceUrl || null,
    post_url: postData.postUrl || null,
    media_type: postData.mediaType || "image",
    image_url: postData.imageUrl || null,
    image_path: postData.imagePath || null,
    video_url: postData.videoUrl || null,
    caption_text: postData.captionText || "",
    comments: postData.comments || [],
    published_at: postData.publishedAt
      ? postData.publishedAt.toISOString()
      : null,
    created_at: new Date().toISOString()
  });

  await saveDb();
  return true;
}

// ─── Queries ─────────────────────────────────

export async function getLatestPublishedAt(_, sourceUrl) {
  const posts = db.posts
    .filter(p => p.source_url === sourceUrl && p.published_at)
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

  return posts.length ? new Date(posts[0].published_at) : null;
}

export async function getPostDateRange(_, sessionId) {
  const posts = db.posts.filter(p => p.scrape_session_id === sessionId);

  if (!posts.length) return { oldest: null, newest: null };

  const sorted = posts.sort(
    (a, b) => new Date(a.published_at) - new Date(b.published_at)
  );

  return {
    oldest: new Date(sorted[0].published_at),
    newest: new Date(sorted[sorted.length - 1].published_at)
  };
}

export async function closeDb() {
  logger.info("JSON database saved");
}