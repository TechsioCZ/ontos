import {
  PurchaseApprovalFinalBindingSchema,
  PurchasingApprovalRejected,
  TrustedRevalidatePurchaseApprovalInputSchema,
} from '../../shared/domain/purchasing-approval.ts';
import type { TrustedRevalidatePurchaseApprovalInput } from '../../shared/domain/purchasing-approval.ts';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import {
  extendedObservationSeconds,
  initialObservationSeconds,
  scenario,
  services,
} from './purchase-approval-fresh-proof-postgres.fixture.ts';

// These native clone/migration scenarios measured 31–32s with 20–31 assertions completed under shard load.
it.live(
  'commits distinct immutable same-Attempt proofs after expiry and refuses expired intent replay',
  () =>
    Effect.scoped(
      Effect.gen(function* distinctDurableProofs() {
        const test = yield* scenario();
        const intent = randomUUID();
        const first = yield* test.check(intent);
        expect(first.outcome).toBe('APPROVAL_VALID');
        expect(first.revalidation.evidence.finalBindingEvidence?.binding).toEqual(test.binding);
        const firstEvidence = first.revalidation.evidence.finalBindingEvidence;
        assert.isOk(firstEvidence !== undefined);
        expect(firstEvidence.validUntil).toEqual(
          DateTime.add(firstEvidence.observedAt, { seconds: initialObservationSeconds }),
        );
        const original = yield* test.readProofs();
        expect(original).toHaveLength(1);
        const authorityEntriesBeforeUnsignedClaim = test.authorityEntries();
        const unsignedClaim = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(test.check(intent, { expectedProposalHash: 'e'.repeat(64) })),
        );
        expect(unsignedClaim.code).toBe('PERMISSION_DENIED');
        expect(unsignedClaim.reason).toBe('The claimed approval identity does not match the owner-current snapshots');
        expect(test.authorityEntries()).toBe(authorityEntriesBeforeUnsignedClaim);
        expect(yield* test.readProofs()).toEqual(original);
        const replay = yield* test.check(intent);
        expect(replay.revalidation.revalidationRef).toEqual(first.revalidation.revalidationRef);
        expect(replay.revalidation.checkedAt).toEqual(first.revalidation.checkedAt);
        yield* test.expire(first.revalidation.validUntil);
        const refusal = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(test.check(intent)),
        );
        expect(refusal.code).toBe('OWNER_CONFIRMATION_EXPIRED');
        const second = yield* test.check(randomUUID());
        expect(second.revalidation.revalidationRef.resourceId).not.toBe(first.revalidation.revalidationRef.resourceId);
        expect(second.revalidation.requestRef).toEqual(first.revalidation.requestRef);
        expect(second.revalidation.evidence.finalBindingEvidence?.binding).toEqual(test.binding);
        const records = yield* test.readProofs();
        expect(records).toHaveLength(2);
        expect(records.find((row) => row.revalidationResourceId === original[0]?.revalidationResourceId)).toEqual(
          original[0],
        );
        expect(DateTime.isGreaterThan(second.revalidation.checkedAt, first.revalidation.checkedAt)).toBe(true);
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);

it.live(
  'rejects proof-changing writer frames after actual Current resolution without new effects or history',
  () =>
    Effect.scoped(
      Effect.gen(function* nativeWriterIntegrityControls() {
        const test = yield* scenario();
        const intent = randomUUID();
        const first = yield* test.check(intent);
        const invocation = first.revalidation.evidence.actionInvocationId;
        assert.isOk(invocation !== undefined);
        yield* test.expire(first.revalidation.validUntil);
        test.setObservationWindow(extendedObservationSeconds);
        // These are deliberately corrupted owner-service frames, not legitimate lifecycle changes
        // or genuine Order facts. Every baseline frame first passes the actual Current factory.
        for (const replay of [false, true]) {
          const frame = yield* test.prepareReplayFrame(replay ? intent : randomUUID());
          const changedBinding = { ...frame.finalBinding, bundleHash: 'e'.repeat(64) };
          const changedAttempt = yield* Schema.decodeUnknownEffect(Schema.toType(PurchaseApprovalFinalBindingSchema))({
            ...frame.finalBinding,
            attemptRef: { ...frame.finalBinding.attemptRef, resourceId: randomUUID() },
          });
          const controls: {
            readonly code: PurchasingApprovalRejected['code'];
            readonly label: string;
            readonly patch: Partial<TrustedRevalidatePurchaseApprovalInput>;
          }[] = [
            {
              code: 'PROPOSAL_MATERIAL_CHANGE',
              label: 'request',
              patch: { requestRef: { ...frame.requestRef, resourceId: randomUUID() } },
            },
            {
              code: 'PROPOSAL_MATERIAL_CHANGE',
              label: 'proposal reference',
              patch: { proposalRevisionRef: { ...frame.proposalRevisionRef, resourceId: randomUUID() } },
            },
            {
              code: 'PROPOSAL_MATERIAL_CHANGE',
              label: 'proposal hash',
              patch: { expectedProposalHash: 'e'.repeat(64) },
            },
            {
              code: 'PROPOSAL_MATERIAL_CHANGE',
              label: 'decision reference',
              patch: { decisionRef: { ...frame.decisionRef, resourceId: randomUUID() } },
            },
            { code: 'PROPOSAL_MATERIAL_CHANGE', label: 'decision hash', patch: { decisionBundleHash: 'e'.repeat(64) } },
            {
              code: 'PROPOSAL_MATERIAL_CHANGE',
              label: 'route',
              patch: { routeRef: { ...frame.routeRef, resourceId: randomUUID() } },
            },
            {
              code: 'PROPOSAL_MATERIAL_CHANGE',
              label: 'hierarchy',
              patch: { hierarchyRef: { ...frame.hierarchyRef, resourceId: randomUUID() } },
            },
            {
              code: 'PROPOSAL_MATERIAL_CHANGE',
              label: 'source vector',
              patch: {
                sourceRevisions: frame.sourceRevisions.map((source) => ({ ...source, revision: source.revision + 1 })),
              },
            },
            {
              code: 'PERMISSION_DENIED',
              label: 'final binding versus observation',
              patch: { finalBinding: changedBinding },
            },
            {
              code: 'PERMISSION_DENIED',
              label: 'different binding with matching observation',
              patch: {
                finalBinding: changedBinding,
                finalBindingEvidence: { ...frame.finalBindingEvidence, binding: changedBinding },
              },
            },
            {
              code: 'PERMISSION_DENIED',
              label: 'different Attempt with matching observation',
              patch: {
                finalBinding: changedAttempt,
                finalBindingEvidence: { ...frame.finalBindingEvidence, binding: changedAttempt },
              },
            },
          ];
          if (replay) {
            controls.push({
              code: 'IDEMPOTENCY_CONFLICT',
              label: 'correlation',
              patch: { commitmentCorrelationId: randomUUID() },
            });
          }

          const proofs = yield* test.readProofs();
          const request = yield* test.readRequest();
          const history = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
          const entries = test.authorityEntries();
          for (const control of controls) {
            const tampered = yield* Schema.decodeUnknownEffect(
              Schema.toType(TrustedRevalidatePurchaseApprovalInputSchema),
            )({ ...frame, ...control.patch });
            const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
              yield* Effect.flip(test.directReplay(tampered, invocation)),
            );
            expect(failure.code, `${replay ? 'I1 replay' : 'new intent'}: ${control.label}`).toBe(
              replay ? 'IDEMPOTENCY_CONFLICT' : control.code,
            );
            expect(failure.retryable).toBe(false);
            expect(yield* test.readProofs()).toEqual(proofs);
            expect(yield* test.readRequest()).toEqual(request);
            expect(yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor)).toEqual(history);
            expect(test.authorityEntries()).toBe(entries);
          }
        }
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);

it.live(
  'retains native proof identity and idempotency UNIQUE guards and rolls back actual collisions',
  () =>
    Effect.scoped(
      Effect.gen(function* nativeProofUniqueness() {
        const test = yield* scenario();
        yield* test.check(randomUUID());
        const proofs = yield* test.readProofs();
        const request = yield* test.readRequest();
        const history = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        const constraints = yield* test.owner.admin.execute<{ readonly definition: string; readonly name: string }>(
          sql`
        select conname as name, pg_get_constraintdef(oid) as definition from pg_catalog.pg_constraint
        where conrelid='commerce_customer_context.approval_revalidations'::regclass
        and conname in ('ccc_approval_revalidations_resource_uk', 'ccc_approval_revalidations_idempotency_uk')
        order by conname`,
          'objects',
        );
        expect(constraints).toEqual([
          {
            definition: 'UNIQUE (tenant_id, legal_entity_id, idempotency_key)',
            name: 'ccc_approval_revalidations_idempotency_uk',
          },
          {
            definition: 'UNIQUE (tenant_id, legal_entity_id, revalidation_resource_id)',
            name: 'ccc_approval_revalidations_resource_uk',
          },
        ]);
        for (const column of ['revalidation_resource_id', 'idempotency_key'] as const) {
          const constraint =
            column === 'idempotency_key'
              ? 'ccc_approval_revalidations_idempotency_uk'
              : 'ccc_approval_revalidations_resource_uk';
          const otherColumn = column === 'idempotency_key' ? 'revalidation_resource_id' : 'idempotency_key';
          // Admin-only storage corruption control in this isolated database. The attempted copy
          // changes the primary key and the other unique value, isolating exactly one guard.
          // PostgreSQL's exception subtransaction rolls back the rejected INSERT; an absent or
          // different constraint raises and fails this test instead of silently accepting a copy.
          yield* test.owner.admin.execute(
            sql.raw(`DO $collision$
          DECLARE rejected_constraint text;
          BEGIN
            BEGIN
              INSERT INTO commerce_customer_context.approval_revalidations
              SELECT (jsonb_populate_record(null::commerce_customer_context.approval_revalidations,
                to_jsonb(proof) || jsonb_build_object('approval_revalidation_id', gen_random_uuid(),
                  '${otherColumn}', gen_random_uuid()::text))).*
              FROM commerce_customer_context.approval_revalidations proof LIMIT 1;
              RAISE EXCEPTION 'Expected native ${constraint} collision was accepted';
            EXCEPTION WHEN unique_violation THEN
              GET STACKED DIAGNOSTICS rejected_constraint = CONSTRAINT_NAME;
              IF rejected_constraint IS DISTINCT FROM '${constraint}' THEN
                RAISE EXCEPTION 'Unexpected native constraint: %', rejected_constraint;
              END IF;
            END;
          END $collision$`),
            'objects',
          );
          expect(yield* test.readProofs()).toEqual(proofs);
          expect(yield* test.readRequest()).toEqual(request);
          expect(yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor)).toEqual(history);
        }
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);

it.live(
  'keeps unavailable, changed, foreign and unresolved final bindings proof-free',
  () =>
    Effect.scoped(
      Effect.gen(function* finalAuthorityDenials() {
        const test = yield* scenario();
        const unavailable = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(test.check(randomUUID(), {}, false)),
        );
        expect(unavailable.code).toBe('CURRENT_STATE_INDETERMINATE');
        for (const finalBinding of [
          { ...test.binding, bundleHash: 'e'.repeat(64) },
          { ...test.binding, attemptRef: { ...test.binding.attemptRef, resourceId: randomUUID() } },
          { ...test.binding, attemptRef: { ...test.binding.attemptRef, tenantId: randomUUID() } },
        ]) {
          const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
            yield* Effect.flip(
              test.check(randomUUID(), {
                finalBinding: yield* Schema.decodeUnknownEffect(PurchaseApprovalFinalBindingSchema)(finalBinding),
              }),
            ),
          );
          expect(failure.code).toBe('CURRENT_STATE_INDETERMINATE');
          expect(yield* test.readProofs()).toEqual([]);
        }
        test.setEligible(false);
        const unknown = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(test.check(randomUUID())),
        );
        expect(unknown.code).toBe('CURRENT_STATE_INDETERMINATE');
        expect(yield* test.readProofs()).toEqual([]);
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);

it.live(
  'serializes distinct and same fresh intents without changing request revision or historical proof bytes',
  () =>
    Effect.scoped(
      Effect.gen(function* concurrentProofIssuance() {
        const test = yield* scenario();
        const first = yield* test.check(randomUUID());
        const original = yield* test.readProofs();
        yield* test.expire(first.revalidation.validUntil);
        const results = yield* Effect.all([test.check(randomUUID()), test.check(randomUUID())], { concurrency: 2 });
        expect(new Set(results.map((result) => result.revalidation.revalidationRef.resourceId)).size).toBe(2);
        expect(yield* test.readProofs()).toHaveLength(3);
        const intent = randomUUID();
        const replay = yield* Effect.all([test.check(intent), test.check(intent)], { concurrency: 2 });
        expect(replay[0].revalidation.revalidationRef).toEqual(replay[1].revalidation.revalidationRef);
        const records = yield* test.readProofs();
        expect(records).toHaveLength(4);
        expect(records.find((row) => row.revalidationResourceId === original[0]?.revalidationResourceId)).toEqual(
          original[0],
        );
        for (const record of records) {
          expect(record.evidence.requestRevision).toBe(test.approved.request.requestRevision);
        }
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);
