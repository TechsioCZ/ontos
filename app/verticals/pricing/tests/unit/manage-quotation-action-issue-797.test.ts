import { ReadHandlerUnavailable } from '@app/core-runtime';
import { PRICING_CZK_PUBLICATION_PROFILE_VERSION } from '@app/pricing-contracts/domain/exact-decimal';
import {
  PricingQuotationAuthenticatedBindingSchema,
  PricingQuotationIssuanceRequestSchema,
} from '@app/pricing-contracts/domain/quotation';
import type { PricingQuotationIssued } from '@app/pricing-contracts/domain/quotation';
import { DateTime, Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ManageQuotationPayloadSchema } from '../../shared/actions/manage-quotation.ts';
import {
  ManageQuotationRejected,
  ManageQuotationUnavailable,
  applyQuotationManagement,
} from '../../src/actions/manage-quotation.action.ts';
import type { ManageQuotationActionServices } from '../../src/actions/manage-quotation.action.ts';
import { readQuotationResult } from '../../src/api/quotation-result-lookup.read.ts';
import { calculatePricingCommercialTotals } from '../../src/services/commercial-totals.service.ts';
import { publishPricingLineValues } from '../../src/services/line-value-publication.service.ts';
import { QuotationPersistenceUnavailable } from '../../src/services/quotation-persistence.service.ts';
import { makeIssue787Snapshot } from './support/issue-787-material-change.fixture.ts';
import { candidateRef, makeIssue779PreRoundScenario } from './support/issue-779-line-value.fixture.ts';
import { makeQuotationMaterialEvidence } from './support/quotation-material-evidence.fixture.ts';

const snapshot = makeIssue787Snapshot({
  attemptId: 'quotation-management-attempt',
  capturedAt: '2026-09-28T10:00:00.000Z',
  currencyCode: 'CZK',
  evaluatedAt: '2026-09-28T10:00:00.000Z',
  observedAt: '2026-09-28T10:00:00.000Z',
  requestedAt: '2026-09-28T10:00:00.000Z',
  revision: '1',
  snapshotId: 'quotation-management-snapshot',
});

const payload = Schema.decodeSync(ManageQuotationPayloadSchema)({
  candidateRef: snapshot.candidateRef,
  currentDecision: {
    decision: snapshot.decision,
    subject: snapshot.decision.purchasingContext.subject,
  },
  reason: 'Customer requested an exact pre-Tax quotation',
});

const trusted = {
  actionInvocationId: '79700000-0000-4000-8000-000000000001',
  legalEntityId: payload.currentDecision.decision.commercialScope.sellingLegalEntityId,
  principalId: '79700000-0000-4000-8000-000000000002',
  tenantId: payload.currentDecision.decision.tenantId,
  trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-09-28T10:00:00.000Z')),
};

const unavailable = new ManageQuotationUnavailable({
  code: 'manage_quotation_current_authority_unavailable',
  reason: 'Fresh Current Pricing authority is not yet available for Quotation issuance',
});

const freshIssuanceRequest = Effect.fn('test.issue797FreshQuotationIssuanceRequest')(
  function* freshQuotationIssuanceRequest() {
    const { preRound } = yield* makeIssue779PreRoundScenario({ discounts: ['0', '0', '0'], priceAmount: '900' });
    const publication = yield* publishPricingLineValues({
      candidateRef,
      decision: preRound.decision,
      preRound,
      publicationProfileVersion: PRICING_CZK_PUBLICATION_PROFILE_VERSION,
    });
    if (publication.outcome !== 'LINE_VALUES_PUBLISHED') {
      return yield* Effect.die(`Expected published quotation lines, got ${publication.failure.code}`);
    }
    const commercialTotal = yield* calculatePricingCommercialTotals({
      candidateRef,
      decision: preRound.decision,
      preRound,
      publishedLines: publication.publishedLines,
    });
    if (commercialTotal.outcome !== 'COMMERCIAL_TOTAL_READY') {
      return yield* Effect.die(`Expected a commercial total, got ${commercialTotal.failure.code}`);
    }
    const { subject } = commercialTotal.decision.purchasingContext;
    if (subject.kind !== 'PROFILE') {
      return yield* Effect.die(
        `Expected the authenticated quotation fixture to use a Profile subject, got ${subject.kind}`,
      );
    }
    return yield* Schema.decodeEffect(PricingQuotationIssuanceRequestSchema)({
      binding: {
        candidateRef,
        commercialScope: commercialTotal.decision.commercialScope,
        currencyCode: commercialTotal.decision.currencyCode,
        lines: commercialTotal.decision.lines.map(({ catalog, occurrenceId }) => ({
          occurrenceId,
          quantity: { amount: catalog.quantity.resulting, unitRef: catalog.unitRef },
          selection: catalog.selection,
        })),
        monetaryBoundary: commercialTotal.decision.monetaryBoundary,
        subject: {
          kind: 'AUTHENTICATED',
          purchaseContext: {
            contextRef: commercialTotal.decision.purchasingContext.contextRef,
            contextRevision: commercialTotal.decision.purchasingContext.contextRevision,
          },
          subjectEvidenceRef: 'subject-evidence:quotation-management:current',
          subjectRef: subject.profileRef,
        },
        tenantId: commercialTotal.decision.tenantId,
      },
      currentResult: { commercialTotal, kind: 'CURRENT_PRICING_RESULT' },
      kind: 'ISSUE_PRICING_QUOTATION',
      materialEvidence: makeQuotationMaterialEvidence(commercialTotal),
    });
  },
);

