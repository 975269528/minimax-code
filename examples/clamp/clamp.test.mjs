import test from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from './clamp.mjs';
test('keeps values inside the range', () => assert.equal(clamp(5, 0, 10), 5));
test('clamps below the minimum', () => assert.equal(clamp(-3, 0, 10), 0));
test('clamps above the maximum', () => assert.equal(clamp(14, 0, 10), 10));
