import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ResourceIdSchema } from '../../shared/api.ts';

const companyId = '20000000-0000-4000-8000-000000000001';
const localId = 'x'.repeat(300);

it.effect('Shell resource IDs preserve native300 and explicitly scoped337 identities', () =>
  Effect.gen(function* shellResourceIdentityRoundTrip() {
    for (const input of [localId, `${companyId}.${localId}`]) {
      const decoded = yield* Schema.decodeEffect(ResourceIdSchema)(input);
      expect(decoded).toBe(input);
      expect(yield* Schema.encodeEffect(ResourceIdSchema)(decoded)).toBe(input);
    }
  }),
);

it.effect('Shell resource IDs reject native overflow, malformed scope and empty or oversized scoped suffixes', () =>
  Effect.gen(function* rejectUnsupportedShellResourceIdentities() {
    for (const input of [
      '',
      'x'.repeat(301),
      `not-a-company.${localId}`,
      `${companyId.replace('2', 'g')}.${localId}`,
      `${companyId}.`,
      `${companyId}.${'x'.repeat(301)}`,
    ]) {
      expect(Exit.isFailure(yield* Effect.exit(Schema.decodeEffect(ResourceIdSchema)(input)))).toBe(true);
    }
  }),
);
