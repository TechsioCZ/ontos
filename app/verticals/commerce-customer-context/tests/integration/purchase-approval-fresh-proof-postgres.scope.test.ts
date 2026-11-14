import { orderCommitmentApprovalEvidenceRead } from '../../src/api/order-commitment-approval-evidence.read.ts';
import { OrderCommitmentApprovalEvidenceRequestSchema } from '../../shared/apis/order-commitment-approval-evidence.ts';
import type { OrderCommitmentApprovalEvidenceRequest } from '../../shared/apis/order-commitment-approval-evidence.ts';
import { purchasingApprovalWorkflowForScope } from '../../src/persistence/purchasing-approval-persistence.ts';
import {
  PurchasingApprovalRejected,
  RevalidatePurchaseApprovalInputSchema,
} from '../../shared/domain/purchasing-approval.ts';
import { randomUUID } from 'node:crypto';
import { ReadHandlerNotFound, ReadPolicyDenied, ReadRuntime } from '@app/core-runtime';
import { Context, DateTime, Effect, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import { extendedObservationSeconds, scenario, services } from './purchase-approval-fresh-proof-postgres.fixture.ts';

for (const scope of ['TENANT', 'STOREFRONT'] as const) {
  it.live(`rejects wrong ${scope} scope before Current authority and preserves existing P1`, () =>
    Effect.scoped(
      Effect.gen(function* wrongRegisteredScope() {
        const test = yield* scenario();
        const first = yield* test.check(randomUUID());
        const original = yield* test.readProofs();
        const request = yield* test.readRequest();
        yield* test.expire(first.revalidation.validUntil);
        const entries = test.authorityEntries();
        const refused = yield* Effect.flip(
          test.check(
            randomUUID(),
            scope === 'TENANT'
              ? {
                  counterpartyRef: yield* Schema.decodeUnknownEffect(
                    RevalidatePurchaseApprovalInputSchema.fields.counterpartyRef,
                  )({ ...test.chain.counterpartyRef, tenantId: randomUUID() }),
                }
              : {
                  storefrontId: yield* Schema.decodeUnknownEffect(
                    RevalidatePurchaseApprovalInputSchema.fields.storefrontId,
                  )('different-native-approval-storefront'),
                },
          ),
        );
        // Both mismatches are the governed Action's own trusted-scope guard (O62): the runner no
        // longer validates a legacy business-permission target, so the same domain rejection answers
        // a wrong Tenant and a wrong Storefront before the Current authority is consulted.
        const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(refused);
        expect(failure.code).toBe('PERMISSION_DENIED');
        expect(failure.reason).toBe('Revalidation scope must match trusted Counterparty Storefront context');
        expect(failure.retryable).toBe(false);
        expect(test.authorityEntries()).toBe(entries);
        expect(yield* test.readProofs()).toEqual(original);
        expect(yield* test.readRequest()).toEqual(request);
      }),
    ).pipe(Effect.provide(services)),
  );
}

it.live(
  'rolls back a genuinely inserted fresh owner proof when its enclosing transaction fails',
  () =>
    Effect.scoped(
      Effect.gen(function* nativeFreshProofRollback() {
        const test = yield* scenario();
        const first = yield* test.check(randomUUID());
        const original = yield* test.readProofs();
        const request = yield* test.readRequest();
        yield* test.expire(first.revalidation.validUntil);
        const intent = randomUUID();
        test.setObservationWindow(extendedObservationSeconds);
        const frame = yield* test.prepareReplayFrame(intent);
        const invocation = first.revalidation.evidence.actionInvocationId;
        assert.isOk(invocation !== undefined);
        // Owner component rollback control: actual Current factory and native INSERT, then an explicit
        // TEST enclosing-transaction failure. Reuse genuine P1 invocation metadata only inside this
        // rollback-only component control; no new registered invocation/Order provenance is claimed.
        const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(
            test.owner.fixture
              .prepareOwner(
                (transaction, scope) =>
                  Effect.gen(function* insertThenAbort() {
                    const workflow = yield* purchasingApprovalWorkflowForScope(transaction, scope);
                    const staged = yield* workflow.forActionInvocation(invocation).revalidate(frame);
                    expect(staged.outcome).toBe('APPROVAL_VALID');
                    expect(staged.revalidation.revalidationRef.resourceId).not.toBe(
                      first.revalidation.revalidationRef.resourceId,
                    );
                    return yield* Effect.fail(
                      new PurchasingApprovalRejected({
                        code: 'CURRENT_STATE_INDETERMINATE',
                        reason: 'TEST abort after successful native fresh-proof INSERT',
                        retryable: true,
                      }),
                    );
                  }),
                'required',
              )
              .pipe(Effect.provideContext(test.context)),
          ),
        );
        expect(failure.reason).toBe('TEST abort after successful native fresh-proof INSERT');
        expect(yield* test.readProofs()).toEqual(original);
        expect(yield* test.readRequest()).toEqual(request);
        // The rolled-back intent is reusable: it can subsequently commit exactly one new P2.
        const retried = yield* test.check(intent);
        expect(retried.outcome).toBe('APPROVAL_VALID');
        const committed = yield* test.readProofs();
        expect(committed).toHaveLength(2);
        expect(committed.find((row) => row.revalidationResourceId === original[0]?.revalidationResourceId)).toEqual(
          original[0],
        );
        expect(yield* test.readRequest()).toEqual(request);
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);

it.live(
  'reads exact fresh P2 and retained expired P1 through governed buyer evidence without renewing history',
  () =>
    Effect.scoped(
      Effect.gen(function* governedBuyerProofHistory() {
        // Governed lifecycle and CCC owner-read proof only. Final authority remains the scenario's
        // explicit TEST seam: no production HTTP, genuine final-owner issuance or full acceptance.
        const test = yield* scenario();
        const first = yield* test.check(randomUUID());
        const original = yield* test.readProofs();
        const request = yield* test.readRequest();
        yield* test.expire(first.revalidation.validUntil);
        test.setObservationWindow(extendedObservationSeconds);
        const second = yield* test.check(randomUUID());
        expect(second.revalidation.revalidationRef).not.toEqual(first.revalidation.revalidationRef);
        expect(DateTime.isGreaterThan(second.revalidation.checkedAt, first.revalidation.validUntil)).toBe(true);
        const proofs = yield* test.readProofs();
        expect(proofs).toHaveLength(2);
        expect(proofs.find((row) => row.revalidationResourceId === original[0]?.revalidationResourceId)).toEqual(
          original[0],
        );
        const before = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        const authorityEntries = test.authorityEntries();
        const reader = Context.get(test.context, ReadRuntime);
        const read = (input: OrderCommitmentApprovalEvidenceRequest) =>
          Effect.gen(function* governedEvidenceRead() {
            return yield* reader
              .runRead({
                audience: 'commerce-customer-context',
                input: yield* Schema.encodeEffect(OrderCommitmentApprovalEvidenceRequestSchema)(input),
                // Fresh TEST-signed, verified and redeemed principal for every read, including refusals.
                principal: yield* test.owner.authenticatedPrincipal(),
                registration: orderCommitmentApprovalEvidenceRead,
                transport: { correlationId: randomUUID(), targetModuleKey: 'commerce.customer-context' },
              })
              .pipe(Effect.provideContext(test.context));
          });
        const input = yield* Schema.decodeUnknownEffect(OrderCommitmentApprovalEvidenceRequestSchema)({
          counterpartyRef: test.chain.counterpartyRef,
          finalBinding: test.binding,
          operation: 'VERIFY_PROOF',
          requestRef: test.approved.request.requestRef,
          revalidationRef: second.revalidation.revalidationRef,
          storefrontId: test.owner.storefrontId,
        });
        assert.isOk(input.operation === 'VERIFY_PROOF');
        const fresh = yield* read(input);
        assert.isOk(fresh.operation === 'VERIFY_PROOF');
        expect(fresh.proof).toEqual({
          checkedAt: second.revalidation.checkedAt,
          evidence: second.revalidation.evidence,
          proposalRevisionRef: second.revalidation.proposalRevisionRef,
          requestRef: input.requestRef,
          revalidationRef: second.revalidation.revalidationRef,
          status: second.revalidation.status,
          validUntil: second.revalidation.validUntil,
        });
        expect(fresh.proposal).toEqual(test.chain.proposal);
        expect(fresh.request).toEqual(test.approved.request);
        const historical = yield* read({ ...input, revalidationRef: first.revalidation.revalidationRef });
        assert.isOk(historical.operation === 'VERIFY_PROOF');
        expect(historical.proof).toEqual({
          checkedAt: first.revalidation.checkedAt,
          evidence: first.revalidation.evidence,
          proposalRevisionRef: first.revalidation.proposalRevisionRef,
          requestRef: input.requestRef,
          revalidationRef: first.revalidation.revalidationRef,
          status: first.revalidation.status,
          validUntil: first.revalidation.validUntil,
        });
        expect(historical.request).toEqual(fresh.request);
        expect(historical.proposal).toEqual(fresh.proposal);
        // APPROVAL_VALID is the retained issuance status, not a claim that expired P1 is Current.
        expect(DateTime.isGreaterThanOrEqualTo((yield* test.owner.nativeNow()).at, historical.proof.validUntil)).toBe(
          true,
        );
        for (const patch of [
          { revalidationRef: { ...input.revalidationRef, resourceId: randomUUID() } },
          { finalBinding: { ...input.finalBinding, bundleHash: 'e'.repeat(64) } },
          { requestRef: { ...input.requestRef, tenantId: randomUUID() } },
        ]) {
          const mismatched = yield* Schema.decodeUnknownEffect(OrderCommitmentApprovalEvidenceRequestSchema)({
            ...input,
            ...patch,
          });
          const failure = yield* Schema.decodeUnknownEffect(ReadHandlerNotFound)(yield* Effect.flip(read(mismatched)));
          expect(failure.code).toBe('read_handler_not_found');
          expect(failure.reason).toBe('Approval evidence is unavailable');
        }
        const wrongStorefront = yield* Schema.decodeUnknownEffect(OrderCommitmentApprovalEvidenceRequestSchema)({
          ...input,
          storefrontId: 'different-native-approval-storefront',
        });
        // The v2 owner overlay checks the counterparty's own grant, which is scope-wide here; a
        // Storefront that does not match the retained proposal is therefore indistinguishable from
        // an unknown intent, exactly like the tenant and revision mismatches above (O62, O70).
        const scopeFailure = yield* Schema.decodeUnknownEffect(ReadHandlerNotFound)(
          yield* Effect.flip(read(wrongStorefront)),
        );
        expect(scopeFailure.code).toBe('read_handler_not_found');
        expect(scopeFailure.reason).toBe('Approval evidence is unavailable');
        expect(test.authorityEntries()).toBe(authorityEntries);
        expect(yield* test.readProofs()).toEqual(proofs);
        expect(yield* test.readRequest()).toEqual(request);
        const after = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        // Core must durably record the two allowed reads. No new business/Action effects are issued.
        expect(after.accesses).toHaveLength(before.accesses.length + 2);
        expect(after.invocations).toEqual(before.invocations);
        expect(after.audits).toEqual(before.audits);
        expect(after.events).toEqual(before.events);
        expect(after.outbox).toEqual(before.outbox);
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);

it.live(
  'recovers exact original buyer intents after losing proof refs, including expired P1, without new effects',
  () =>
    Effect.scoped(
      Effect.gen(function* exactBuyerIntentRecovery() {
        // Native CCC + real ReadRuntime only. Final authority remains the explicit TEST seam;
        // no production HTTP, genuine Order eligibility or positive consumption is claimed.
        const test = yield* scenario();
        const i1 = randomUUID();
        const p1 = yield* test.check(i1);
        yield* test.expire(p1.revalidation.validUntil);
        test.setObservationWindow(extendedObservationSeconds);
        const i2 = randomUUID();
        const p2 = yield* test.check(i2);
        expect(p2.revalidation.revalidationRef).not.toEqual(p1.revalidation.revalidationRef);
        // A different real actor receives the same permission; retained buyer checks still apply.
        const otherBuyer = yield* test.owner.authorizeRecoveryReader(test.chain.counterpartyRef);
        const foreign = yield* test.owner.createRequest({ ttlMilliseconds: 60_000 });
        const proofs = yield* test.readProofs();
        const requests = yield* test.readRequest();
        const before = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        const entries = test.authorityEntries();
        const reader = Context.get(test.context, ReadRuntime);
        const read = (input: OrderCommitmentApprovalEvidenceRequest, actor = test.owner.fixture.manager) =>
          Effect.gen(function* recoverThroughRealReadRuntime() {
            return yield* reader
              .runRead({
                audience: 'commerce-customer-context',
                input: yield* Schema.encodeEffect(OrderCommitmentApprovalEvidenceRequestSchema)(input),
                principal: yield* test.owner.authenticatedPrincipal(actor),
                registration: orderCommitmentApprovalEvidenceRead,
                transport: { correlationId: randomUUID(), targetModuleKey: 'commerce.customer-context' },
              })
              .pipe(Effect.provideContext(test.context));
          });
        // No proofRef, proposalRef, revision or issuer is supplied: I1/I2 recover them durably.
        const input = yield* Schema.decodeUnknownEffect(OrderCommitmentApprovalEvidenceRequestSchema)({
          commitmentCorrelationId: p1.revalidation.evidence.commitmentCorrelationId,
          counterpartyRef: test.chain.counterpartyRef,
          finalBinding: test.binding,
          idempotencyKey: i1,
          operation: 'RECOVER_REVALIDATION',
          requestRef: test.approved.request.requestRef,
          storefrontId: test.owner.storefrontId,
        });
        assert.isOk(input.operation === 'RECOVER_REVALIDATION');
        const first = yield* read(input);
        assert.isOk(first.operation === 'RECOVER_REVALIDATION' && first.recovery === 'FOUND');
        expect(first.result).toEqual(p1);
        expect(first.request).toEqual(test.approved.request);
        expect(first.proposal).toEqual(test.chain.proposal);
        expect(
          DateTime.isGreaterThanOrEqualTo((yield* test.owner.nativeNow()).at, first.result.revalidation.validUntil),
        ).toBe(true);
        const second = yield* read({ ...input, idempotencyKey: i2 });
        assert.isOk(second.operation === 'RECOVER_REVALIDATION' && second.recovery === 'FOUND');
        expect(second.result).toEqual(p2);
        for (const recovered of [first.result.revalidation, second.result.revalidation]) {
          expect(recovered.evidence.actorPrincipalId).toBe(test.owner.principal.principalId);
          expect(
            proofs.find((proof) => proof.revalidationResourceId === recovered.revalidationRef.resourceId)
              ?.actionInvocationId,
          ).toBe(recovered.evidence.actionInvocationId);
        }
        const absent = { operation: 'RECOVER_REVALIDATION', recovery: 'NOT_FOUND' } as const;
        expect(yield* read({ ...input, idempotencyKey: randomUUID() })).toEqual(absent);
        for (const patch of [
          { finalBinding: { ...input.finalBinding, bundleHash: 'e'.repeat(64) } },
          {
            finalBinding: {
              ...input.finalBinding,
              attemptRef: { ...input.finalBinding.attemptRef, resourceId: randomUUID() },
            },
          },
          { commitmentCorrelationId: randomUUID() },
          { requestRef: { ...input.requestRef, resourceId: randomUUID() } },
        ]) {
          const changed = yield* Schema.decodeUnknownEffect(OrderCommitmentApprovalEvidenceRequestSchema)({
            ...input,
            ...patch,
          });
          const failure = yield* Schema.decodeUnknownEffect(ReadPolicyDenied)(yield* Effect.flip(read(changed)));
          expect(failure.httpStatus).toBe(409);
          expect(failure.policyReasonCode).toBe('APPROVAL_REVALIDATION_INTENT_CONFLICT');
        }
        // Authorized foreign buyer/Counterparty cannot distinguish a retained from unknown intent.
        expect(yield* read(input, otherBuyer)).toEqual(absent);
        expect(yield* read({ ...input, idempotencyKey: randomUUID() }, otherBuyer)).toEqual(absent);
        const foreignScope = yield* Schema.decodeUnknownEffect(OrderCommitmentApprovalEvidenceRequestSchema)({
          ...input,
          counterpartyRef: foreign.counterpartyRef,
          requestRef: foreign.request.request.requestRef,
        });
        expect(yield* read(foreignScope)).toEqual(absent);
        expect(
          yield* read(
            yield* Schema.decodeUnknownEffect(OrderCommitmentApprovalEvidenceRequestSchema)({
              ...foreignScope,
              idempotencyKey: randomUUID(),
            }),
          ),
        ).toEqual(absent);
        const wrongTenant = yield* Schema.decodeUnknownEffect(OrderCommitmentApprovalEvidenceRequestSchema)({
          ...input,
          requestRef: { ...input.requestRef, tenantId: randomUUID() },
        });
        expect(Schema.is(ReadHandlerNotFound)(yield* Effect.flip(read(wrongTenant)))).toBe(true);
        const wrongStorefront = yield* Schema.decodeUnknownEffect(OrderCommitmentApprovalEvidenceRequestSchema)({
          ...input,
          storefrontId: 'different-native-approval-storefront',
        });
        // The v2 owner overlay checks the counterparty's own scope-wide grant, so a Storefront that
        // does not match the retained intent recovers exactly as an unknown intent: NOT_FOUND, with
        // no effect on history (O62, O70).
        expect(yield* read(wrongStorefront)).toEqual(absent);
        expect(test.authorityEntries()).toBe(entries);
        expect(yield* test.readProofs()).toEqual(proofs);
        expect(yield* test.readRequest()).toEqual(requests);
        const after = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        // Eight successful governed results: two FOUND and six indistinguishable NOT_FOUND.
        // Core additionally records denied-read evidence for conflicts. No new Action effects.
        const priorAccessIds = new Set(before.accesses.map((access) => access.dataAccessEventId));
        const recoveryReads = after.accesses.filter(
          (access) => !priorAccessIds.has(access.dataAccessEventId) && access.outcome === 'allowed',
        );
        expect(recoveryReads).toHaveLength(8);
        expect(recoveryReads.filter((access) => access.resultCount === 1)).toHaveLength(2);
        expect(recoveryReads.filter((access) => access.resultCount === 0)).toHaveLength(6);
        for (const access of recoveryReads) {
          expect(access.evidencePolicyKey).toBe(
            orderCommitmentApprovalEvidenceRead.descriptor.evidencePolicy.policyKey,
          );
          expect(access.servingModuleKey).toBe('commerce.customer-context');
          expect(access.actionInvocationId).toBeNull();
        }
        expect(after.audits.filter((audit) => audit.actionInvocationId !== null)).toEqual(
          before.audits.filter((audit) => audit.actionInvocationId !== null),
        );
        expect(after.invocations).toEqual(before.invocations);
        expect(after.events).toEqual(before.events);
        expect(after.outbox).toEqual(before.outbox);
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);
