import { expect, it } from 'effect-rstest';

import { priceGroupCurrentInputGuard } from '../support/price-group-current-input.ts';

it('accepts consecutive bounded messages whose combined size exceeds one frame', () => {
  const accepts = priceGroupCurrentInputGuard();
  const frame = new Uint8Array(131_081).fill(97);
  frame[frame.length - 1] = 10;
  expect(accepts(frame)).toBe(true);
  expect(accepts(frame)).toBe(true);
  const coalesced = new Uint8Array(frame.length * 2);
  coalesced.set(frame);
  coalesced.set(frame, frame.length);
  expect(priceGroupCurrentInputGuard()(coalesced)).toBe(true);
});

it('retains the exact frame byte boundary across chunks and resets at a newline', () => {
  const accepts = priceGroupCurrentInputGuard();
  expect(accepts(new Uint8Array(262_142).fill(97))).toBe(true);
  expect(accepts(Uint8Array.of(97, 10, 98, 10))).toBe(true);
});

it('rejects an oversized fragmented message and keeps the stream rejected', () => {
  const accepts = priceGroupCurrentInputGuard();
  expect(accepts(new Uint8Array(262_144).fill(97))).toBe(true);
  expect(accepts(Uint8Array.of(98))).toBe(false);
  expect(accepts(Uint8Array.of(10, 99, 10))).toBe(false);
});

it('rejects an oversized message even when followed by a newline in the same chunk', () => {
  const frame = new Uint8Array(262_145).fill(97);
  frame[frame.length - 1] = 10;
  expect(priceGroupCurrentInputGuard()(frame)).toBe(false);
});

it('includes a fragmented newline in the wire byte budget', () => {
  const accepts = priceGroupCurrentInputGuard();
  expect(accepts(new Uint8Array(262_144).fill(97))).toBe(true);
  expect(accepts(Uint8Array.of(10))).toBe(false);
});

it('counts UTF-8 bytes rather than JavaScript characters', () => {
  const encode = new TextEncoder();
  expect(priceGroupCurrentInputGuard()(encode.encode(`${'🙂'.repeat(65_535)}abc\n`))).toBe(true);
  expect(priceGroupCurrentInputGuard()(encode.encode(`${'🙂'.repeat(65_536)}\n`))).toBe(false);
});
