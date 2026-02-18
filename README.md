# Instagram News Scraper v3

Production-grade, fully modular Node.js system for extracting posts from an Instagram-style platform, downloading images locally, and storing structured data in **MySQL**.

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js** | ≥ 18.0.0 |
| **MySQL** | 5.7+ or 8.x running locally or remotely |
| **Playwright Chromium** | Installed via `npm run install-browsers` |

## Installation

```bash
npm install
npm run install-browsers
```

## Quick Start

```bash
# Ensure MySQL is running, then:
node index.js \
  --url=https://www.instagram.com/username/ \
  --mysql-user=root \
  --mysql-password=yourpassword
```

The database `instagram_clone_archive` and all tables are created automatically on first run.

## CLI Options

| Flag | Default | Description |
|---|---|---|
| `--url` | *(required)* | Instagram profile or feed URL |
| `--start` | `2021-01-01` | Start date inclusive (YYYY-MM-DD) |
| `--end` | `2025-12-31` | End date inclusive (YYYY-MM-DD) |
| `--workers` | `3` | Parallel download/insert workers |
| `--mysql-host` | `localhost` | MySQL host |
| `--mysql-port` | `3306` | MySQL port |
| `--mysql-user` | `root` | MySQL user |
| `--mysql-password` | *(empty)* | MySQL password |
| `--mysql-database` | `instagram_clone_archive` | Database name |
| `--auth-state` | *(none)* | Playwright storage state JSON |
| `--post-selector` | *(auto)* | Custom CSS selector for posts |
| `--no-headless` | *(headless)* | Visible browser for debugging |

### Examples

```bash
# Custom date range
node index.js --url=https://www.instagram.com/username/ --start=2023-01-01 --end=2023-12-31

# Remote MySQL
node index.js --url=https://www.instagram.com/username/ \
  --mysql-host=db.example.com --mysql-user=scraper --mysql-password=secret

# With auth state (login saved previously)
node index.js --url=https://www.instagram.com/username/ --auth-state=./auth.json

# Debug mode (visible browser)
node index.js --url=https://www.instagram.com/username/ --no-headless
```

## Saving Instagram Auth State

Instagram requires login to view most profiles. Run the helper script once:

```bash
node save-auth.js
```

A Chrome window opens → log in manually → press Enter in terminal → session saved to `auth.json`.

Then run the scraper with `--auth-state=./auth.json`.

## Architecture

```
index.js                    ← CLI entry point
save-auth.js                ← One-time login helper
src/
├── logger/index.js         ← Winston structured logger
├── database/index.js       ← MySQL: pooling, auto-schema, parameterized inserts
├── browser/index.js        ← Playwright Chromium lifecycle
├── scroll/controller.js    ← Infinite scroll async generator + date boundary
├── extractor/index.js      ← Instagram DOM parsing: image, caption, comments, date
├── image/processor.js      ← Image downloader → disk (downloads/YYYY/MM/)
├── queue/worker.js         ← p-queue concurrent worker pool
└── orchestrator/index.js   ← Main pipeline controller
downloads/                  ← Downloaded images (auto-created, gitignored)
  └── 2023/06/shortcode.jpg
tests/
├── db.test.js              ← MySQL integration tests
└── extractor.test.js       ← Date parser + range tests
```

## MySQL Schema

```sql
-- Database: instagram_clone_archive

CREATE TABLE scrape_sessions (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  source_url            VARCHAR(500),
  start_date_filter     DATE,
  end_date_filter       DATE,
  start_time            DATETIME,
  end_time              DATETIME,
  total_posts_processed INT,
  total_posts_skipped   INT,
  total_errors          INT,
  duration_seconds      INT
);

CREATE TABLE posts (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  scrape_session_id  INT REFERENCES scrape_sessions(id),
  post_identifier    VARCHAR(255) UNIQUE,
  source_url         VARCHAR(500),
  post_url           VARCHAR(500),
  image_url          VARCHAR(2000),
  image_path         VARCHAR(500),     -- local file path
  caption_text       TEXT,
  comments_json      JSON,             -- [{username, text}]
  published_at       DATETIME INDEX,
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## Querying Results

```sql
-- Most recent posts
SELECT post_identifier, published_at, caption_text, image_path
FROM posts ORDER BY published_at DESC LIMIT 20;

-- Session summary
SELECT * FROM scrape_sessions;

-- Posts by year
SELECT YEAR(published_at) AS yr, COUNT(*) AS total
FROM posts GROUP BY yr ORDER BY yr;

-- Search captions
SELECT post_identifier, published_at, caption_text
FROM posts WHERE caption_text LIKE '%breaking%';

-- Posts with comments
SELECT post_identifier, JSON_LENGTH(comments_json) AS num_comments
FROM posts WHERE JSON_LENGTH(comments_json) > 0;
```

## Downloaded Images

Images are saved to `downloads/<year>/<month>/` with deterministic filenames based on the post identifier. The relative path is stored in the `image_path` column of the `posts` table.

## Termination Logic

The scraper stops when **any** condition is met:
1. **Content exhausted** — no new posts after 3 consecutive scroll checks
2. **Date boundary** — posts older than `--start` encountered
3. **End-of-feed** — Instagram's "You're all caught up" banner detected

## Tests

```bash
# MySQL integration tests (requires running MySQL)
node tests/db.test.js

# Date parser tests (no external deps)
node tests/extractor.test.js
```

## Logs

```bash
tail -f logs/scraper.log
```
