# Instagram News Scraper

A production-grade, fully modular Node.js system for extracting posts from Instagram, processing images locally via **Ollama vision**, and storing structured results in **SQLite** (no database server required).

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | ≥ 22.5.0 |
| Ollama | Running locally with a vision model pulled |

```bash
# Pull a vision model (choose one)
ollama pull llava        # recommended, ~4GB
ollama pull moondream    # lighter, ~1.7GB
```

## Installation

```bash
npm install
npm run install-browsers   # installs Playwright Chromium
```

## Usage

```bash
# Basic run (SQLite DB auto-created at data/scraper.db)
node --experimental-sqlite index.js --url=https://www.instagram.com/username/

# Or use npm start (flag is included automatically)
npm start -- --url=https://www.instagram.com/username/
```

### All Options

| Flag | Default | Description |
|---|---|---|
| `--url` | *(required)* | Instagram profile or feed URL |
| `--start` | `2021-01-01` | Start date inclusive (YYYY-MM-DD) |
| `--end` | `2025-12-31` | End date inclusive (YYYY-MM-DD) |
| `--workers` | `3` | Parallel Ollama vision workers |
| `--db` | `data/scraper.db` | SQLite database file path |
| `--ollama-url` | `http://localhost:11434` | Ollama API base URL |
| `--ollama-model` | `llava` | Vision model name |
| `--auth-state` | *(none)* | Path to Playwright storage state JSON |
| `--post-selector` | *(auto)* | Custom CSS selector for post containers |
| `--no-headless` | *(headless)* | Run browser in headed mode (for debugging) |

### Examples

```bash
# Custom date range
node --experimental-sqlite index.js --url=https://www.instagram.com/username/ --start=2023-01-01 --end=2023-12-31

# With moondream (lighter model)
node --experimental-sqlite index.js --url=https://www.instagram.com/username/ --ollama-model=moondream

# Authenticated session (save state first with Playwright)
node --experimental-sqlite index.js --url=https://www.instagram.com/username/ --auth-state=./auth.json

# Debug mode (visible browser)
node --experimental-sqlite index.js --url=https://www.instagram.com/username/ --no-headless
```

## Architecture

```
index.js                    ← CLI entry point (commander)
src/
├── logger/index.js         ← Winston structured logger
├── database/index.js       ← SQLite: schema, session tracking, parameterized inserts
├── browser/index.js        ← Playwright Chromium lifecycle
├── scroll/controller.js    ← Infinite scroll async generator + date boundary detection
├── extractor/index.js      ← Instagram DOM parsing: image, caption, comments, date
├── image/processor.js      ← Browser-context image download → base64
├── vision/client.js        ← Ollama API client + JSON validation + retry
├── queue/worker.js         ← p-queue worker pool
└── orchestrator/index.js   ← Main pipeline controller
tests/
├── db.test.js              ← SQLite module tests (in-memory DB)
├── vision.test.js          ← Vision client JSON parsing tests
└── extractor.test.js       ← Date parser and range tests
```

## SQLite Schema

```sql
-- scrape_sessions: one row per run
CREATE TABLE scrape_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_url TEXT, start_date_filter TEXT, end_date_filter TEXT,
  start_time TEXT, end_time TEXT,
  total_posts_processed INTEGER, total_posts_skipped INTEGER,
  total_errors INTEGER, duration_seconds INTEGER
);

-- posts: one row per unique Instagram post
CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scrape_session_id INTEGER REFERENCES scrape_sessions(id),
  post_identifier TEXT UNIQUE,   -- Instagram shortcode (e.g. ABC123)
  source_url TEXT, post_url TEXT, image_url TEXT,
  extracted_image_text TEXT,     -- JSON: detected_text, scene_description, objects_detected, additional_context
  caption_text TEXT,
  comments_json TEXT,            -- JSON array: [{username, text}]
  published_at TEXT,             -- UTC ISO 8601
  created_at TEXT DEFAULT (datetime('now'))
);
```

## Running Tests

```bash
node --experimental-sqlite tests/db.test.js   # DB tests (in-memory SQLite)
node tests/vision.test.js                     # Vision client tests
node tests/extractor.test.js                  # Date parser tests
```

## Querying Results

```bash
# Open the database
sqlite3 data/scraper.db

# View stored posts
SELECT post_identifier, published_at, caption_text FROM posts ORDER BY published_at DESC LIMIT 20;

# View session summary
SELECT * FROM scrape_sessions;

# View vision results for a post
SELECT post_identifier, extracted_image_text FROM posts WHERE post_identifier = 'ABC123';
```

## Termination Logic

The scraper stops when **either** condition is met:
1. **Content exhausted**: No new posts after 3 consecutive scroll stabilization checks
2. **Date boundary**: A post older than `--start` is encountered
3. **End-of-feed**: Instagram's "You're all caught up" banner is detected

## Resumable Scraping

On re-run against the same URL, the scraper checks the most recent `published_at` stored in the DB and skips already-archived posts, preventing duplicate processing.

## Logs

Structured logs are written to `logs/scraper.log` and the console.

```bash
LOG_LEVEL=debug node --experimental-sqlite index.js --url=...
```
