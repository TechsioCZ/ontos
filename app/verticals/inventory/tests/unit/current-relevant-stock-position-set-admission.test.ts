import { NodeCrypto } from '@effect/platform-node';
import { ReadPermissionDenied, ReadPermissionUnavailable } from '@app/core-runtime';
import { makeScriptedBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { inventoryRegistration } from '../../vertical.registration.ts';
import { currentRelevantStockPositionSetRead } from '../../src/api/current-relevant-stock-position-set.read.ts';
import { PositionSetCommerceVerifier } from '../../src/services/current-relevant-stock-position-set.service.ts';
import { request, scope } from '../support/current-relevant-stock-position-set.ts';
import { CurrentRelevantStockPositionSetRequestSchema } from '../../shared/apis/current-relevant-stock-position-set.ts';

const compositionRevision = 'a'.repeat(64);
const operationTime = new Date('2026-10-05T12:00:00.000Z');
const wireInput = Schema.encodeSync(CurrentRelevantStockPositionSetRequestSchema)(request);
const principal = scope;

it.layer(NodeCrypto.layer)('Inventory Position-set admission', (suite) => {
  for (const outcome of ['denied', 'unavailable'] as const) {
    suite.effect(`canonical ${outcome} admission never observes or discloses an Inventory Position-set`, () =>
      Effect.gen(function* refusedPositionSet() {
        const gate = makeScriptedBoundAccessGate(outcome);
        const harness = yield* makeReadTestHarness({
          accessDecision: gate.bound,
          compositionRevision,
          executeOwnerQuery: () => Effect.die('A refused Position-set read must not query owner data'),
          operationTime,
          ownerAuthorizationDecision: 'allowed',
          ownerRegistration: inventoryRegistration,
          scope,
        });
        const failure = yield* harness.runtime
          .runRead({
            input: wireInput,
            principal,
            registration: currentRelevantStockPositionSetRead,
            transport: { correlationId: scope.correlationId },
          })
          .pipe(
            Effect.provideService(PositionSetCommerceVerifier, {
              verify: () => Effect.die('A refused read must not contact Commerce'),
            }),
            Effect.flip,
          );
        expect(
          outcome === 'denied'
            ? Schema.is(ReadPermissionDenied)(failure)
            : Schema.is(ReadPermissionUnavailable)(failure),
        ).toBe(true);
        expect(gate.accessDecision.askedDecisions).toHaveLength(1);
        expect(gate.accessDecision.askedDecisions[0]?.carrier.accessDeclaration).toEqual(
          currentRelevantStockPositionSetRead.descriptor.accessDeclaration,
        );
        expect(harness.snapshot().ownerQueries).toEqual([]);
        expect(harness.snapshot().stages).not.toContain('handler_executed');
      }),
    );
  }

  suite.effect('an admitted Position-set without fresh Commerce authority remains unproven, not complete empty', () =>
    Effect.gen(function* unprovenPositionSet() {
      const gate = makeScriptedBoundAccessGate('allowed');
      const harness = yield* makeReadTestHarness({
        accessDecision: gate.bound,
        compositionRevision,
        executeOwnerQuery: () => Effect.die('An unproven Commerce scope must not observe owner Positions'),
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: inventoryRegistration,
        scope,
      });
      const result = yield* harness.runtime.runRead({
        input: wireInput,
        principal,
        registration: currentRelevantStockPositionSetRead,
        transport: { correlationId: scope.correlationId },
      });
      expect(result).toEqual({ outcome: 'UNPROVEN', reason: 'COMMERCE_CONTEXT_UNVERIFIABLE' });
      expect(gate.accessDecision.askedDecisions).toHaveLength(1);
      expect(harness.snapshot().ownerQueries).toEqual([]);
      expect(harness.snapshot().evidenceWrites).toBe(1);
    }),
  );
});
