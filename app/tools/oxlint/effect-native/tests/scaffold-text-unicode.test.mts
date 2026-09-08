import { expect, it } from 'effect-rstest';

import { maskText } from '../shared/scaffold-text.ts';

it('scaffold masking preserves UTF-16 offsets after astral string data', () => {
  const text = 'const icon = "😀😀😀😀😀"; throw new Error("bad");';
  const masked = maskText(text, true);
  expect(masked.length).toBe(text.length);
  expect(masked.indexOf('throw')).toBe(text.indexOf('throw'));
});

it('scaffold masking preserves astral comment offsets and CRLF', () => {
  const text = '// 😀😀\r\n/* 😀\r\n😀 */ throw new Error("bad");';
  const masked = maskText(text);
  expect(masked.length).toBe(text.length);
  expect(masked.indexOf('throw')).toBe(text.indexOf('throw'));
  expect(
    [...masked.matchAll(/\r\n/gu)].map((match) => match.index)
  ).toStrictEqual([...text.matchAll(/\r\n/gu)].map((match) => match.index));
  expect(masked.endsWith('throw new Error("bad");')).toBeTruthy();
});
