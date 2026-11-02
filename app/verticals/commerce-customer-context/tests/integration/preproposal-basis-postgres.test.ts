import { NodeServices } from '@effect/platform-node';
import { Config, DateTime, Effect, Layer, Redacted, Schema } from 'effect';
import { executeReviseCartDraftWithAuthorization } from '@app/commerce-cart/api/client';
import { executePurchaseProposalBasisWithAuthorization } from '../../src/api/purchase-proposal-basis-client.ts';
import { PurchaseProposalBasisUnavailableProblemSchema } from '../../shared/apis/purchase-proposal-basis.ts';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

// Merely collecting the integration project must not create a database or owner runtime.
// The controller selects this file AND explicitly enables the bounded native lane.
it.live(
  'produces an exact preproposal basis through registered owners and retains its original Pricing issuance',
  (test) =>
    Effect.scoped(
      Effect.gen(function* genuinePreproposalNativeProof() {
        const enabled = yield* Config.Boolean('ONTOS_PREPROPOSAL_NATIVE').pipe(Config.withDefault(false));
        if (!enabled) {
          test.skip();
        }
        if (yield* Config.Boolean('ONTOS_PREPROPOSAL_STANDALONE').pipe(Config.withDefault(false))) {
          const { runStandalonePreproposalNativeTest } = yield* Effect.promise(
            async () => await import('../support/preproposal-native-bootstrap.ts'),
          );
          yield* runStandalonePreproposalNativeTest(false);
          return;
        }
        const { makeRegisteredPreproposalNativeFixture, runRegisteredPreproposalBasisChain } = yield* Effect.promise(
          async () => await import('../support/preproposal-basis-native.ts'),
        );
        const fixture = yield* makeRegisteredPreproposalNativeFixture();
        const before = yield* fixture.transport.core.evidence();
        const proof = yield* runRegisteredPreproposalBasisChain(fixture);
        expect(proof.prepared.status).toBe('PREPARED');
        expect(proof.ready.status).toBe('READY');
        expect(proof.current.basis.status).toBe('READY');
        expect(proof.created.outcome).toBe('CREATED');
        expect(proof.wrongIssuanceRejected).toBe(true);
        expect(proof.wrongIssuanceRejection.code).toBe('IDEMPOTENCY_CONFLICT');
        expect(proof.wrongIssuanceRejection.principalId).toBe(fixture.transport.cccReaderPrincipalId);
        expect(proof.current.facts).not.toBeNull();
        expect(proof.ready.pricingIssuanceInvocationId).toBe(proof.invocation.actionInvocationId);
        expect(proof.ready.pricingIssuerPrincipalId).toBe(fixture.transport.pricingIssuerPrincipalId);
        expect(proof.invocation.principalId).not.toBe(fixture.transport.buyerPrincipalId);
        expect(proof.issued.quotation.binding.candidateRef).toBe(proof.pricingInput.pricingCandidateRef);
        expect(proof.current.basis.preparationInvocationId).toBe(proof.prepared.preparationInvocationId);
        // Two distinct Catalog selections: CCC prepares each Cart entry through Catalog, in Cart order.
        const cartEntries = fixture.cart.observed.cart.entries;
        expect(cartEntries).toHaveLength(2);
        expect(cartEntries.map((entry) => entry.selection)).toEqual(fixture.catalogSelections);
        expect(new Set(cartEntries.map((entry) => entry.selection.variantRef.resourceId)).size).toBe(2);
        const cartLines = cartEntries.map((entry) => ({ occurrenceId: entry.selectionId, selection: entry.selection }));
        for (const { decision } of [proof.pricingInput.pricingInput, proof.current.basis.pricingInput]) {
          expect(
            decision.lines.map((line) => ({ occurrenceId: line.occurrenceId, selection: line.catalog.selection })),
          ).toEqual(cartLines);
        }
        // The retained input is the frozen request; Pricing quotes at its own trusted instant, which must cover
        // every Catalog assessment (each Cart entry is assessed by its own Catalog request).
        const quotedAt = DateTime.toEpochMillis(
          DateTime.makeUnsafe(proof.issued.quotation.quotedResult.decision.operationTime),
        );
        for (const line of proof.pricingInput.pricingInput.decision.lines) {
          expect(quotedAt).toBeGreaterThanOrEqual(
            DateTime.toEpochMillis(DateTime.makeUnsafe(line.catalog.evidence.assessedAt)),
          );
        }
        expect(proof.current.basis.proposal.lines.map((line) => line.lineId)).toEqual(
          cartEntries.map((entry) => entry.selectionId),
        );
        // Both operator Prices (100 + 250 CZK) reach the retained purchase value.
        expect(proof.ready.proposal.purchaseValue.monetaryAmount).toEqual({ amount: '350', currency: 'CZK' });
        const after = yield* fixture.transport.core.evidence();
        // Setup history is immutable; the producer adds new original invocations.
        for (const row of before.invocations) {
          expect(
            after.invocations.find((candidate) => candidate.actionInvocationId === row.actionInvocationId),
          ).toEqual(row);
        }
        expect(
          after.invocations.filter((row) => row.actionInvocationId === proof.invocation.actionInvocationId),
        ).toHaveLength(1);
        const stored = yield* fixture.verifyStoredProposal(proof);
        expect(stored.buyerPrincipalId).toBe(fixture.transport.buyerPrincipalId);
        expect(stored.canonicalHash).toBe(proof.created.proposal.canonicalHash);
        yield* fixture.recordProof(proof);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
  { timeout: 600_000 },
);

// This prerequisite deliberately stops before Order preparation: it supplies no Tax
// eligibility claims and never substitutes a fixed final Bundle/Attempt authority.
it.live(
  'submits and approves the genuine retained preproposal through registered owner operations',
  (test) =>
    Effect.scoped(
      Effect.gen(function* genuinePreproposalApproval() {
        const enabled = yield* Config.Boolean('ONTOS_APPROVAL_NATIVE').pipe(Config.withDefault(false));
        if (!enabled) {
          test.skip();
        }
        if (yield* Config.Boolean('ONTOS_PREPROPOSAL_STANDALONE').pipe(Config.withDefault(false))) {
          const { runStandalonePreproposalNativeTest } = yield* Effect.promise(
            async () => await import('../support/preproposal-native-bootstrap.ts'),
          );
          yield* runStandalonePreproposalNativeTest(true);
          return;
        }
        const { makeRegisteredPreproposalNativeFixture, runRegisteredPreproposalBasisChain } = yield* Effect.promise(
          async () => await import('../support/preproposal-basis-native.ts'),
        );
        const fixture = yield* makeRegisteredPreproposalNativeFixture();
        const proof = yield* runRegisteredPreproposalBasisChain(fixture);
        const stored = yield* fixture.verifyStoredProposal(proof);
        const approval = yield* fixture.approveProposal(proof);
        expect(approval.submitted.outcome).toBe('SUBMITTED');
        expect(approval.submitted.request.status).toBe('PENDING');
        expect(approval.approved.outcome).toBe('DECISION_RECORDED');
        expect(approval.approved.request.status).toBe('APPROVED');
        expect(approval.approved.request.proposal).toEqual(proof.created.proposal);
        expect(approval.approved.request.proposal.canonicalHash).toBe(stored.canonicalHash);
        expect(approval.approved.request.requestRef).toEqual(approval.submitted.request.requestRef);
        expect(approval.approved.request.route.hierarchyRef).toEqual(approval.hierarchy.hierarchy.hierarchyRef);
        expect(approval.approved.request.committedOrderRef).toBeNull();
        expect(approval.approved.request.consumedAt).toBeNull();
        const evidence = yield* fixture.transport.core.evidence();
        for (const [actionKey, suffix] of [
          ['commerce.customer-context.create-approval-hierarchy', 'hierarchy'],
          ['commerce.customer-context.submit-purchase-approval-request', 'submit'],
          ['commerce.customer-context.decide-purchase-approval-request', 'approve'],
        ] as const) {
          const original = evidence.invocations.filter(
            (row) => row.actionKey === actionKey && row.idempotencyKey === `${fixture.intent}:${suffix}`,
          );
          expect(original).toHaveLength(1);
          expect(original[0]?.status).toBe('succeeded');
          expect(original[0]?.principalId).toBe(fixture.transport.buyerPrincipalId);
        }
        const currentCredential = yield* fixture.transport.authorize('ccc-service', 'commerce-customer-context');
        const selector = {
          operation: 'CURRENT' as const,
          sourceRef: proof.prepared.proposal.proposalRevisionRef.resourceId,
          sourceRevision: '1',
        };
        const current = yield* executePurchaseProposalBasisWithAuthorization(
          selector,
          Redacted.value(currentCredential.authorization),
          `${fixture.intent}:current-before-material-change`,
          currentCredential.options,
        );
        expect(current.facts).not.toBeNull();
        expect(current.basis).toEqual(proof.current.basis);
        const cartCredential = yield* fixture.transport.authorize('buyer', 'commerce-cart');
        const mutationKey = `${fixture.intent}:change-cart-material`;
        const changedCart = yield* executeReviseCartDraftWithAuthorization(
          {
            cartRef: fixture.cart.revised.cart.cartRef,
            entries: [],
            expectedRevision: fixture.cart.revised.cart.revisionRef.revision,
          },
          Redacted.value(cartCredential.authorization),
          mutationKey,
          { ...cartCredential.options, idempotencyKey: mutationKey },
        );
        expect(changedCart.cart.entries).toEqual([]);
        expect(changedCart.cart.revisionRef.revision).toBe(fixture.cart.revised.cart.revisionRef.revision + 1);
        const reader = yield* fixture.transport.authorize('ccc-service', 'commerce-customer-context');
        const refused = yield* Schema.decodeUnknownEffect(PurchaseProposalBasisUnavailableProblemSchema)(
          yield* Effect.flip(
            executePurchaseProposalBasisWithAuthorization(
              selector,
              Redacted.value(reader.authorization),
              `${fixture.intent}:current-after-material-change`,
              reader.options,
            ),
          ),
        );
        expect(refused.status).toBe(503);
        expect(yield* fixture.verifyStoredProposal(proof)).toEqual(stored);
        const afterMaterialChange = yield* fixture.transport.core.evidence();
        for (const invocation of evidence.invocations) {
          expect(
            afterMaterialChange.invocations.find((row) => row.actionInvocationId === invocation.actionInvocationId),
          ).toEqual(invocation);
        }
        const priorEvents = evidence.events.filter((event) => event.producerModuleKey === 'commerce.customer-context');
        const retainedEvents = afterMaterialChange.events.filter(
          (event) => event.producerModuleKey === 'commerce.customer-context',
        );
        expect(retainedEvents).toHaveLength(priorEvents.length);
        for (const event of priorEvents) {
          expect(retainedEvents.find((row) => row.domainEventId === event.domainEventId)).toEqual(event);
        }
        const priorMessages = evidence.outbox.filter(
          (message) => message.producerModuleKey === 'commerce.customer-context',
        );
        const retainedMessages = afterMaterialChange.outbox.filter(
          (message) => message.producerModuleKey === 'commerce.customer-context',
        );
        expect(retainedMessages).toHaveLength(priorMessages.length);
        for (const message of priorMessages) {
          const retained = retainedMessages.find((row) => row.outboxMessageId === message.outboxMessageId);
          expect(retained).toBeDefined();
          if (retained !== undefined) {
            // Dispatch may advance concurrently; every immutable message field must remain exact.
            expect({ ...retained, matchedAt: message.matchedAt }).toEqual(message);
            if (message.matchedAt !== null) {
              expect(retained.matchedAt).toEqual(message.matchedAt);
            }
          }
        }
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
  { timeout: 600_000 },
);
