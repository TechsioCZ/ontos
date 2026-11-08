import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  RevalidateOrderPurchaseApprovalActionConflictProblemSchema,
  RevalidateOrderPurchaseApprovalActionUnavailableProblemSchema,
} from '@app/commerce-customer-context/api/revalidate-order-purchase-approval-action';
import { canonicalizeApplicationComposition } from '@app/core-runtime';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import {
  ActiveApplicationCompositionService,
  ActiveApplicationCompositionSnapshotSchema,
} from '@app/core-runtime/modules/active-application-composition';
import { NodeCrypto } from '@effect/platform-node';
import { ConfigProvider, Effect, Layer, Schema } from 'effect';
import { Hex } from 'effect/encoding';
import { TestClock } from 'effect/testing';
import { describe, expect, it, rs } from 'effect-rstest';

import {
  makeIssue788CommercialTotal,
  makeIssue788IssuedConfirmation,
  makeIssue788Quotation,
} from '../../../pricing/tests/unit/support/issue-788-confirmation.fixture.ts';
import { OrderCommitmentRejected } from '../../shared/domain/order-commitment.ts';
import { ApprovalOwnerGateway, ApprovalOwnerGatewayLive } from '../../src/services/approval-owner-gateway.ts';
import {
  approvedProposalEvidence,
  genuineConsumptionResult,
  gatewayScope,
  makeGatewayConsumptionState,
  makeGatewayRevalidationState,
  notFoundRevalidationEvidence,
  recoveredRevalidationEvidence,
  retainedConsumptionProposal,
} from '../support/order-approval-gateway-state.ts';

const dependencies = rs.hoisted(() => ({
  consume: rs.fn<() => Effect.Effect<unknown, unknown>>(),
  evidence: rs.fn<() => Effect.Effect<unknown, unknown>>(),
  issueGateway: rs.fn<() => Effect.Effect<unknown, unknown>>(),
  revalidate: rs.fn<() => Effect.Effect<unknown, unknown>>(),
}));

// Only the owner transport, the Shell assertion issuer and the approval owner's two Action clients are
// replaced. The gateway's own binding, decode, recovery and conflict mapping run as shipped.
rs.mock('@app/shared-contracts/gateway-context-server', () => ({
  acquireDelegatedGatewayContext: dependencies.issueGateway,
}));
rs.mock('@app/commerce-customer-context/api/order-service-approval-evidence/client', () => ({
  executeOrderServiceApprovalEvidenceWithAuthorization: dependencies.evidence,
}));
rs.mock('@app/commerce-customer-context/api/revalidate-order-purchase-approval-action/client', () => ({
  executeRevalidateOrderPurchaseApprovalWithAuthorization: dependencies.revalidate,
}));
rs.mock('@app/commerce-customer-context/api/consume-order-purchase-approval-action/client', () => ({
  executeConsumeOrderPurchaseApprovalWithAuthorization: dependencies.consume,
}));

const operationTime = '2026-10-24T12:00:00.000Z';
const validUntil = '2026-10-24T13:00:00.000Z';
const idempotencyKey = 'revalidate:unit';
const parkedProposal = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
  _tag: 'ActionProposalAccepted',
  expiresAt: validUntil,
  proposalId: '99999999-9999-4999-8999-999999999999',
});
const revalidationConflict = Schema.decodeUnknownSync(RevalidateOrderPurchaseApprovalActionConflictProblemSchema)({
  _tag: 'RevalidateOrderPurchaseApprovalActionConflictProblem',
  code: 'STALE_PROPOSAL_REVISION',
  detail: 'The proposal revision moved',
  status: 409,
  title: 'Conflict',
  type: 'about:blank',
});
const revalidationUnavailable = Schema.decodeUnknownSync(RevalidateOrderPurchaseApprovalActionUnavailableProblemSchema)(
  {
    _tag: 'RevalidateOrderPurchaseApprovalActionUnavailableProblem',
    code: 'DEPENDENCY_UNAVAILABLE',
    detail: 'The owner was momentarily unreachable',
    retryable: true,
    status: 503,
    title: 'Unavailable',
    type: 'about:blank',
  },
);

