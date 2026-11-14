import type { Schema } from 'effect';
import { Effect, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { createProductRequestIdentity } from '../../shared/domain/native-action-request-identity.ts';

it.effect('normalizes the published Product payload without inventing optional fields or a Core target', () =>
  Effect.gen(function* normalizedCreateIdentity() {
    expect(yield* createProductRequestIdentity({})).toEqual({
      actionKey: 'commerce.catalog.create-product',
      normalizedPayload: {},
      owningModuleKey: 'commerce.catalog',
      schemaVersion: '2',
      target: {},
    });
    const identity = yield* createProductRequestIdentity({ name: '  Internal fixture name  ' });
    expect(identity.normalizedPayload).toEqual({ name: 'Internal fixture name' });
  }),
);

it.effect('refuses invalid owner payloads instead of manufacturing a recoverable request identity', () =>
  Effect.gen(function* invalidCreateIdentity() {
    const invalidPayloads: readonly Schema.Json[] = [
      { classification: { kind: 'NEW_PRODUCT' } },
      { sourceCorrelation: { issuerId: 'internal-ebs', recordId: 'unqualified' } },
      { name: 'Internal fixture', unsupportedMetadata: { ownerId: 'not-an-authorization-target' } },
    ];
    for (const payload of invalidPayloads) {
      expect(Result.isFailure(yield* createProductRequestIdentity(payload).pipe(Effect.result))).toBe(true);
    }
  }),
);
