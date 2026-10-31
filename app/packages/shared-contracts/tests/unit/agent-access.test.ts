import { Effect, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ManageAgentEntityRequestSchema } from '../../src/agent-access.ts';

const createRequest = {
  description: null,
  displayName: 'Pomocník',
  modules: [],
  operation: 'create',
  operatorPrincipalIds: [],
  ownerPrincipalId: 'owner',
  writePolicy: 'approval',
} as const;

it.effect('decodes the native absence model and preserves the published explicit JSON null', () =>
  Effect.gen(function* nullableWireScenario() {
    const decoded = yield* Schema.decodeEffect(ManageAgentEntityRequestSchema)(createRequest);
    expect(decoded).toHaveProperty('description', Option.none());
    expect(yield* Schema.encodeEffect(ManageAgentEntityRequestSchema)(decoded)).toEqual(createRequest);
  }),
);

it('does not accept omission of a required nullable description', () => {
  const { description, ...withoutDescription } = createRequest;
  expect(description).toBeNull();
  expect(Result.isFailure(Schema.decodeUnknownResult(ManageAgentEntityRequestSchema)(withoutDescription))).toBe(true);
});
