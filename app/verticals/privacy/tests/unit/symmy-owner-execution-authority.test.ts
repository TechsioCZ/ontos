import { TestClock } from 'effect/testing';
import { webCryptoDigestFixture } from '@app/core-runtime/testing/webcrypto-digest';
import { WebCrypto } from 'effect/crypto';
import { Effect, Fiber, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';
import {
  fingerprintSymmyOwnerHandoff,
  resolveSymmyOwnerExecutionReceipt,
} from '../../src/integrations/symmy-owner-execution-authority.ts';
import { OwnerExecutionOutcomeSchema } from '../../shared/domain/privacy-measure-handoff.ts';
import { makeMeasureExecutionFixture } from '../support/measure-execution.fixture.ts';

it.effect(
  'independently reads the exact historical Symmy outcome and rejects receipt and complete-scope substitution',
  () =>
    Effect.gen(function* exactSymmyOwnerReceipt() {
      const tenantId = '75000000-0000-4000-8000-000000000001';
      const legalEntityId = '75000000-0000-4000-8000-000000000002';
      const principalId = '75000000-0000-4000-8000-000000000003';
      const fixture = makeMeasureExecutionFixture(tenantId);
      const context = {
        actionInvocationId: '75000000-0000-4000-8000-000000000004',
        dispatchOriginator: {
          actionInvocationId: '75000000-0000-4000-8000-000000000005',
          compositionRevision: 'a'.repeat(64),
        },
        handoff: fixture.handoff,
        legalEntityId,
        principalId,
        scope: {
          authMethod: 'session' as const,
          correlationId: 'internal:symmy-receipt',
          legalEntityId,
          principalId,
          tenantId,
        },
        tenantId,
      };
      const request = { attempt: 1, measureId: fixture.handoff.measureId, taskId: fixture.handoff.taskId };
      const outcome = Schema.decodeUnknownSync(OwnerExecutionOutcomeSchema)({
        attempt: 1,
        evidenceRefs: ['internal:actual-symmy-receipt'],
        idempotencyKey: fixture.handoff.idempotencyKey,
        includedResourceRefs: fixture.handoff.resourceRefs,
        measureId: fixture.handoff.measureId,
        occurredAt: fixture.decidedAt,
        outcomeId: '75000000-0000-4000-8000-000000000006',
        owningCapability: 'integration.symmy',
        reason: 'Internal exact operational intent erasure receipt',
        recordedAt: fixture.decidedAt,
        remainingResourceRefs: [],
        sourceDecisionRef: fixture.handoff.sourceDecisionRef,
        sourceDecisionRevision: 1,
        status: 'SUCCEEDED',
        taskId: fixture.handoff.taskId,
      });
      const receipt = {
        actionInvocationId: '75000000-0000-4000-8000-000000000007',
        handoffFingerprint: yield* fingerprintSymmyOwnerHandoff(fixture.handoff),
        outcome,
      };
      let body = JSON.stringify(receipt);
      let status = 200;
      const fakeFetch: typeof globalThis.fetch = (url, init) => {
        const actual = new Request(url, init);
        expect(actual.url).toContain('/reads/symmy-job-privacy-execution');
        expect(actual.headers.get('authorization')).toBe('Bearer internal-public-owner-fixture');
        return actual.json().then((payload) => {
          expect(payload).toEqual({ attempt: 1, idempotencyKey: fixture.handoff.idempotencyKey });
          return new Response(body, { headers: { 'content-type': 'application/json' }, status });
        });
      };
      const transport = {
        authorization: Redacted.make('Bearer internal-public-owner-fixture'),
        baseUrl: 'https://symmy.test',
        compositionRevision: 'a'.repeat(64),
      };
      const read = () =>
        resolveSymmyOwnerExecutionReceipt(request, context, transport).pipe(
          Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
        );
      expect((yield* read()).outcome).toEqual(outcome);
      for (const host of [
        webCryptoDigestFixture(() => Promise.reject(new Error('private digest failure'))),
        webCryptoDigestFixture(() => Promise.withResolvers<ArrayBuffer>().promise),
      ]) {
        const fiber = yield* read().pipe(Effect.provide(WebCrypto.layer(host)), Effect.flip, Effect.forkChild);
        yield* TestClock.adjust('5 seconds');
        const failure = yield* Fiber.join(fiber);
        expect(failure.code).toBe('privacy_operation_persistence_unavailable');
      }
      for (const changed of [
        { ...receipt, handoffFingerprint: 'b'.repeat(64) },
        { ...receipt, outcome: { ...outcome, attempt: 2 } },
        { ...receipt, outcome: { ...outcome, includedResourceRefs: ['other:resource'] } },
        { ...receipt, outcome: { ...outcome, sourceDecisionRef: 'other:decision' } },
      ]) {
        body = JSON.stringify(changed);
        expect((yield* Effect.flip(read())).code).toBe('privacy_operation_conflict');
      }
      body = 'null';
      expect((yield* Effect.flip(read())).code).toBe('privacy_operation_persistence_unavailable');
      status = 503;
      body = '{}';
      expect((yield* Effect.flip(read())).code).toBe('privacy_operation_persistence_unavailable');
    }),
);
