/**
 * Date parser unit test
 * Run: node tests/extractor.test.js
 */
import { parseDate, isWithinRange } from '../src/extractor/index.js';

function assert(condition, message) {
    if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function testIsoDate() {
    const d = parseDate('2023-06-15T10:30:00Z');
    assert(d instanceof Date, 'Should return Date');
    assert(d.getUTCFullYear() === 2023, 'Year should be 2023');
    assert(d.getUTCMonth() === 5, 'Month should be June (0-indexed)');
    console.log('✓ testIsoDate:', d.toISOString());
}

function testUnixTimestampSeconds() {
    const d = parseDate('1686823800'); // 2023-06-15T14:30:00Z
    assert(d instanceof Date, 'Should return Date from unix seconds');
    assert(d.getUTCFullYear() === 2023, `Year should be 2023, got ${d.getUTCFullYear()}`);
    console.log('✓ testUnixTimestampSeconds:', d.toISOString());
}

function testUnixTimestampMs() {
    const d = parseDate(1686823800000); // milliseconds
    assert(d instanceof Date, 'Should return Date from unix ms');
    assert(d.getUTCFullYear() === 2023, `Year should be 2023, got ${d.getUTCFullYear()}`);
    console.log('✓ testUnixTimestampMs:', d.toISOString());
}

function testLocaleFormat() {
    const d = parseDate('June 15, 2023');
    assert(d instanceof Date, 'Should parse locale format');
    assert(d.getFullYear() === 2023, `Year should be 2023, got ${d.getFullYear()}`);
    console.log('✓ testLocaleFormat:', d.toISOString());
}

function testShortLocaleFormat() {
    const d = parseDate('Jun 15, 2023');
    assert(d instanceof Date, 'Should parse short locale format');
    assert(d.getFullYear() === 2023, `Year should be 2023, got ${d.getFullYear()}`);
    console.log('✓ testShortLocaleFormat:', d.toISOString());
}

function testInvalidDate() {
    const d = parseDate('not a date at all');
    assert(d === null, 'Should return null for invalid date');
    console.log('✓ testInvalidDate: returns null');
}

function testNullInput() {
    const d = parseDate(null);
    assert(d === null, 'Should return null for null input');
    console.log('✓ testNullInput: returns null');
}

function testIsWithinRange() {
    const start = new Date('2021-01-01T00:00:00Z');
    const end = new Date('2025-12-31T23:59:59Z');

    assert(isWithinRange(new Date('2023-06-15'), start, end), '2023 should be in range');
    assert(isWithinRange(new Date('2021-01-01'), start, end), 'Start date should be in range');
    assert(isWithinRange(new Date('2025-12-31'), start, end), 'End date should be in range');
    assert(!isWithinRange(new Date('2020-12-31'), start, end), '2020 should be out of range');
    assert(!isWithinRange(new Date('2026-01-01'), start, end), '2026 should be out of range');
    assert(!isWithinRange(null, start, end), 'null should be out of range');
    console.log('✓ testIsWithinRange: all boundary conditions correct');
}

// ── Run all tests ─────────────────────────────────────────────────────────────
(async () => {
    try {
        testIsoDate();
        testUnixTimestampSeconds();
        testUnixTimestampMs();
        testLocaleFormat();
        testShortLocaleFormat();
        testInvalidDate();
        testNullInput();
        testIsWithinRange();
        console.log('\n✅ All extractor/date tests passed!');
    } catch (err) {
        console.error('\n❌ Test failed:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
})();
