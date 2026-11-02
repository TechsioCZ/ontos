import { ApprovalOwnerGateway } from '../../src/services/approval-owner-gateway.ts';
import { OrderFinalSourceVerification } from '../../src/services/order-final-source-verification.service.ts';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Layer, Predicate, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { CompleteOrderApprovalConsumptionPayloadSchema } from '../../shared/actions/complete-order-approval-consumption.ts';
import { CompleteOrderPreparationPayloadSchema } from '../../shared/actions/complete-order-preparation.ts';
import { RecordOrderProofSetPayloadSchema } from '../../shared/actions/record-order-proof-set.ts';
import { completeOrderPreparationAction } from '../../src/actions/complete-order-preparation.action.ts';
import { recordOrderProofSetAction } from '../../src/actions/record-order-proof-set.action.ts';
import { completeOrderApprovalConsumptionAction } from '../../src/actions/complete-order-approval-consumption.action.ts';

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:order-stage-authorization',
  authMethod: 'session',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '40000000-0000-4000-8000-000000000001',
} as const;
const ref = (kind: string) => ({
  moduleId: 'commerce.order',
  resourceId: 'original-intent',
  resourceType: `commerce.order.${kind}`,
  tenantId: principal.tenantId,
});
// The denial gates fire before any owner work; reaching these services is a defect.
const unreachableOwnerServices = Layer.mergeAll(
  Layer.mock(ApprovalOwnerGateway, {}),
  Layer.mock(OrderFinalSourceVerification, {}),
);
type Harness = Effect.Success<ReturnType<typeof makeActionTestHarness>>;
interface CompletionTransport {
  readonly correlationId: string;
  readonly idempotencyKey?: string;
}
interface Completion {
  readonly label: string;
  readonly run: (
    harness: Harness,
    transport: CompletionTransport,
  ) => Effect.Effect<unknown, unknown, ApprovalOwnerGateway | OrderFinalSourceVerification>;
}
const completions: readonly Completion[] = [
  {
    label: 'preparation',
    run: (harness, transport) =>
      Schema.decodeUnknownEffect(CompleteOrderPreparationPayloadSchema)({ intentRef: ref('finalization-intent') }).pipe(
        Effect.flatMap((payload) =>
          harness.runtime.runAction({ payload, principal, registration: completeOrderPreparationAction, transport }),
        ),
      ),
  },
  {
    label: 'proof set',
    run: (harness, transport) =>
      Schema.decodeUnknownEffect(RecordOrderProofSetPayloadSchema)({
        intentRef: ref('proof-request'),
        outcome: 'APPROVAL_REQUEST_TERMINAL',
      }).pipe(
        Effect.flatMap((payload) =>
          harness.runtime.runAction({ payload, principal, registration: recordOrderProofSetAction, transport }),
        ),
      ),
  },
  {
    label: 'consumption',
    run: (harness, transport) =>
      Schema.decodeUnknownEffect(CompleteOrderApprovalConsumptionPayloadSchema)({ intentRef: ref('order') }).pipe(
        Effect.flatMap((payload) =>
          harness.runtime.runAction({
            payload,
            principal,
            registration: completeOrderApprovalConsumptionAction,
            transport,
          }),
        ),
      ),
  },
];

// The public Core harness executes the actual owner registration and handler gates.
// It supplies no owner data, foreign proof, SQL result, or genuine issuance claim.
describe('Order restricted stage completions', () => {
  for (const completion of completions) {
    it.effect(`denies a buyer without executor permission before ${completion.label} owner work`, () =>
      Effect.gen(function* denyWithoutExecutorPermission() {
        const harness = yield* makeActionTestHarness({ actionPermission: 'denied', tenantPermission: 'allowed' });
        const failure = yield* completion
          .run(harness, { correlationId: 'order-stage-denied', idempotencyKey: `denied:${completion.label}` })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);
        expect(harness.snapshot().transactionCount).toBe(0);
        expect(harness.snapshot().committed).toHaveLength(0);
        expect(harness.snapshot().stages).not.toContain('handler_executed');
      }).pipe(Effect.provide(unreachableOwnerServices)),
    );
    it.effect(`stops ${completion.label} when the Tenant module is suspended`, () =>
      Effect.gen(function* stopWhenModuleSuspended() {
        const harness = yield* makeActionTestHarness({
          actionPermission: 'allowed',
          moduleState: 'suspended',
          tenantPermission: 'allowed',
        });
        const failure = yield* completion
          .run(harness, { correlationId: 'order-stage-suspended', idempotencyKey: `suspended:${completion.label}` })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(failure, 'ModuleStateDeniedError')).toBe(true);
        expect(harness.snapshot().committed).toHaveLength(0);
        expect(harness.snapshot().stages).not.toContain('handler_executed');
      }).pipe(Effect.provide(unreachableOwnerServices)),
    );
    it.effect(`requires a stable completion key before ${completion.label} invocation`, () =>
      Effect.gen(function* requireStableCompletionKey() {
        const harness = yield* makeActionTestHarness({ actionPermission: 'allowed', tenantPermission: 'allowed' });
        const failure = yield* completion.run(harness, { correlationId: 'order-stage-missing-key' }).pipe(Effect.flip);
        expect(Predicate.isTagged(failure, 'ActionIdempotencyKeyRequired')).toBe(true);
        expect(harness.snapshot().invocations).toHaveLength(0);
        expect(harness.snapshot().transactionCount).toBe(0);
      }).pipe(Effect.provide(unreachableOwnerServices)),
    );
  }
});
