import assert from 'node:assert/strict';
import { test } from 'node:test';

import { maskText } from '../shared/scaffold-text.ts';

test('scaffold masking preserves UTF-16 offsets after astral string data', () => {
  const text = 'const icon = "😀😀😀😀😀"; throw new Error("bad");';
  const masked = maskText(text, true);
  assert.equal(masked.length, text.length);
  assert.equal(masked.indexOf('throw'), text.indexOf('throw'));
});

test('scaffold masking preserves astral comment offsets and CRLF', () => {
  const text = '// 😀😀\r\n/* 😀\r\n😀 */ throw new Error("bad");';
  const masked = maskText(text);
  assert.equal(masked.length, text.length);
  assert.equal(masked.indexOf('throw'), text.indexOf('throw'));
  assert.deepEqual(
    [...masked.matchAll(/\r\n/gu)].map((match) => match.index),
    [...text.matchAll(/\r\n/gu)].map((match) => match.index),
  );
  assert.ok(masked.endsWith('throw new Error("bad");'));
});
