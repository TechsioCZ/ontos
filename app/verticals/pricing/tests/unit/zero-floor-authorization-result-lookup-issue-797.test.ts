import { ReadHandlerUnavailable } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  ZeroFloorAuthorizationResultLookupRequestSchema,
  ZeroFloorAuthorizationResultLookupResponseSchema,
} from '../../shared/apis/zero-floor-authorization-result-lookup.ts';
import { readZeroFloorAuthorizationResult } from '../../src/api/zero-floor-authorization-result-lookup.read.ts';
import { ZeroFloorAuthorizationPersistenceUnavailable } from '../../src/services/zero-floor-authorization-persistence.service.ts';
import { composePricingRawLines } from '../../src/services/line-value-composition.service.ts';
import { authorizationSetFor, firstRawLine, makeIssue779Scenario } from './support/issue-779-line-value.fixture.ts';

const actionInvocationId = '79700000-0000-4000-8000-000000000001';
const actingPrincipalId = 'pricing-governance-principal';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const input = Schema.decodeSync(ZeroFloorAuthorizationResultLookupRequestSchema)({ actionInvocationId });

describe('ZERO_FLOOR governed result lookup issue #797', () => {
  it('requires the canonical Action invocation UUID before the governed read', () => {
    expect(() =>
      Schema.decodeSync(ZeroFloorAuthorizationResultLookupRequestSchema)({
        actionInvocationId: 'not-an-action-invocation-uuid',
      }),
    ).toThrow();
    expect(input.actionInvocationId).toBe(actionInvocationId);
  });

  it.effect('binds lookup to the trusted actor and returns the original committed owner result', () =>
    Effect.gen(function* readsOriginalResult() {
      const pricing = yield* makeIssue779Scenario({ discounts: ['40', '40', '40'] });
      const composition = yield* composePricingRawLines(pricing.compositionRequest);
      const lines =
        composition.outcome === 'RAW_COMPOSITION_READY'
          ? composition.lines
          : yield* Effect.die('Expected raw composition fixture');
      const authorization =
        authorizationSetFor(firstRawLine(lines)).authorizations[0] ??
        (yield* Effect.die('Expected ZERO_FLOOR Authorization fixture'));
      const found = {
        actionInvocationId,
        outcome: 'ZERO_FLOOR_AUTHORIZATION_RESULT_FOUND' as const,
        result: {
          outcome: 'ZERO_FLOOR_AUTHORIZATION_CREATED' as const,
          revision: {
            authorization,
            lineage: { rootAuthorizationRef: authorization.authorizationRef, transition: 'CREATED' as const },
            recordedAt: '2026-09-28T12:00:00.000Z',
            revisionNumber: 1,
            scheduleRevision: 1,
            scheduleState: 'SCHEDULED' as const,
          },
          setGeneration: 8,
        },
      };
      let observedQuery: unknown;
      const result = yield* readZeroFloorAuthorizationResult(
        input,
        { legalEntityId, principalId: actingPrincipalId },
        {
          lookupResult: (query) => {
            observedQuery = query;
            return Effect.succeed(found);
          },
        },
      );
      expect(observedQuery).toEqual({ actingPrincipalId, actionInvocationId });
      expect(result).toEqual(found);
      expect(Schema.is(ZeroFloorAuthorizationResultLookupResponseSchema)(result)).toBe(true);
      expect(() =>
        Schema.decodeUnknownSync(ZeroFloorAuthorizationResultLookupRequestSchema, {
          onExcessProperty: 'error',
        })({ actingPrincipalId: 'caller-must-not-supply-actor', actionInvocationId }),
      ).toThrow();
    }),
  );

  it.effect('returns typed absence, rejects unexpected receipt, and preserves persistence failure', () =>
    Effect.gen(function* handlesMissingResult() {
      const absent = { actionInvocationId, outcome: 'ZERO_FLOOR_AUTHORIZATION_RESULT_ABSENT' as const };
      const absentResult = yield* readZeroFloorAuthorizationResult(
        input,
        { legalEntityId, principalId: actingPrincipalId },
        { lookupResult: () => Effect.succeed(absent) },
      );
      expect(absentResult).toEqual(absent);
      const nonterminalReceipt = yield* readZeroFloorAuthorizationResult(
        input,
        { legalEntityId, principalId: actingPrincipalId },
        {
          lookupResult: () =>
            Effect.succeed({
              actionInvocationId,
              outcome: 'ZERO_FLOOR_AUTHORIZATION_RESULT_FOUND',
              result: {
                authorizationRef: 'zero-floor-auth:779',
                outcome: 'ZERO_FLOOR_AUTHORIZATION_CONFLICT',
                reason: 'EXPECTED_CURRENT_STALE',
              },
            }),
        },
      );
      let reads = 0;
      const services = {
        lookupResult: () => {
          reads += 1;
          return Effect.fail(new ZeroFloorAuthorizationPersistenceUnavailable({ reason: 'Owner unavailable' }));
        },
      };
      const noScope = yield* readZeroFloorAuthorizationResult(
        input,
        { legalEntityId: null, principalId: actingPrincipalId },
        services,
      );
      const unavailableOutcome = {
        actionInvocationId,
        outcome: 'ZERO_FLOOR_AUTHORIZATION_RESULT_UNAVAILABLE',
        retryable: true,
      } as const;
      expect(noScope).toEqual(unavailableOutcome);
      expect(nonterminalReceipt).toEqual(unavailableOutcome);
      const failure = yield* readZeroFloorAuthorizationResult(
        input,
        { legalEntityId, principalId: actingPrincipalId },
        services,
      ).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(ReadHandlerUnavailable);
      expect(failure.cause).toBeInstanceOf(ZeroFloorAuthorizationPersistenceUnavailable);
      expect(reads).toBe(1);
      expect(Schema.is(ZeroFloorAuthorizationResultLookupResponseSchema)(unavailableOutcome)).toBe(true);
    }),
  );
});