const unrevisedComposition = {
  modules: [],
  revision: '0'.repeat(64),
  schemaVersion: '2',
  shell: {
    contributionAbi: { id: 'ontos.shell-contributions', version: '1' },
    coreCapabilities: [],
    deployment: { appId: 'shell-super-app', buildMarker: 'shell-unit' },
    federationManifest: { sha256: 'a'.repeat(64), url: 'https://shell.unit.invalid/mf-manifest.json' },
    runtimeContract: { sha256: 'b'.repeat(64), url: 'https://shell.unit.invalid/ontos-shell-runtime.json' },
    sharedSingletons: [],
  },
} as const;
const composition = {
  ...unrevisedComposition,
  revision: Hex.encode(sha256(utf8ToBytes(canonicalizeApplicationComposition(unrevisedComposition)))),
};
const testLayer = ApprovalOwnerGatewayLive.pipe(
  Layer.provide(
    Layer.succeed(ActiveApplicationCompositionService, {
      load: Schema.decodeUnknownEffect(ActiveApplicationCompositionSnapshotSchema)({
        composition,
        observedAt: operationTime,
        validUntil,
      }).pipe(Effect.orDie),
    }),
  ),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ONTOS_COMMERCE_CUSTOMER_CONTEXT_API_BASE_URL: 'https://ccc.unit.invalid',
      }),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

/** A live gateway assertion that is exactly bound to the active composition and still unexpired. */
const issueGatewayAssertion = Effect.gen(function* issueGatewayAssertion() {
  yield* TestClock.setTime(Date.parse(operationTime));
  dependencies.issueGateway.mockReset();
  dependencies.issueGateway.mockReturnValue(
    Effect.succeed({
      apiBaseUrl: '/ccc-api',
      authorization: 'Bearer unit-assertion',
      compositionRevision: composition.revision,
      expiresAt: Date.parse(validUntil) / 1000,
    }),
  );
  dependencies.evidence.mockReset();
  dependencies.revalidate.mockReset();
  dependencies.consume.mockReset();
});

/** The admissibility state built over a genuine owner-issued Pricing quotation. */
const buildRevalidationState = Effect.fn('test.revalidationState')(function* buildRevalidationState() {
  const commercialTotal = yield* makeIssue788CommercialTotal('900');
  return makeGatewayRevalidationState(makeIssue788Quotation(commercialTotal));
});

/** The committed state built over a genuine owner-issued quotation and commitment confirmation. */
const buildConsumptionState = Effect.fn('test.consumptionState')(function* buildConsumptionState() {
  const commercialTotal = yield* makeIssue788CommercialTotal('900');
  return makeGatewayConsumptionState(
    makeIssue788Quotation(commercialTotal),
    makeIssue788IssuedConfirmation(commercialTotal),
  );
});

