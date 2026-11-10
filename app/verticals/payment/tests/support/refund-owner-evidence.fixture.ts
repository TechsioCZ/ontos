import { Effect, Layer } from 'effect';

import type { PaymentRefundableItem } from '../../shared/domain/payment-refund-basis.ts';
import { CommitmentOutcomePort } from '../../src/ports/commitment-outcome-port.ts';
import type { PaymentCommitmentOutcome } from '../../src/ports/commitment-outcome-port.ts';
import { ownerEvidenceUnavailable } from '../../src/ports/owner-evidence-unavailable.ts';
import type { PaymentOwnerScope } from '../../src/ports/owner-evidence-unavailable.ts';
import { RefundableItemsPort } from '../../src/ports/refundable-items-port.ts';
import type { PaymentRefundableItemVerification } from '../../src/ports/refundable-items-port.ts';

/**
 * Public-contract fixtures of the downstream owners the refund lane depends on (#1150). They answer
 * exactly the foundation port contracts: the future Order/Claim/Aftercare owner's authoritative
 * refundable items and the future #331 commitment owner's terminal non-commit evidence. They never
 * stand in for Payment behavior; every Payment decision runs through the registered Action.
 */

/** The Order/Claim/Aftercare owner's authoritative refundable items of one exact purchase in one scope. */
export interface RefundableItemsContractFixture {
  readonly items: readonly PaymentRefundableItem[];
  readonly purchaseCorrelationId: string;
  readonly scope: PaymentOwnerScope;
}

const sameScope = (left: PaymentOwnerScope, right: PaymentOwnerScope) =>
  left.tenantId === right.tenantId && left.legalEntityId === right.legalEntityId;

const verdictFor = (
  fixture: RefundableItemsContractFixture,
  request: { readonly purchaseCorrelationId: string; readonly scope: PaymentOwnerScope },
  itemRef: string,
): PaymentRefundableItemVerification => {
  const item = fixture.items.find((candidate) => candidate.itemRef === itemRef);
  if (!sameScope(fixture.scope, request.scope) || fixture.purchaseCorrelationId !== request.purchaseCorrelationId) {
    return { _tag: 'NOT_REFUNDABLE', itemRef, reason: 'PURCHASE_NOT_ACCEPTED' };
  }
  return item === undefined
    ? { _tag: 'NOT_REFUNDABLE', itemRef, reason: 'ITEM_NOT_FOUND' }
    : { _tag: 'REFUNDABLE', item };
};

/** Public-contract fixture of `RefundableItemsPort`: one verdict per requested item, in request order. */
export const refundableItemsPublicContractFixture = (fixture: RefundableItemsContractFixture) =>
  Layer.succeed(RefundableItemsPort, {
    verifyRefundableItems: (request) =>
      Effect.succeed(request.itemRefs.map((itemRef) => verdictFor(fixture, request, itemRef))),
  });

export const COMMITMENT_FIXTURE_ANSWERS = [
  'NOT_COMMITTED_CLOSED',
  'OUTCOME_UNKNOWN',
  'ATTEMPT_OPEN',
  'TIMEOUT',
] as const;
export type CommitmentFixtureAnswer = (typeof COMMITMENT_FIXTURE_ANSWERS)[number];

/** The #331 commitment owner's answer for one exact Attempt of one purchase in one scope. */
export interface CommitmentOutcomeContractFixture {
  readonly answer: CommitmentFixtureAnswer;
  readonly attemptRef: string;
  readonly purchaseCorrelationId: string;
  readonly scope: PaymentOwnerScope;
  readonly terminalNonCommitEvidenceRef: string;
}

const commitmentOutcomeFor = (
  fixture: CommitmentOutcomeContractFixture,
  request: {
    readonly attemptRef: string;
    readonly purchaseCorrelationId: string;
    readonly scope: PaymentOwnerScope;
  },
): PaymentCommitmentOutcome => {
  if (
    request.attemptRef !== fixture.attemptRef ||
    request.purchaseCorrelationId !== fixture.purchaseCorrelationId ||
    !sameScope(request.scope, fixture.scope)
  ) {
    return { _tag: 'NOT_ESTABLISHED', attemptRef: request.attemptRef, reason: 'ATTEMPT_NOT_FOUND' };
  }
  if (fixture.answer === 'NOT_COMMITTED_CLOSED') {
    return {
      _tag: 'NOT_COMMITTED_CLOSED',
      attemptRef: fixture.attemptRef,
      terminalNonCommitEvidenceRef: fixture.terminalNonCommitEvidenceRef,
    };
  }
  return {
    _tag: 'NOT_ESTABLISHED',
    attemptRef: fixture.attemptRef,
    reason: fixture.answer === 'ATTEMPT_OPEN' ? 'ATTEMPT_OPEN' : 'OUTCOME_UNKNOWN',
  };
};

/**
 * Public-contract fixture of `CommitmentOutcomePort`. `TIMEOUT` models a transport-level failure
 * (lost or late response): the port fails as unavailable evidence, never as a negative fact.
 */
export const commitmentOutcomePublicContractFixture = (fixture: CommitmentOutcomeContractFixture) =>
  Layer.succeed(CommitmentOutcomePort, {
    verifyTerminalNonCommit: (request) =>
      fixture.answer === 'TIMEOUT'
        ? Effect.fail(ownerEvidenceUnavailable('COMMITMENT_OUTCOME', 'The commitment owner did not answer in time'))
        : Effect.succeed(commitmentOutcomeFor(fixture, request)),
  });
