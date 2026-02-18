import axios from 'axios';
import { createLogger } from '../logger/index.js';

const logger = createLogger('vision-client');

const OLLAMA_TIMEOUT_MS = 120000; // 2 minutes per image

const VISION_PROMPT = `Analyze this image carefully and respond ONLY with a valid JSON object. Do not include any text, explanation, or markdown outside the JSON object. The JSON must match exactly this schema:
{
  "detected_text": "all text visible in the image, verbatim",
  "scene_description": "a concise description of what the image depicts",
  "objects_detected": ["list", "of", "objects", "visible"],
  "additional_context": "any additional relevant context about the image content"
}`;

/**
 * Send a base64 image to Ollama and get structured JSON back.
 *
 * @param {string} base64Image
 * @param {string} model - e.g. 'llava', 'moondream'
 * @param {string} ollamaUrl - e.g. 'http://localhost:11434'
 * @returns {Promise<object>} parsed vision result
 */
export async function queryOllama(base64Image, model, ollamaUrl) {
    const endpoint = `${ollamaUrl}/api/generate`;

    const payload = {
        model,
        prompt: VISION_PROMPT,
        images: [base64Image],
        stream: false,
        options: {
            temperature: 0.1, // Low temperature for deterministic structured output
            num_predict: 1024,
        },
    };

    const response = await axios.post(endpoint, payload, {
        timeout: OLLAMA_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json' },
    });

    const rawText = response.data?.response || '';
    return parseOllamaResponse(rawText);
}

/**
 * Parse and validate the raw text response from Ollama.
 * Strips markdown fences, extracts JSON, validates schema.
 *
 * @param {string} rawText
 * @returns {object}
 */
export function parseOllamaResponse(rawText) {
    let text = rawText.trim();

    // Strip markdown code fences: ```json ... ``` or ``` ... ```
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

    // Find the first { and last } to extract JSON object
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) {
        throw new Error(`No JSON object found in Ollama response: ${text.slice(0, 200)}`);
    }
    text = text.slice(start, end + 1);

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw new Error(`Invalid JSON from Ollama: ${err.message}. Raw: ${text.slice(0, 300)}`);
    }

    // Validate and normalize schema
    return {
        detected_text: String(parsed.detected_text || ''),
        scene_description: String(parsed.scene_description || ''),
        objects_detected: Array.isArray(parsed.objects_detected)
            ? parsed.objects_detected.map(String)
            : [],
        additional_context: String(parsed.additional_context || ''),
    };
}

/**
 * Query Ollama with exponential backoff retry logic.
 *
 * @param {string} base64Image
 * @param {string} model
 * @param {string} ollamaUrl
 * @param {number} maxRetries
 * @returns {Promise<object>}
 */
export async function queryWithRetry(base64Image, model, ollamaUrl, maxRetries = 3) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await queryOllama(base64Image, model, ollamaUrl);
            if (attempt > 1) {
                logger.info(`Ollama succeeded on attempt ${attempt}`);
            }
            return result;
        } catch (err) {
            lastError = err;
            const backoffMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
            logger.warn(
                `Ollama attempt ${attempt}/${maxRetries} failed: ${err.message}. Retrying in ${backoffMs}ms...`
            );
            if (attempt < maxRetries) {
                await sleep(backoffMs);
            }
        }
    }

    throw new Error(`Ollama failed after ${maxRetries} attempts: ${lastError?.message}`);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
