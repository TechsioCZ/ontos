import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  decisionSetProofResourceId,
  readDecisionSetFenceTokenFromQuery,
} from '../../src/services/decision-set-proof.ts';
import { DecisionSetProofRefSchema } from '../../shared/resources/decision-set-proof.ts';

const query = { kind: 'applicable-boundaries', purpose: 'PURCHASE', tenantId: 'tenant-1' };
const reorderedQuery = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
  '{"purpose":"PURCHASE","kind":"applicable-boundaries"}',
);
const reorderedRows = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Json)))('[{"b":2,"a":1}]');

it.effect('creates a valid resource ID for an empty complete result', () =>
  Effect.gen(function* createsResourceId() {
    const resourceId = yield* decisionSetProofResourceId({ fenceToken: 'fence-1', query, rows: [] });
    expect(
      Schema.is(DecisionSetProofRefSchema)({
        moduleId: 'commerce.assortment',
        resourceId,
        resourceType: 'commerce.assortment.decision-set-proof',
        tenantId: '10000000-0000-4000-8000-000000000001',
      }),
    ).toBe(true);
  }),
);

it.effect('changes an otherwise identical empty-set proof when the fence advances', () =>
  Effect.gen(function* invalidatesAfterInsertion() {
    const beforeInsertion = yield* decisionSetProofResourceId({ fenceToken: 'fence-1', query, rows: [] });
    const afterInsertion = yield* decisionSetProofResourceId({
      fenceToken: 'fence-2',
      query,
      rows: [],
    });
    expect(afterInsertion).not.toBe(beforeInsertion);
  }),
);

it.effect('canonicalizes object key order while binding both the query and exact rows', () =>
  Effect.gen(function* canonicalizesProof() {
    const left = yield* decisionSetProofResourceId({
      fenceToken: 'fence-1',
      query: { kind: 'applicable-boundaries', purpose: 'PURCHASE' },
      rows: [{ a: 1, b: 2 }],
    });
    const reordered = yield* decisionSetProofResourceId({
      fenceToken: 'fence-1',
      query: reorderedQuery,
      rows: reorderedRows,
    });
    const differentQuery = yield* decisionSetProofResourceId({
      fenceToken: 'fence-1',
      query: { kind: 'ordinary-candidates', purpose: 'PURCHASE' },
      rows: [{ a: 1, b: 2 }],
    });
    expect(reordered).toBe(left);
    expect(differentQuery).not.toBe(left);
  }),
);

it.effect('reads the current fence value', () =>
  Effect.gen(function* locksFence() {
    const token = yield* readDecisionSetFenceTokenFromQuery(() => Effect.succeed([{ generation: 'fence-1' }]));
    expect(token).toBe('fence-1');
  }),
);

it.effect('fails closed when a tenant has no fence row', () =>
  Effect.gen(function* missingFence() {
    const result = yield* Effect.result(readDecisionSetFenceTokenFromQuery(() => Effect.succeed([])));
    expect(Result.isFailure(result)).toBe(true);
  }),
);
