import { expect, it } from 'effect-rstest';
import { priceGroupCurrentInputGuard } from '../support/price-group-current-input.ts';

it('accepts the verified Composition bootstrap lower bound above the former 128 KiB cap', () => {
  const accepts = priceGroupCurrentInputGuard();
  expect(accepts(new Uint8Array(132_225))).toBe(true);
});

it('accepts exactly 256 KiB cumulatively and counts encoded UTF-8 bytes', () => {
  const accepts = priceGroupCurrentInputGuard();
  const chunk = new TextEncoder().encode('á'.repeat(65_536));
  expect(chunk.byteLength).toBe(131_072);
  expect(accepts(chunk)).toBe(true);
  expect(accepts(chunk)).toBe(true);
  expect(accepts(new Uint8Array(0))).toBe(true);
});

it('rejects one byte beyond 256 KiB across separate input chunks', () => {
  const accepts = priceGroupCurrentInputGuard();
  expect(accepts(new Uint8Array(262_143))).toBe(true);
  expect(accepts(new Uint8Array(2))).toBe(false);
});
