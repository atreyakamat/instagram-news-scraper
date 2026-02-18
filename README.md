# Instagram News Scraper

A production-grade, fully modular Node.js system for extracting posts from an Instagram-style infinite-scroll platform, processing images locally via **Ollama vision**, and storing structured results in **MongoDB**.

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | ≥ 18.0.0 |
| MongoDB | Running locally (default: `mongodb://localhost:27017`) |
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
node index.js --url=<platform_url> [options]
```

### Options

| Flag | Default | Description |
|---|---|---|
| `--url` | *(required)* | Platform URL to scrape |
| `--start` | `2021-01-01` | Start date (inclusive, YYYY-MM-DD) |
| `--end` | `2025-12-31` | End date (inclusive, YYYY-MM-DD) |
| `--workers` | `3` | Parallel Ollama vision workers |
| `--mongo-uri` | `mongodb://localhost:27017` | MongoDB connection URI |
| `--db-name` | `instagram_scraper` | MongoDB database name |
| `--ollama-url` | `http://localhost:11434` | Ollama API base URL |
| `--ollama-model` | `llava` | Vision model name |
| `--auth-state` | *(none)* | Path to Playwright storage state JSON |
| `--post-selector` | *(auto)* | Custom CSS selector for post containers |
| `--no-headless` | *(headless)* | Run browser in headed mode (for debugging) |

### Examples

```bash
# Basic run
node index.js --url=https://example-platform.com

# Custom date range with moondream model
node index.js --url=https://example-platform.com --start=2023-01-01 --end=2023-12-31 --ollama-model=moondream

# Authenticated session (save state first with Playwright)
node index.js --url=https://example-platform.com --auth-state=./auth.json

# Debug mode (visible browser)
node index.js --url=https://example-platform.com --no-headless

# Custom post selector for non-standard layouts
node index.js --url=https://example-platform.com --post-selector=".news-card"
```

## Architecture

```
index.js                    ← CLI entry point (commander)
src/
├── logger/index.js         ← Winston structured logger
├── database/index.js       ← MongoDB: connect, collections, session tracking, upserts
├── browser/index.js        ← Playwright Chromium lifecycle
├── scroll/controller.js    ← Infinite scroll async generator with date boundary detection
├── extractor/index.js      ← DOM parsing: image, caption, comments, date
├── image/processor.js      ← Browser-context image download → base64
├── vision/client.js        ← Ollama API client with JSON validation + retry
├── queue/worker.js         ← p-queue worker pool
└── orchestrator/index.js   ← Main pipeline controller
tests/
├── db.test.js              ← Database module tests
├── vision.test.js          ← Vision client JSON parsing tests
└── extractor.test.js       ← Date parser and range tests
```

## MongoDB Schema

### Collection: `posts`
```js
{
  _id: ObjectId,
  scrapeSessionId: ObjectId,
  postIdentifier: String,       // unique SHA-256 hash
  sourceUrl: String,
  imageUrl: String,
  extractedImageText: {
    detected_text: String,
    scene_description: String,
    objects_detected: [String],
    additional_context: String
  },
  captionText: String,
  comments: [{ username: String, text: String }],
  publishedAt: Date,
  createdAt: Date
}
```

### Collection: `scrape_sessions`
```js
{
  _id: ObjectId,
  sourceUrl: String,
  startDateFilter: String,
  endDateFilter: String,
  startTime: Date,
  endTime: Date,
  totalPostsProcessed: Number,
  totalPostsSkipped: Number,
  totalErrors: Number,
  durationSeconds: Number
}
```

## Running Tests

```bash
# Vision client (no external dependencies)
node tests/vision.test.js

# Date parser (no external dependencies)
node tests/extractor.test.js

# Database (requires local MongoDB)
node tests/db.test.js
```

## Termination Logic

The scraper stops when **either** condition is met:
1. **Content exhausted**: No new posts appear after 3 consecutive scroll stabilization checks
2. **Date boundary**: A post older than `--start` date is encountered

## Resumable Scraping

On re-run against the same URL, the scraper checks the most recent `publishedAt` stored in MongoDB and skips posts already archived, preventing duplicate processing.

## Logs

Structured logs are written to `logs/scraper.log` and the console. Set `LOG_LEVEL=debug` for verbose output:

```bash
LOG_LEVEL=debug node index.js --url=...
```
