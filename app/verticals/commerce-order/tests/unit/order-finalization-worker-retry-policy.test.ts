import { describe, expect, it } from 'effect-rstest';

import { finalizeOrderWorkWorker } from '../../src/workers/finalize-order-work.worker.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
// The owner bounds the window must outlast: Pricing's Quotation validity maximum and the approval
// request's validity, which its Purchase Proposal caps at 30 minutes.
const QUOTATION_VALIDITY_MAXIMUM = 24 * HOUR;
const APPROVAL_REQUEST_VALIDITY_MAXIMUM = 30 * MINUTE;

const { retryPolicy } = finalizeOrderWorkWorker.descriptor;

/** Core waits after each failed attempt except the last, which marks the delivery dead. */
const retryWindow = (maxAttempts: number) => {
  let total = 0;
  for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
    total += Math.min(
      retryPolicy.maxBackoffMs,
      Math.round(retryPolicy.initialBackoffMs * retryPolicy.multiplier ** (attempt - 1)),
    );
  }
  return total;
};

describe('Order finalization worker retry policy', () => {
  it('declares the reviewed retry budget', () => {
    expect(retryPolicy).toEqual({
      initialBackoffMs: SECOND,
      maxAttempts: 60,
      maxBackoffMs: APPROVAL_REQUEST_VALIDITY_MAXIMUM,
      multiplier: 2,
    });
  });

  it('retries for longer than the Quotation and approval request bounds combined, using the fewest attempts', () => {
    const covered = QUOTATION_VALIDITY_MAXIMUM + APPROVAL_REQUEST_VALIDITY_MAXIMUM;
    expect(retryWindow(retryPolicy.maxAttempts)).toBe(88_447 * SECOND);
    expect(retryWindow(retryPolicy.maxAttempts)).toBeGreaterThanOrEqual(covered);
    expect(retryWindow(retryPolicy.maxAttempts - 1)).toBeLessThan(covered);
  });

  it('stays inside the Core descriptor maximums', () => {
    expect(retryPolicy.maxAttempts).toBeLessThanOrEqual(100);
    expect(retryPolicy.maxBackoffMs).toBeLessThanOrEqual(24 * HOUR);
  });
});
