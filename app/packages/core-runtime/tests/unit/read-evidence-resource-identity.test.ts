import { Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { validateReadEvidenceMetadata } from '../../src/reads/context.ts';

const companyId = '20000000-0000-4000-8000-000000000001';
const localId = 'x'.repeat(300);
const evidence = (resourceId: string) => ({
  resultCount: 1,
  targetResource: { resourceId, resourceType: 'demo.merchandise.product' },
});

it.effect('read evidence retains exact native300 and scoped337 resource identities under both capture policies', () =>
  Effect.gen(function* retainSupportedEvidenceIdentities() {
    for (const mode of ['metadata_only', 'hash_only'] as const) {
      for (const resourceId of [localId, `${companyId}.${localId}`]) {
        const input = evidence(resourceId);
        const result = yield* validateReadEvidenceMetadata(mode, input);
        expect(result).toEqual(input);
        expect(Object.isFrozen(result.targetResource)).toBe(true);
      }
    }
  }),
);

it.effect('read evidence rejects oversized or malformed identities instead of silently dropping their refs', () =>
  Effect.gen(function* rejectInvalidEvidenceIdentities() {
    for (const mode of ['metadata_only', 'hash_only'] as const) {
      for (const resourceId of [
        '',
        'x'.repeat(301),
        `not-a-company.${localId}`,
        `${companyId.replace('2', 'g')}.${localId}`,
        `${companyId}.`,
        `${companyId}.${'x'.repeat(301)}`,
      ]) {
        const failure = yield* Effect.flip(validateReadEvidenceMetadata(mode, evidence(resourceId)));
        expect(Predicate.isTagged(failure, 'ReadEvidenceValidationError')).toBe(true);
      }
    }
    const failure = yield* Effect.flip(
      validateReadEvidenceMetadata('metadata_only', { ...evidence(`${companyId}.${localId}`), resultCount: 2 }),
    );
    expect(Predicate.isTagged(failure, 'ReadEvidenceValidationError')).toBe(true);
  }),
);
