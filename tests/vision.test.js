/**
 * Vision client unit test
 * Run: node tests/vision.test.js
 *
 * Tests JSON parsing, schema validation, and retry logic using mocked responses.
 */
import { parseOllamaResponse } from '../src/vision/client.js';

function assert(condition, message) {
    if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function testValidJson() {
    const raw = JSON.stringify({
        detected_text: 'BREAKING NEWS',
        scene_description: 'A news broadcast screenshot',
        objects_detected: ['text', 'logo', 'anchor'],
        additional_context: 'Evening news segment',
    });

    const result = parseOllamaResponse(raw);
    assert(result.detected_text === 'BREAKING NEWS', 'detected_text mismatch');
    assert(result.scene_description === 'A news broadcast screenshot', 'scene_description mismatch');
    assert(Array.isArray(result.objects_detected), 'objects_detected should be array');
    assert(result.objects_detected.length === 3, 'objects_detected length mismatch');
    console.log('✓ testValidJson: parsed correctly');
}

function testMarkdownFences() {
    const raw = '```json\n{"detected_text":"Hello","scene_description":"Test","objects_detected":[],"additional_context":""}\n```';
    const result = parseOllamaResponse(raw);
    assert(result.detected_text === 'Hello', 'Should strip markdown fences');
    console.log('✓ testMarkdownFences: markdown fences stripped correctly');
}

function testExtraTextBeforeJson() {
    const raw = 'Sure! Here is the JSON:\n{"detected_text":"text","scene_description":"desc","objects_detected":["a"],"additional_context":"ctx"}';
    const result = parseOllamaResponse(raw);
    assert(result.detected_text === 'text', 'Should extract JSON from mixed text');
    console.log('✓ testExtraTextBeforeJson: JSON extracted from mixed text');
}

function testMissingFields() {
    const raw = '{"detected_text":"only this"}';
    const result = parseOllamaResponse(raw);
    assert(result.scene_description === '', 'Missing field should default to empty string');
    assert(Array.isArray(result.objects_detected), 'Missing array field should default to []');
    console.log('✓ testMissingFields: missing fields default correctly');
}

function testInvalidJson() {
    try {
        parseOllamaResponse('this is not json at all');
        throw new Error('Should have thrown');
    } catch (err) {
        assert(err.message.includes('No JSON object found'), `Wrong error: ${err.message}`);
        console.log('✓ testInvalidJson: throws on no JSON object');
    }
}

function testMalformedJson() {
    try {
        parseOllamaResponse('{broken json: true,}');
        throw new Error('Should have thrown');
    } catch (err) {
        assert(err.message.includes('Invalid JSON'), `Wrong error: ${err.message}`);
        console.log('✓ testMalformedJson: throws on malformed JSON');
    }
}

// ── Run all tests ─────────────────────────────────────────────────────────────
(async () => {
    try {
        testValidJson();
        testMarkdownFences();
        testExtraTextBeforeJson();
        testMissingFields();
        testInvalidJson();
        testMalformedJson();
        console.log('\n✅ All vision client tests passed!');
    } catch (err) {
        console.error('\n❌ Test failed:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
})();
