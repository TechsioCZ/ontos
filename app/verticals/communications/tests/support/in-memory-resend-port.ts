import { Effect, Option } from 'effect';

import type { ResendOriginalFacts, ResendOriginalPortContract } from '../../src/domain/recovery/resend-admission.ts';

/**
 * TEST-ONLY original-intent port of an Explicit Resend for the unit and public-boundary tests, where no database exists. It
 * answers what a test scripts and records every read, so "nothing was read for a type without the resend approval" is a fact.
 */
export const makeInMemoryResendPort = (originals: Readonly<Record<string, ResendOriginalFacts>> = {}) => {
  const reads: string[] = [];
  const port: ResendOriginalPortContract = {
    findOriginal: (originalIntentId) =>
      Effect.sync(() => {
        reads.push(originalIntentId);
        return Option.fromNullishOr(originals[originalIntentId]);
      }),
  };
  return { port, reads };
};