describe('Order approval owner gateway parked proposals', () => {
  it.effect('refuses a parked revalidation proposal that retained no genuine receipt', () =>
    Effect.gen(function* refuseParkedRevalidation() {
      const state = yield* buildRevalidationState();
      yield* issueGatewayAssertion;
      dependencies.evidence.mockReturnValue(Effect.succeed(notFoundRevalidationEvidence(state)));
      dependencies.revalidate.mockReturnValue(Effect.succeed(parkedProposal));
      const gateway = yield* ApprovalOwnerGateway;
      const failure = yield* gateway.revalidateOutcome(state, { idempotencyKey }, gatewayScope).pipe(Effect.flip);
      expect(Schema.is(OrderCommitmentRejected)(failure)).toBe(true);
      expect(failure.code).toBe('order_commitment_unavailable');
      expect(dependencies.revalidate).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('settles a parked revalidation only when an exact durable receipt subsequently appears', () =>
    Effect.gen(function* recoverAfterParkedRevalidation() {
      const state = yield* buildRevalidationState();
      yield* issueGatewayAssertion;
      dependencies.evidence
        .mockReturnValueOnce(Effect.succeed(notFoundRevalidationEvidence(state)))
        .mockReturnValueOnce(Effect.succeed(notFoundRevalidationEvidence(state)))
        .mockReturnValue(Effect.succeed(recoveredRevalidationEvidence(state)));
      dependencies.revalidate.mockReturnValue(Effect.succeed(parkedProposal));
      const gateway = yield* ApprovalOwnerGateway;
      const outcome = yield* gateway.revalidateOutcome(state, { idempotencyKey }, gatewayScope);
      expect(outcome).toMatchObject({ kind: 'VALID', result: { outcome: 'APPROVAL_VALID' } });
      expect(dependencies.revalidate).toHaveBeenCalledTimes(1);
      expect(dependencies.evidence).toHaveBeenCalledTimes(3);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('accepts only a genuinely retained, exactly bound revalidation', () =>
    Effect.gen(function* acceptRetainedRevalidation() {
      const state = yield* buildRevalidationState();
      yield* issueGatewayAssertion;
      dependencies.evidence.mockReturnValue(Effect.succeed(recoveredRevalidationEvidence(state)));
      const gateway = yield* ApprovalOwnerGateway;
      const outcome = yield* gateway.revalidateOutcome(state, { idempotencyKey }, gatewayScope);
      expect(outcome).toMatchObject({ kind: 'VALID', result: { outcome: 'APPROVAL_VALID' } });
      expect(dependencies.revalidate).not.toHaveBeenCalled();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('lets an exact retained revalidation settle an indeterminate Action failure', () =>
    Effect.gen(function* settleIndeterminateFailure() {
      const state = yield* buildRevalidationState();
      yield* issueGatewayAssertion;
      dependencies.evidence
        .mockReturnValueOnce(Effect.succeed(notFoundRevalidationEvidence(state)))
        .mockReturnValueOnce(Effect.succeed(notFoundRevalidationEvidence(state)))
        .mockReturnValue(Effect.succeed(recoveredRevalidationEvidence(state)));
      dependencies.revalidate.mockReturnValue(Effect.fail(revalidationUnavailable));
      const gateway = yield* ApprovalOwnerGateway;
      const outcome = yield* gateway.revalidateOutcome(state, { idempotencyKey }, gatewayScope);
      expect(outcome).toMatchObject({ kind: 'VALID', result: { outcome: 'APPROVAL_VALID' } });
      expect(dependencies.revalidate).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('keeps a published revalidation conflict a conflict and never settles it by recovery', () =>
    Effect.gen(function* keepPublishedConflict() {
      const state = yield* buildRevalidationState();
      yield* issueGatewayAssertion;
      dependencies.evidence
        .mockReturnValueOnce(Effect.succeed(notFoundRevalidationEvidence(state)))
        .mockReturnValueOnce(Effect.succeed(notFoundRevalidationEvidence(state)))
        .mockReturnValue(Effect.succeed(recoveredRevalidationEvidence(state)));
      dependencies.revalidate.mockReturnValue(Effect.fail(revalidationConflict));
      const gateway = yield* ApprovalOwnerGateway;
      const failure = yield* gateway.revalidateOutcome(state, { idempotencyKey }, gatewayScope).pipe(Effect.flip);
      expect(Schema.is(OrderCommitmentRejected)(failure)).toBe(true);
      expect(failure.code).toBe('order_commitment_conflict');
      expect(dependencies.revalidate).toHaveBeenCalledTimes(1);
      expect(dependencies.evidence).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(testLayer)),
  );
});

describe('Order approval owner gateway parked consumption proposals', () => {
  it.effect('refuses a parked consumption proposal for an approval that is not genuinely consumed', () =>
    Effect.gen(function* refuseParkedConsumption() {
      const state = yield* buildConsumptionState();
      yield* issueGatewayAssertion;
      dependencies.evidence.mockReturnValue(Effect.succeed(approvedProposalEvidence));
      dependencies.consume.mockReturnValue(Effect.succeed(parkedProposal));
      const gateway = yield* ApprovalOwnerGateway;
      const failure = yield* gateway.consume(state, gatewayScope).pipe(Effect.flip);
      expect(Schema.is(OrderCommitmentRejected)(failure)).toBe(true);
      expect(failure.code).toBe('order_commitment_unavailable');
      expect(dependencies.consume).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('settles a parked consumption only from the subsequently retained exact receipt', () =>
    Effect.gen(function* recoverAfterParkedConsumption() {
      const state = yield* buildConsumptionState();
      yield* issueGatewayAssertion;
      dependencies.evidence
        .mockReturnValueOnce(Effect.succeed(approvedProposalEvidence))
        .mockReturnValue(Effect.succeed(retainedConsumptionProposal(state)));
      dependencies.consume.mockReturnValue(Effect.succeed(parkedProposal));
      const gateway = yield* ApprovalOwnerGateway;
      const result = yield* gateway.consume(state, gatewayScope);
      expect(result.outcome).toBe('ALREADY_CONSUMED');
      expect(dependencies.consume).toHaveBeenCalledTimes(1);
      expect(dependencies.evidence).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('resolves durable consumption debt from the exact retained receipt without another write', () =>
    Effect.gen(function* resolveRetainedConsumption() {
      const state = yield* buildConsumptionState();
      yield* issueGatewayAssertion;
      dependencies.evidence.mockReturnValue(Effect.succeed(retainedConsumptionProposal(state)));
      const gateway = yield* ApprovalOwnerGateway;
      const result = yield* gateway.consume(state, gatewayScope);
      expect(result.outcome).toBe('ALREADY_CONSUMED');
      expect(dependencies.consume).not.toHaveBeenCalled();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect('accepts a genuine consumption result the owner Action answers', () =>
    Effect.gen(function* acceptGenuineConsumption() {
      const state = yield* buildConsumptionState();
      yield* issueGatewayAssertion;
      dependencies.evidence.mockReturnValue(Effect.succeed(approvedProposalEvidence));
      dependencies.consume.mockReturnValue(Effect.succeed(genuineConsumptionResult(state)));
      const gateway = yield* ApprovalOwnerGateway;
      const result = yield* gateway.consume(state, gatewayScope);
      expect(result.outcome).toBe('CONSUMED');
      expect(dependencies.consume).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(testLayer)),
  );
});
