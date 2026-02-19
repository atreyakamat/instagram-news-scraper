# Instagram News Scraper v4

Production-grade Node.js scraper that **intercepts GraphQL API responses** from an Instagram-clone platform. No fragile DOM selectors — post data is captured directly from network payloads. Downloaded images are stored locally; structured data goes into **MySQL**.

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js** | ≥ 18.0.0 |
| **MySQL** | 5.7+ or 8.x (local or remote) |
| **Playwright Chromium** | `npm run install-browsers` |

## Installation

```bash
npm install
npm run install-browsers
```

The MySQL database and all tables are **created automatically** on first run.

## Quick Start

```bash
node index.js \
  --url=https://www.instagram.com/prudentmediagoa/ \
  --mysql-user=root \
  --mysql-password=yourpassword \
  --auth-state=./auth.json
```

## Full CLI Reference

| Flag | Default | Description |
|---|---|---|
| `--url` | *(required)* | Instagram profile URL |
| `--start` | `2021-01-01` | Start date inclusive (YYYY-MM-DD) |
| `--end` | `2025-12-31` | End date inclusive (YYYY-MM-DD) |
| `--workers` | `3` | Parallel image download/insert workers |
| `--mysql-host` | `localhost` | MySQL host |
| `--mysql-port` | `3306` | MySQL port |
| `--mysql-user` | `root` | MySQL user |
| `--mysql-password` | *(empty)* | MySQL password |
| `--mysql-database` | `instagram_clone_archive` | Database name (auto-created) |
| `--auth-state` | *(none)* | Path to Playwright auth state JSON |
| `--no-headless` | *(headless)* | Show browser window for debugging |

## First-Time Authentication (Required for Instagram)

```bash
# Opens a browser — log in manually, then press Enter
node save-auth.js

# Now run with auth
node index.js --url=https://www.instagram.com/prudentmediagoa/ \
  --mysql-user=root --mysql-password=yourpassword --auth-state=./auth.json
```

## How It Works

Instead of querying DOM elements like `article`, the scraper uses **GraphQL network interception**:

1. **Browser launched** with Playwright (inherits your login session from `auth.json`)
2. **Response listener attached** — intercepts all GraphQL API calls before navigation
3. **Page navigates** to the profile URL
4. **Scroll loop** drives the infinite scroll to trigger more GraphQL requests
5. **Each GraphQL response** is parsed recursively to find post arrays — works on any edge/node schema
6. **Posts filtered** by date range, deduplicated, then queued for:
   - Direct image download via HTTP (axios, 3 retries)
   - MySQL insert (idempotent via UNIQUE constraint)
7. **Stops when**: date boundary reached, content exhausted, or end-of-feed detected

## Architecture

```
index.js                      ← CLI
save-auth.js                  ← One-time login helper
src/
├── logger/index.js           ← Winston logger
├── database/index.js         ← MySQL connection pool + auto schema
├── browser/index.js          ← Playwright lifecycle + login wall detection
├── network/interceptor.js    ← GraphQL response capture (recursive schema discovery)
├── scroll/controller.js      ← Infinite scroll driver (no DOM selectors)
├── post/processor.js         ← Date filter + dedup + boundary detection
├── image/downloader.js       ← HTTP image download → disk (downloads/YYYY/MM/)
├── queue/worker.js           ← p-queue worker pool
└── orchestrator/index.js     ← Pipeline coordination
downloads/                    ← Downloaded images (auto-created, gitignored)
tests/
├── db.test.js                ← MySQL integration tests
└── extractor.test.js         ← Date parser tests
```

## MySQL Schema (auto-created)

```sql
-- Created automatically on first run

CREATE TABLE scrape_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  source_url VARCHAR(500),
  start_date_filter DATE,
  end_date_filter DATE,
  start_time DATETIME,
  end_time DATETIME,
  total_posts_processed INT,
  total_posts_skipped INT,
  total_errors INT,
  duration_seconds INT
);

CREATE TABLE posts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  scrape_session_id INT,
  post_identifier VARCHAR(255) UNIQUE,   -- duplicate-proof
  source_url VARCHAR(500),
  image_path VARCHAR(500),               -- local file path
  caption_text TEXT,
  comments_json JSON,                    -- [{username, text}]
  published_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (scrape_session_id) REFERENCES scrape_sessions(id)
);
```

## Useful Queries

```sql
-- Most recent posts
SELECT post_identifier, published_at, caption_text, image_path
FROM posts ORDER BY published_at DESC LIMIT 20;

-- Posts by year
SELECT YEAR(published_at) yr, COUNT(*) total
FROM posts GROUP BY yr ORDER BY yr;

-- Session history
SELECT id, start_time, total_posts_processed, duration_seconds
FROM scrape_sessions ORDER BY id DESC;

-- Search captions
SELECT post_identifier, published_at, caption_text
FROM posts WHERE caption_text LIKE '%breaking%';
```

## Debugging

**See what the browser sees:**
```bash
node index.js --url=... --no-headless
```

**GraphQL schema discovery** — on first run the interceptor logs the full schema of the first GraphQL response. Look for lines like:
```
[interceptor] First GraphQL response from: https://...
[interceptor] Top-level keys: data, extensions, ...
[interceptor] GraphQL response #1: 12 post node(s) found
```

**Tests**
```bash
node tests/extractor.test.js    # date parser (no server needed)
node tests/db.test.js           # MySQL integration (needs MySQL)
```

**Logs**
```bash
tail -f logs/scraper.log
```