describe('Quotation management Action', () => {
  it.effect('does not accept client-provided quoted money, expiry, or a quotation reference', () =>
    Effect.gen(function* ignoresUntrustedExcessFields() {
      const untrustedInput = {
        ...payload,
        quotationRef: 'caller-forged-quote',
        quotedResult: { amount: '1' },
        validUntil: '2099-01-01T00:00:00.000Z',
      };
      const decoded = yield* Schema.decodeEffect(ManageQuotationPayloadSchema)(untrustedInput);
      expect(Object.keys(decoded).toSorted()).toEqual(['candidateRef', 'currentDecision', 'reason']);
    }),
  );

  it.effect('reports owner-scoped absence without inventing a quotation result', () =>
    Effect.gen(function* reportsOwnerScopedAbsence() {
      const result = yield* readQuotationResult(
        { actionInvocationId: trusted.actionInvocationId },
        { legalEntityId: trusted.legalEntityId },
        { lookupInvocation: () => Effect.succeedNone },
      );

      expect(result).toEqual({
        actionInvocationId: trusted.actionInvocationId,
        outcome: 'QUOTATION_RESULT_ABSENT',
      });
    }),
  );

  it.effect('keeps missing scope and owner lookup failure distinct from proven absence', () =>
    Effect.gen(function* keepsUnavailableDistinctFromAbsence() {
      let lookedUp = false;
      const withoutScope = yield* readQuotationResult(
        { actionInvocationId: trusted.actionInvocationId },
        { legalEntityId: null },
        {
          lookupInvocation: () => {
            lookedUp = true;
            return Effect.succeedNone;
          },
        },
      );
      expect(withoutScope).toEqual({
        actionInvocationId: trusted.actionInvocationId,
        outcome: 'QUOTATION_RESULT_UNAVAILABLE',
        retryable: true,
      });
      expect(lookedUp).toBe(false);

      const ownerFailure = yield* readQuotationResult(
        { actionInvocationId: trusted.actionInvocationId },
        { legalEntityId: trusted.legalEntityId },
        {
          lookupInvocation: () =>
            Effect.fail(new QuotationPersistenceUnavailable({ reason: 'Owner result store unavailable' })),
        },
      ).pipe(Effect.flip);
      expect(ownerFailure).toBeInstanceOf(ReadHandlerUnavailable);
      expect(ownerFailure.cause).toBeInstanceOf(QuotationPersistenceUnavailable);
    }),
  );

  it.effect('rejects Tenant or Selling Legal Entity mismatch before owner lookup or issuance', () =>
    Effect.gen(function* rejectsUntrustedScope() {
      let called = false;
      const services: ManageQuotationActionServices = {
        lookupInvocation: () => {
          called = true;
          return Effect.succeedNone;
        },
        resolveFresh: () => {
          called = true;
          return Effect.fail(unavailable);
        },
        store: () => {
          called = true;
          return Effect.die(new Error('Unexpected Quotation write'));
        },
      };
      const failure = yield* applyQuotationManagement(
        payload,
        { ...trusted, legalEntityId: '79700000-0000-4000-8000-000000000099' },
        services,
      ).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(ManageQuotationRejected);
      expect(called).toBe(false);
    }),
  );

  it.effect('fails closed when fresh Current authority is absent and performs no write', () =>
    Effect.gen(function* requiresFreshOwnerAuthority() {
      let stored = false;
      const services: ManageQuotationActionServices = {
        lookupInvocation: () => Effect.succeedNone,
        resolveFresh: () => Effect.fail(unavailable),
        store: () => {
          stored = true;
          return Effect.die(new Error('Unexpected Quotation write'));
        },
      };
      const failure = yield* applyQuotationManagement(payload, trusted, services).pipe(Effect.flip);
      expect(failure).toEqual(unavailable);
      expect(stored).toBe(false);
    }),
  );

  it.effect('issues from one canonical fresh Pricing result and replays the immutable result after expiry', () =>
    Effect.gen(function* issuesAndReplaysCanonicalResult() {
      const issuanceRequest = yield* freshIssuanceRequest();
      const { operationTime } = issuanceRequest.currentResult.commercialTotal.decision;
      const actionPayload = yield* Schema.decodeEffect(ManageQuotationPayloadSchema)({
        candidateRef: issuanceRequest.binding.candidateRef,
        currentDecision: {
          decision: issuanceRequest.currentResult.commercialTotal.decision,
          subject: issuanceRequest.currentResult.commercialTotal.decision.purchasingContext.subject,
        },
        reason: 'Issue the exact current pre-Tax guarantee',
      });
      const actionTrusted = {
        actionInvocationId: '79700000-0000-4000-8000-000000000010',
        legalEntityId: actionPayload.currentDecision.decision.commercialScope.sellingLegalEntityId,
        principalId: '79700000-0000-4000-8000-000000000011',
        tenantId: actionPayload.currentDecision.decision.tenantId,
        trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(operationTime)),
      };
      let stored:
        | {
            readonly commandFingerprint: string;
            readonly quotation: PricingQuotationIssued;
          }
        | undefined;
      let freshCalls = 0;
      const services: ManageQuotationActionServices = {
        lookupInvocation: () => Effect.succeed(Option.fromNullishOr(stored)),
        resolveFresh: ({ candidateRef: requestedCandidate, currentDecision, trusted: receivedTrusted }) => {
          freshCalls += 1;
          expect(requestedCandidate).toBe(actionPayload.candidateRef);
          expect(currentDecision.decision.operationTime).toBe(operationTime);
          expect(receivedTrusted.principalId).toBe(actionTrusted.principalId);
          return Effect.succeed(issuanceRequest);
        },
        store: (command) => {
          stored = { commandFingerprint: command.commandFingerprint, quotation: command.quotation };
          return Effect.succeed(command.quotation);
        },
      };

      const first = yield* applyQuotationManagement(actionPayload, actionTrusted, services);
      expect(first.quotation).toMatchObject({
        issuedAt: operationTime,
        quotedResult: { pricingNetCommercialTotal: { amount: '900', currencyCode: 'CZK' } },
        validity: { validFrom: operationTime, validUntil: '2026-09-28T12:15:00.000Z' },
      });

      const replay = yield* applyQuotationManagement(
        actionPayload,
        { ...actionTrusted, trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-01T00:00:00.000Z')) },
        services,
      );
      expect(replay).toEqual(first);
      expect(freshCalls).toBe(1);
    }),
  );

  it.effect(
    'rejects a fresh authority response bound to another authenticated subject before issuance or storage',
    () =>
      Effect.gen(function* rejectsAuthenticatedSubstitution() {
        const issuanceRequest = yield* freshIssuanceRequest();
        const authenticatedSubject = yield* Schema.decodeUnknownEffect(PricingQuotationAuthenticatedBindingSchema)(
          issuanceRequest.binding.subject,
        );
        const substitutedIssuanceRequest = {
          ...issuanceRequest,
          binding: {
            ...issuanceRequest.binding,
            subject: {
              ...authenticatedSubject,
              subjectRef: {
                ...authenticatedSubject.subjectRef,
                resourceId: '79700000-0000-4000-8000-000000000099',
              },
            },
          },
        } satisfies typeof issuanceRequest;
        let stored = false;
        const services: ManageQuotationActionServices = {
          lookupInvocation: () => Effect.succeedNone,
          resolveFresh: () => Effect.succeed(substitutedIssuanceRequest),
          store: () => {
            stored = true;
            return Effect.die(new Error('Unexpected Quotation write'));
          },
        };
        const current = issuanceRequest.currentResult.commercialTotal.decision;
        const requestPayload = yield* Schema.decodeEffect(ManageQuotationPayloadSchema)({
          candidateRef: issuanceRequest.binding.candidateRef,
          currentDecision: {
            decision: current,
            subject: current.purchasingContext.subject,
          },
          reason: 'Reject substituted authenticated authority',
        });
        const failure = yield* applyQuotationManagement(
          requestPayload,
          {
            actionInvocationId: '79700000-0000-4000-8000-000000000020',
            legalEntityId: current.commercialScope.sellingLegalEntityId,
            principalId: '79700000-0000-4000-8000-000000000021',
            tenantId: current.tenantId,
            trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(current.operationTime)),
          },
          services,
        ).pipe(Effect.flip);

        expect(failure).toMatchObject({ code: 'manage_quotation_issuer_mismatch' });
        expect(stored).toBe(false);
      }),
  );
});
