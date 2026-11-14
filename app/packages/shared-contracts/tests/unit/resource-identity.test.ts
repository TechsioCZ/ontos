import { ResourceIdentitySchema as CoreResourceIdentitySchema } from '@app/core-runtime/resources/scoped-resource-id';
import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { NativeResourceIdSchema, ResourceIdentitySchema } from '../../src/resource-identity.ts';

const companyId = '20000000-0000-4000-8000-000000000001';
const localId = 'x'.repeat(300);

it.effect('public browser-safe codecs preserve native and company-qualified identities without rewriting', () =>
  Effect.gen(function* resourceIdentityRoundTrip() {
    expect(ResourceIdentitySchema).toBe(CoreResourceIdentitySchema);
    for (const input of ['x', 'owner.local-id', localId, `${companyId}.x`, `${companyId}.${localId}`]) {
      const decoded = yield* Schema.decodeEffect(ResourceIdentitySchema)(input);
      expect(decoded).toBe(input);
      expect(yield* Schema.encodeEffect(ResourceIdentitySchema)(decoded)).toBe(input);
    }
    expect(`${companyId}.${localId}`).toHaveLength(337);
    expect(yield* Schema.decodeEffect(NativeResourceIdSchema)(localId)).toBe(localId);
    expect(
      Exit.isFailure(yield* Effect.exit(Schema.decodeEffect(NativeResourceIdSchema)(`${companyId}.${localId}`))),
    ).toBe(true);
  }),
);

it.effect('only a valid UUID prefix can extend the native bound, with a nonempty bounded suffix', () =>
  Effect.gen(function* rejectInvalidResourceIdentities() {
    for (const input of [
      '',
      'x'.repeat(301),
      'x'.repeat(337),
      `not-a-company.${localId}`,
      `${companyId.replace('2', 'g')}.${localId}`,
      `${companyId.replaceAll('-', '')}.${localId}`,
      `${companyId}:${localId}`,
      `${companyId}${localId}`,
      `${companyId}.`,
      `${companyId}.${'x'.repeat(301)}`,
      `${companyId}.${companyId}.${localId}`,
      337,
      null,
    ]) {
      expect(Exit.isFailure(yield* Effect.exit(Schema.decodeUnknownEffect(ResourceIdentitySchema)(input)))).toBe(true);
    }
    expect(Exit.isFailure(yield* Effect.exit(Schema.decodeEffect(NativeResourceIdSchema)('x'.repeat(301))))).toBe(true);
  }),
);
