// expect-count: 2
import { test } from 'node:test';
import assert from 'node:assert/strict';

void test('unregistered', () => assert.equal(1, 1));
