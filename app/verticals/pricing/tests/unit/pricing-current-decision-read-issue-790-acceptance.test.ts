import {
  CurrentPricingDecisionRequestSchema,
  CurrentPricingDecisionResponseSchema,
  CurrentSupportedCurrenciesRequestSchema,
} from '@app/pricing-contracts';
import { ReadHandlerUnavailable, ReadPermissionDenied, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { PricingPurchaseContextVerificationEvidenceSchema } from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import { PricingEvaluationAttemptSchema } from '@app/pricing-contracts/domain/material-change';
import { PricingDecisionOutcomeSchema } from '@app/pricing-contracts/pricing-decision';
import type { PricingDecisionOutcome } from '@app/pricing-contracts/pricing-decision';
import { Effect, Exit, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  currentPricingDecisionRead,
  resolveCurrentPricingDecision,
} from '../../src/api/current-pricing-decision.read.ts';
import type {
  CurrentPricingDecisionWholeAttempt,
  CurrentPricingDecisionWholeEvaluationPort,
} from '../../src/services/current-pricing-decision-evaluation.service.ts';
import { makeCurrentPricingDecisionEvaluationService } from '../../src/services/current-pricing-decision-evaluation.service.ts';
import { CurrentPricingDecisionSubjectAuthorityRejected } from '../../src/services/current-pricing-decision-subject-authority.service.ts';
import type {
  CurrentPricingDecisionSubjectAuthorityEvidence,
  CurrentPricingDecisionSubjectAuthorityService,
} from '../../src/services/current-pricing-decision-subject-authority.service.ts';
import { calculatePricingUnitPrice } from '../../src/services/unit-price-calculation.service.ts';
import { makeIssue779Scenario } from './support/issue-779-line-value.fixture.ts';
import { makeIssue787Snapshot } from './support/issue-787-material-change.fixture.ts';
import { unitPriceCalculationAttempt } from './support/unit-price-calculation.fixture.ts';

const decodeDecisionRequest = Schema.decodeUnknownSync(CurrentPricingDecisionRequestSchema, {
  onExcessProperty: 'error',
});
const decodeInternalOutcome = Schema.decodeUnknownSync(PricingDecisionOutcomeSchema, {
  onExcessProperty: 'error',
});
const decodeSupportRequest = Schema.decodeUnknownSync(CurrentSupportedCurrenciesRequestSchema, {
  onExcessProperty: 'error',
});
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const guestSubject = {
  guestEvidenceRef: 'guest-evidence:issue-790',
  guestSessionRef: 'guest-session:issue-790',
  kind: 'GUEST' as const,
};

const decisionForGuest = <Decision extends { readonly purchasingContext: object }>(decision: Decision) => ({
  ...decision,
  purchasingContext: {
    ...decision.purchasingContext,
    actor: {
      guestEvidenceRef: guestSubject.guestEvidenceRef,
      guestSessionRef: guestSubject.guestSessionRef,
      kind: 'GUEST' as const,
    },
    subject: guestSubject,
  },
});

const trustedPrincipalId = '79000000-0000-4000-8000-000000000020';

const trustedPrincipal = (tenantId: string) =>
  Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '79000000-0000-4000-8000-000000000021',
    authContextRef: 'session:issue-790',
    authMethod: 'session',
    principalId: trustedPrincipalId,
    tenantId,
  });

const subjectAuthorityEvidence = (
  input: Parameters<CurrentPricingDecisionSubjectAuthorityService['verify']>[0],
): CurrentPricingDecisionSubjectAuthorityEvidence => {
  const { request } = input;
  return Schema.decodeUnknownSync(PricingPurchaseContextVerificationEvidenceSchema)({
    actingPrincipalId: input.scope.principal.principalId,
    currentness: {
      evaluatedAt: request.decision.operationTime,
      observedAt: request.decision.operationTime,
      validFrom: request.decision.operationTime,
      validTo: null,
    },
    ownerRef: request.decision.purchasingContext.contextRef,
    ownerRevisionRef: request.decision.purchasingContext.contextRevision,
    subjectAuthority:
      request.subject.kind === 'GUEST'
        ? {
            guestEvidenceAuthorityRef: 'guest-evidence-authority:issue-790',
            guestSessionAuthorityRef: 'guest-session-authority:issue-790',
            kind: 'GUEST' as const,
            subject: request.subject,
            subjectAuthorityRevisionRef: 'guest-authority-revision:issue-790',
          }
        : {
            actorPrincipalId: input.scope.principal.principalId,
            kind: 'PROFILE' as const,
            partyAuthorityRef: 'party-authority:issue-790',
            partyAuthorityRevisionRef: 'party-authority-revision:issue-790',
            subject: request.subject,
            subjectAuthorityRef: 'profile-authority:issue-790',
            subjectAuthorityRevisionRef: 'profile-authority-revision:issue-790',
          },
    verificationRef: 'purchase-context-verification:issue-790',
    verifiedScope: {
      channelId: request.decision.commercialScope.channelId,
      legalEntityId: input.scope.sellingLegalEntityId,
      marketId: request.decision.commercialScope.marketId,
      tenantId: input.scope.principal.tenantId,
    },
  });
};

const verifyExactSubjectAuthority: CurrentPricingDecisionSubjectAuthorityService['verify'] = (input) =>
  Effect.succeed({
    evidence: subjectAuthorityEvidence(input),
    input,
    kind: 'CURRENT_PRICING_DECISION_SUBJECT_AUTHORITY_VERIFIED',
  });

const profileSubject = (tenantId: string) => ({
  authorizationSubject: { kind: 'RETAIL' as const },
  kind: 'PROFILE' as const,
  profileRef: {
    moduleId: 'commerce.customer-context' as const,
    resourceId: '79000000-0000-4000-8000-000000000001',
    resourceType: 'commerce.customer-context.retail-customer-profile' as const,
    tenantId,
  },
});

const forbiddenDownstreamKeys = ['quotation', 'guarantee', 'order', 'tax', 'shipping', 'storefrontId'] as const;

const makeEvaluationAttempt = (ordinal: 1 | 2, currencyCode?: string) => {
  const suffix = ordinal.toString();
  const timing =
    ordinal === 1
      ? {
          capturedAt: '2026-09-28T10:00:04.000Z',
          completedAt: '2026-09-28T10:00:05.000Z',
          evaluatedAt: '2026-09-28T10:00:02.000Z',
          observedAt: '2026-09-28T10:00:03.000Z',
          requestedAt: '2026-09-28T10:00:01.000Z',
          startedAt: '2026-09-28T10:00:00.000Z',
        }
      : {
          capturedAt: '2026-09-28T10:00:10.000Z',
          completedAt: '2026-09-28T10:00:11.000Z',
          evaluatedAt: '2026-09-28T10:00:08.000Z',
          observedAt: '2026-09-28T10:00:09.000Z',
          requestedAt: '2026-09-28T10:00:07.000Z',
          startedAt: '2026-09-28T10:00:06.000Z',
        };
  const snapshot = makeIssue787Snapshot({
    attemptId: `attempt-790-${suffix}`,
    capturedAt: timing.capturedAt,
    currencyCode: currencyCode ?? 'CZK',
    evaluatedAt: timing.evaluatedAt,
    observedAt: timing.observedAt,
    requestedAt: timing.requestedAt,
    revision: suffix,
    snapshotId: `snapshot-790-${suffix}`,
  });
  return Schema.decodeSync(PricingEvaluationAttemptSchema, { onExcessProperty: 'error' })({
    attemptId: snapshot.attemptId,
    attemptOrdinal: ordinal,
    candidateRef: snapshot.candidateRef,
    completedAt: timing.completedAt,
    maxAttempts: 2,
    runId: 'run-790',
    snapshot,
    startedAt: timing.startedAt,
  });
};

const makeEvaluationRequest = (currencyCode?: string) => {
  const attempts = [makeEvaluationAttempt(1, currencyCode), makeEvaluationAttempt(2, currencyCode)] as const;
  const [
    {
      snapshot: { decision },
    },
  ] = attempts;
  const request = decodeDecisionRequest({ decision, subject: decision.purchasingContext.subject });
  const principal = trustedPrincipal(request.decision.tenantId);
  const trustedScope = {
    purchaseContextEvidence: subjectAuthorityEvidence({
      request,
      scope: { principal, sellingLegalEntityId: request.decision.commercialScope.sellingLegalEntityId },
    }),
    sellingLegalEntityId: request.decision.commercialScope.sellingLegalEntityId,
    tenantId: request.decision.tenantId,
  };
  return { attempts, request, trustedScope };
};

const candidateForAttempt = (attempt: ReturnType<typeof makeEvaluationAttempt>) => ({
  candidateRef: attempt.candidateRef,
  occurrenceIds: attempt.snapshot.decision.lines.map(({ occurrenceId }) => occurrenceId),
});

type ConflictOutcome = Extract<PricingDecisionOutcome, { readonly outcome: 'PRICING_CONFLICT' }>;
type IndeterminateOutcome = Extract<PricingDecisionOutcome, { readonly outcome: 'PRICING_INDETERMINATE' }>;
type StaleOutcome = Extract<PricingDecisionOutcome, { readonly outcome: 'PRICING_STALE' }>;

const conflictOutcome = (attempt: ReturnType<typeof makeEvaluationAttempt>): ConflictOutcome => ({
  candidate: candidateForAttempt(attempt),
  currentTruthRefs: ['price-current:790-a', 'price-current:790-b'],
  outcome: 'PRICING_CONFLICT',
  reasonCode: 'COMPETING_CURRENT_EXACT_PRICES',
  retryable: false,
});

const staleOutcome = (attempt: ReturnType<typeof makeEvaluationAttempt>): StaleOutcome => ({
  candidate: candidateForAttempt(attempt),
  outcome: 'PRICING_STALE',
  reasonCode: 'PRICE_REVISION_STALE',
  retryable: true,
  staleEvidence: {
    assessedAt: '2026-09-28T10:00:00.000Z',
    invalidatedAt: '2026-09-28T10:00:01.000Z',
    invalidatedRevision: 'price-revision:790-b',
  },
});

const indeterminateOutcome = (
  attempt: ReturnType<typeof makeEvaluationAttempt>,
  reasonCode: 'CURRENTNESS_UNVERIFIABLE' | 'OWNER_STATE_UNAVAILABLE',
): IndeterminateOutcome => ({
  candidate: candidateForAttempt(attempt),
  inabilityEvidence: { attempts: attempt.attemptOrdinal, requiredOwnerRefs: ['pricing-owner:790'] },
  outcome: 'PRICING_INDETERMINATE',
  reasonCode,
  retryable: true,
});

const knownFailureWhole = (
  attempt: ReturnType<typeof makeEvaluationAttempt>,
  outcome: PricingDecisionOutcome,
): CurrentPricingDecisionWholeAttempt => {
  if (outcome.outcome === 'PRICING_STALE') {
    return {
      attempt: {
        attempt,
        classification: {
          _tag: 'MATERIAL_CHANGED',
          currentSnapshotId: attempt.snapshot.snapshotId,
          previousSnapshotId: 'snapshot-790-before',
          reasons: ['PRICE_SCHEDULE_BOUNDARY_CROSSED'],
        },
        kind: 'KNOWN_STALE_OR_MATERIAL_CHANGED',
      },
      outcome,
      requiredOwnerRefs: ['pricing-owner:790'],
    };
  }
  if (outcome.outcome === 'PRICING_INDETERMINATE') {
    return {
      attempt: { attempt, kind: 'INDETERMINATE_OR_UNVERIFIABLE', reason: outcome.reasonCode },
      outcome,
      requiredOwnerRefs: ['pricing-owner:790'],
    };
  }
  if (outcome.outcome !== 'PRICING_CONFIGURATION_ERROR' && outcome.outcome !== 'PRICING_CONFLICT') {
    throw new Error('Issue #790 known-failure fixture received a ready outcome');
  }
  return {
    attempt: { attempt, kind: 'KNOWN_INVALID_OR_CONFLICT', reason: outcome.reasonCode },
    outcome,
    requiredOwnerRefs: ['pricing-owner:790'],
  };
};

const sourceFor = (
  outcomes: readonly [PricingDecisionOutcome, PricingDecisionOutcome?],
  attempts: readonly [ReturnType<typeof makeEvaluationAttempt>, ReturnType<typeof makeEvaluationAttempt>],
): CurrentPricingDecisionWholeEvaluationPort => ({
  loadFresh: (_request, _trustedScope, ordinal) => {
    const attempt = attempts[ordinal - 1];
    const outcome = outcomes[ordinal - 1] ?? outcomes[0];
    if (attempt === undefined || outcome === undefined) {
      return Effect.die('Missing issue #790 whole-attempt fixture');
    }
    return Effect.succeed(knownFailureWhole(attempt, outcome));
  },
});

const unexpectedResolvedPublication = () => Effect.die('Resolved publication is not expected in this fixture');

const makeProvenAbsentOutcome = (attempt: ReturnType<typeof makeEvaluationAttempt>) => {
  const { decision } = attempt.snapshot;
  const [line] = decision.lines;
  if (line === undefined) {
    throw new Error('Issue #790 proven-absence fixture requires one Pricing Line');
  }
  const pricePredicateRef = 'pricing-price:exact:none:790';
  const priceCompleteness = {
    observedAt: '2026-09-28T10:00:03.000Z',
    ownerRevision: 'pricing-price-set:790',
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: pricePredicateRef },
  };
  const supportRootRef = {
    moduleId: 'commerce.pricing' as const,
    resourceId: '79000000-0000-4000-8000-000000000010',
    resourceType: 'commerce.pricing.currency-support' as const,
    tenantId: decision.tenantId,
  };
  const supportRevisionRef = {
    moduleId: 'commerce.pricing' as const,
    resourceId: '79000000-0000-4000-8000-000000000011',
    resourceType: 'commerce.pricing.currency-support-revision' as const,
    supportRootId: supportRootRef.resourceId,
    tenantId: decision.tenantId,
  };
  const supportCompleteness = {
    observedAt: '2026-09-28T10:00:03.000Z',
    ownerRevision: supportRevisionRef.resourceId,
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'pricing-currency-support:tenant:790' },
  };
  const supportVerificationRef = 'pricing-currency-support-proof:tenant:790';
  const exactKey = {
    commercialScope: decision.commercialScope,
    currencyCode: decision.currencyCode,
    exactPredicateRef: pricePredicateRef,
    groupSelector: { kind: 'NO_GROUP' as const },
    pricingBasis: line.pricingBasis,
    selection: line.catalog.selection,
  };
  return decodeInternalOutcome({
    decision,
    lookups: [
      {
        lookup: { absenceEvidence: priceCompleteness, exactKey, kind: 'NO_GROUP_ABSENT' },
        occurrenceId: line.occurrenceId,
        status: 'ABSENT',
      },
    ],
    outcome: 'NO_APPLICABLE_PRICE',
    proof: {
      currencySupport: {
        completenessEvidence: supportCompleteness,
        currentnessEvidence: {
          evaluatedAt: decision.operationTime,
          evaluationMode: 'CURRENT_WITH_REVALIDATION',
          observedAt: '2026-09-28T10:00:03.000Z',
          revalidatedAt: '2026-09-28T10:00:04.000Z',
          scheduleRevision: 1,
          supportRevisionRef,
          supportRootRef,
        },
        effectiveAt: decision.operationTime,
        effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
        factProofs: [
          {
            factRef: supportRootRef.resourceId,
            factRevisionRef: supportRevisionRef.resourceId,
            verificationRef: supportVerificationRef,
          },
        ],
        generation: 1,
        observedAt: '2026-09-28T10:00:03.000Z',
        outcome: 'SUPPORTED_CURRENCIES_CURRENT',
        pricingRevision: 'pricing-currency-support:790',
        scheduleRevision: 1,
        supportedCurrencies: ['CZK'],
        supportRevisionRef,
        supportRootRef,
        tenantId: decision.tenantId,
        verificationRef: supportVerificationRef,
      },
      currentness: {
        materialBindings: [
          {
            completenessEvidence: line.catalog.completeness,
            exactPredicateRef: line.catalog.completeness.scope.predicateRef,
            identityRef: line.occurrenceId,
            kind: 'CATALOG_HANDOFF',
            revisionRef: line.catalog.ownerRevision,
          },
          {
            completenessEvidence: line.catalog.completeness,
            exactPredicateRef: line.catalog.completeness.scope.predicateRef,
            identityRef: line.occurrenceId,
            kind: 'CATALOG_HIERARCHY',
            revisionRef: line.catalog.hierarchyRevision,
          },
          {
            completenessEvidence: supportCompleteness,
            exactPredicateRef: supportCompleteness.scope.predicateRef,
            identityRef: decision.tenantId,
            kind: 'CURRENCY_SUPPORT',
            revisionRef: supportRevisionRef.resourceId,
          },
          {
            completenessEvidence: priceCompleteness,
            exactPredicateRef: pricePredicateRef,
            identityRef: pricePredicateRef,
            kind: 'ABSENCE',
            revisionRef: priceCompleteness.ownerRevision,
          },
        ],
        status: 'CURRENT',
        verifiedAt: '2026-09-28T10:00:04.000Z',
      },
      effectiveAt: decision.operationTime,
      observedAt: '2026-09-28T10:00:03.000Z',
    },
  });
};

describe('issue #790 Current Pricing Decision read acceptance', () => {
  it.effect('accepts one or many stable occurrences and requires an exact Variant and Commerce Market', () =>
    Effect.gen(function* exactWholeCandidate() {
      const { compositionRequest } = yield* makeIssue779Scenario();
      const decision = decisionForGuest(compositionRequest.decision);
      const [firstLine] = decision.lines;
      if (firstLine === undefined) {
        throw new Error('Issue #790 fixture requires one Pricing Line');
      }

      const one = decodeDecisionRequest({ decision, subject: guestSubject });
      const secondLine = { ...firstLine, occurrenceId: 'line-790-b' };
      const many = decodeDecisionRequest({
        decision: { ...decision, lines: [firstLine, secondLine] },
        subject: guestSubject,
      });

      expect(one.decision.lines.map(({ occurrenceId }) => occurrenceId)).toEqual([firstLine.occurrenceId]);
      expect(many.decision.lines.map(({ occurrenceId }) => occurrenceId)).toEqual([
        firstLine.occurrenceId,
        'line-790-b',
      ]);
      expect(() =>
        decodeDecisionRequest({
          decision: {
            ...decision,
            lines: [
              {
                ...firstLine,
                catalog: {
                  ...firstLine.catalog,
                  selection: { productRef: firstLine.catalog.selection.productRef },
                },
              },
            ],
          },
          subject: guestSubject,
        }),
      ).toThrow();
      expect(() =>
        decodeDecisionRequest({
          decision: { ...decision, commercialScope: { ...decision.commercialScope, marketId: '' } },
          subject: guestSubject,
        }),
      ).toThrow();
      expect(currentPricingDecisionRead.descriptor).toMatchObject({
        entrypoint: {
          access: 'read',
          authorization: { kind: 'authenticated_principal' },
        },
        legalEntityScope: 'required',
      });
      expect(yield* encodeJson(decodeDecisionRequest({ decision, subject: guestSubject }))).not.toContain(
        '"principalId"',
      );
    }),
  );

  it.effect('keeps Guest and owner-qualified profile access explicit and Tenant coherent', () =>
    Effect.gen(function* subjectScope() {
      const { compositionRequest } = yield* makeIssue779Scenario();
      const profileDecision = compositionRequest.decision;
      const decision = decisionForGuest(profileDecision);

      expect(decodeDecisionRequest({ decision, subject: guestSubject }).subject.kind).toBe('GUEST');
      expect(
        decodeDecisionRequest({ decision: profileDecision, subject: profileDecision.purchasingContext.subject }).subject
          .kind,
      ).toBe('PROFILE');
      expect(() =>
        decodeDecisionRequest({
          decision: profileDecision,
          subject: profileSubject('79000000-0000-4000-8000-000000000099'),
        }),
      ).toThrow();
    }),
  );

  it.effect('rejects arbitrary Guest and cross-Profile authority before evaluation', () =>
    Effect.gen(function* rejectsUnownedSubjects() {
      const fixture = makeEvaluationRequest();
      const trusted = {
        legalEntityId: fixture.trustedScope.sellingLegalEntityId,
        principal: trustedPrincipal(fixture.trustedScope.tenantId),
      };
      let evaluations = 0;
      const evaluate = () => {
        evaluations += 1;
        return Effect.succeed({ kind: 'NON_RESOLVED' as const, outcome: conflictOutcome(fixture.attempts[0]) });
      };

      const arbitraryGuest = yield* resolveCurrentPricingDecision(
        fixture.request,
        trusted,
        () => Effect.fail(new CurrentPricingDecisionSubjectAuthorityRejected({ reason: 'SUBJECT_NOT_AUTHORIZED' })),
        evaluate,
      ).pipe(Effect.flip);

      const profileRequest = fixture.request;
      const otherProfileSubject = {
        ...profileSubject(fixture.request.decision.tenantId),
        profileRef: {
          ...profileSubject(fixture.request.decision.tenantId).profileRef,
          resourceId: '79000000-0000-4000-8000-000000000099',
        },
      };
      const otherProfileRequest = decodeDecisionRequest({
        decision: {
          ...fixture.request.decision,
          purchasingContext: {
            ...fixture.request.decision.purchasingContext,
            subject: otherProfileSubject,
          },
        },
        subject: otherProfileSubject,
      });
      const crossProfile = yield* resolveCurrentPricingDecision(
        profileRequest,
        trusted,
        (input) =>
          Effect.succeed({
            evidence: subjectAuthorityEvidence(input),
            input: { ...input, request: otherProfileRequest },
            kind: 'CURRENT_PRICING_DECISION_SUBJECT_AUTHORITY_VERIFIED',
          }),
        evaluate,
      ).pipe(Effect.flip);

      expect(Schema.is(ReadPermissionDenied)(arbitraryGuest)).toBe(true);
      expect(Schema.is(ReadHandlerUnavailable)(crossProfile)).toBe(true);
      expect(evaluations).toBe(0);
    }),
  );

  it.effect(
    'keeps Tenant Currency Support independent from purchase evaluation and does not narrow currency contracts',
    () =>
      Effect.gen(function* independentSupportRead() {
        const { compositionRequest } = yield* makeIssue779Scenario();
        const { decision } = compositionRequest;
        const support = decodeSupportRequest({ effectiveAt: decision.operationTime, tenantId: decision.tenantId });
        const eurDecision = {
          ...decision,
          currencyCode: 'EUR' as const,
          purchasingContext: {
            ...decision.purchasingContext,
            currencyResolution: { ...decision.purchasingContext.currencyResolution, currencyCode: 'EUR' as const },
          },
        };
        const eur = decodeDecisionRequest({ decision: eurDecision, subject: eurDecision.purchasingContext.subject });

        expect(support).toEqual({ effectiveAt: decision.operationTime, tenantId: decision.tenantId });
        expect(support).not.toHaveProperty('subject');
        expect(support).not.toHaveProperty('lines');
        expect(eur.decision.currencyCode).toBe('EUR');
      }),
  );

  it.effect('preserves Group and NONE paths and still applies a manual Group contractual discount', () =>
    Effect.gen(function* pricingPaths() {
      const noGroup = yield* calculatePricingUnitPrice(
        yield* unitPriceCalculationAttempt({ groupPath: false, occurrenceId: 'line-790-none' }),
      );
      const grouped = yield* makeIssue779Scenario({ discounts: ['0', '10', '0'] });
      const groupedPath = grouped.unitPrice.input.exactPrice.path;
      const noGroupPath = Match.value(noGroup.input.exactPrice.path).pipe(
        Match.tag('NO_GROUP_GUEST', (path) => path),
        Match.orElse(() => null),
      );
      const canonicalGroupPath = Match.value(groupedPath).pipe(
        Match.tag('GROUP_PRICE', (path) => path),
        Match.orElse(() => null),
      );
      const groupDiscount = grouped.compositionRequest.discountComposition.lineContributions.find(
        ({ candidate: discountCandidate }) => discountCandidate.layer === 'PRICE_GROUP_CONTRACTUAL',
      );

      expect(noGroupPath?.discountAudience).toEqual({ kind: 'NONE' });
      expect(canonicalGroupPath?.discountAudience).toMatchObject({ kind: 'PRICE_GROUP' });
      expect(groupDiscount).toMatchObject({
        amount: { amount: '-10', currencyCode: 'CZK' },
        candidate: { layer: 'PRICE_GROUP_CONTRACTUAL' },
      });
    }),
  );

  it('keeps absent, conflict, stale, unavailable, and unverifiable outcomes distinct', () => {
    const firstAttempt = makeEvaluationAttempt(1);
    const secondAttempt = makeEvaluationAttempt(2);
    const absent = makeProvenAbsentOutcome(firstAttempt);
    const conflict = conflictOutcome(firstAttempt);
    const stale = staleOutcome(firstAttempt);
    const unavailable = indeterminateOutcome(firstAttempt, 'OWNER_STATE_UNAVAILABLE');
    const unverifiable = indeterminateOutcome(secondAttempt, 'CURRENTNESS_UNVERIFIABLE');

    expect([
      absent.outcome,
      conflict.outcome,
      stale.outcome,
      `${unavailable.outcome}:${unavailable.reasonCode}`,
      `${unverifiable.outcome}:${unverifiable.reasonCode}`,
    ]).toEqual([
      'NO_APPLICABLE_PRICE',
      'PRICING_CONFLICT',
      'PRICING_STALE',
      'PRICING_INDETERMINATE:OWNER_STATE_UNAVAILABLE',
      'PRICING_INDETERMINATE:CURRENTNESS_UNVERIFIABLE',
    ]);
  });

  it.effect('keeps Storefront and downstream commitment or payable concepts outside the read request', () =>
    Effect.gen(function* noDownstreamScope() {
      const { compositionRequest } = yield* makeIssue779Scenario();
      const decision = decisionForGuest(compositionRequest.decision);
      const request = decodeDecisionRequest({ decision, subject: guestSubject });
      const serialized = yield* encodeJson(request);

      for (const key of forbiddenDownstreamKeys) {
        expect(serialized).not.toContain(`"${key}"`);
      }
      expect(() => decodeDecisionRequest({ ...request, storefrontId: 'storefront:790' })).toThrow();
      expect(() => decodeDecisionRequest({ ...request, quotationRef: 'quotation:790' })).toThrow();
    }),
  );

  it.effect('returns owner-proven exact-path absence with its internal evidence and no retained-read guarantee', () =>
    Effect.gen(function* provenAbsence() {
      const fixture = makeEvaluationRequest();
      const outcome = makeProvenAbsentOutcome(fixture.attempts[0]);
      if (outcome.outcome !== 'NO_APPLICABLE_PRICE') {
        throw new Error('Issue #790 fixture requires canonical NO_APPLICABLE_PRICE');
      }
      const whole: CurrentPricingDecisionWholeAttempt = {
        attempt: {
          attempt: fixture.attempts[0],
          kind: 'READY_FOR_FINAL_PUBLICATION',
          publicationRequest: { kind: 'NO_APPLICABLE_PRICE', outcome },
        },
        outcome,
        requiredOwnerRefs: ['pricing-price-set:790'],
      };
      const source: CurrentPricingDecisionWholeEvaluationPort = {
        loadFresh: () => Effect.succeed(whole),
      };

      const evaluation = makeCurrentPricingDecisionEvaluationService(source, unexpectedResolvedPublication);
      const internal = yield* evaluation.evaluate(fixture.request, fixture.trustedScope);
      const customerSafe = yield* resolveCurrentPricingDecision(
        fixture.request,
        {
          legalEntityId: fixture.trustedScope.sellingLegalEntityId,
          principal: trustedPrincipal(fixture.trustedScope.tenantId),
        },
        verifyExactSubjectAuthority,
        evaluation.evaluate,
      );
      const serialized = yield* encodeJson(customerSafe);

      expect(internal).toEqual({ kind: 'NON_RESOLVED', outcome });
      if (internal.kind !== 'NON_RESOLVED') {
        throw new Error('Issue #790 absence must remain a non-resolved evaluation');
      }
      expect(internal.outcome).toMatchObject({
        lookups: [{ lookup: { kind: 'NO_GROUP_ABSENT' }, status: 'ABSENT' }],
        outcome: 'NO_APPLICABLE_PRICE',
        proof: { currentness: { status: 'CURRENT' } },
      });
      expect(Schema.is(CurrentPricingDecisionResponseSchema)(customerSafe)).toBe(true);
      expect(customerSafe).toEqual({
        candidate: { occurrenceIds: fixture.request.decision.lines.map(({ occurrenceId }) => occurrenceId) },
        outcome: 'NO_APPLICABLE_PRICE',
        projectionVersion: 'CURRENT_PRICING_DECISION_CUSTOMER_V1',
        retryable: false,
      });
      expect(serialized).not.toContain('"proof"');
      expect(serialized).not.toContain('"lookups"');
      for (const key of forbiddenDownstreamKeys) {
        expect(serialized).not.toContain(`"${key}"`);
      }
    }),
  );

  it.effect('returns an exact CZK owner outcome and rejects EUR operationally without FX or contract narrowing', () =>
    Effect.gen(function* launchCurrencyGate() {
      const czk = makeEvaluationRequest();
      const czkConflict = conflictOutcome(czk.attempts[0]);
      const czkService = makeCurrentPricingDecisionEvaluationService(
        sourceFor([czkConflict], czk.attempts),
        unexpectedResolvedPublication,
      );
      const czkResult = yield* czkService.evaluate(czk.request, czk.trustedScope);

      const eur = makeEvaluationRequest('EUR');
      const eurConflict = conflictOutcome(eur.attempts[0]);
      const eurService = makeCurrentPricingDecisionEvaluationService(
        sourceFor([eurConflict], eur.attempts),
        unexpectedResolvedPublication,
      );
      const eurResult = yield* eurService.evaluate(eur.request, eur.trustedScope);

      expect(czkResult).toEqual({ kind: 'NON_RESOLVED', outcome: czkConflict });
      if (eurResult.kind !== 'NON_RESOLVED') {
        throw new Error('Issue #790 unsupported currency must remain a non-resolved evaluation');
      }
      expect(eur.request.decision.currencyCode).toBe('EUR');
      expect(eurResult.outcome).toMatchObject({
        outcome: 'PRICING_CONFIGURATION_ERROR',
        reasonCode: 'UNSUPPORTED_CURRENCY',
        retryable: false,
      });
      expect(eurResult.outcome).not.toHaveProperty('convertedAmount');
      expect(eurResult.outcome).not.toHaveProperty('exchangeRate');
    }),
  );

  it.effect('does not infer stale from processing latency but preserves a real revision invalidation', () =>
    Effect.gen(function* currentnessSemantics() {
      const fixture = makeEvaluationRequest();
      const delayedAttempt = {
        ...fixture.attempts[0],
        completedAt: '2026-09-28T10:45:00.000Z',
      };
      const delayedConflict = conflictOutcome(delayedAttempt);
      const delayedSource = sourceFor([delayedConflict], [delayedAttempt, fixture.attempts[1]]);
      const delayed = yield* makeCurrentPricingDecisionEvaluationService(
        delayedSource,
        unexpectedResolvedPublication,
      ).evaluate(fixture.request, fixture.trustedScope);

      const staleFirst = staleOutcome(fixture.attempts[0]);
      const staleSecond = staleOutcome(fixture.attempts[1]);
      const stale = yield* makeCurrentPricingDecisionEvaluationService(
        sourceFor([staleFirst, staleSecond], fixture.attempts),
        unexpectedResolvedPublication,
      ).evaluate(fixture.request, fixture.trustedScope);

      expect(delayed).toEqual({ kind: 'NON_RESOLVED', outcome: delayedConflict });
      if (stale.kind !== 'NON_RESOLVED') {
        throw new Error('Issue #790 stale result must remain a non-resolved evaluation');
      }
      expect(stale.outcome).toMatchObject({ outcome: 'PRICING_STALE', reasonCode: 'PRICE_REVISION_STALE' });
    }),
  );

  it.effect('preserves unavailable and unverifiable owner results as distinct typed outcomes', () =>
    Effect.gen(function* distinctIndeterminateReasons() {
      const unavailableFixture = makeEvaluationRequest();
      const unavailableFirst = indeterminateOutcome(unavailableFixture.attempts[0], 'OWNER_STATE_UNAVAILABLE');
      const unavailableSecond = indeterminateOutcome(unavailableFixture.attempts[1], 'OWNER_STATE_UNAVAILABLE');
      const unavailable = yield* makeCurrentPricingDecisionEvaluationService(
        sourceFor([unavailableFirst, unavailableSecond], unavailableFixture.attempts),
        unexpectedResolvedPublication,
      ).evaluate(unavailableFixture.request, unavailableFixture.trustedScope);

      const unverifiableFixture = makeEvaluationRequest();
      const unverifiableFirst = indeterminateOutcome(unverifiableFixture.attempts[0], 'CURRENTNESS_UNVERIFIABLE');
      const unverifiableSecond = indeterminateOutcome(unverifiableFixture.attempts[1], 'CURRENTNESS_UNVERIFIABLE');
      const unverifiable = yield* makeCurrentPricingDecisionEvaluationService(
        sourceFor([unverifiableFirst, unverifiableSecond], unverifiableFixture.attempts),
        unexpectedResolvedPublication,
      ).evaluate(unverifiableFixture.request, unverifiableFixture.trustedScope);

      if (unavailable.kind !== 'NON_RESOLVED' || unverifiable.kind !== 'NON_RESOLVED') {
        throw new Error('Issue #790 owner-read failures must remain non-resolved evaluations');
      }
      expect(unavailable.outcome).toMatchObject({
        outcome: 'PRICING_INDETERMINATE',
        reasonCode: 'OWNER_STATE_UNAVAILABLE',
      });
      expect(unverifiable.outcome).toMatchObject({
        outcome: 'PRICING_INDETERMINATE',
        reasonCode: 'CURRENTNESS_UNVERIFIABLE',
      });
    }),
  );

  it.effect('fails a mismatched trusted Tenant or Selling Legal Entity before owner evaluation', () =>
    Effect.gen(function* trustedScopeGate() {
      const fixture = makeEvaluationRequest();
      let calls = 0;
      const source: CurrentPricingDecisionWholeEvaluationPort = {
        loadFresh: () => {
          calls += 1;
          return Effect.die('The owner evaluator must not observe an untrusted scope');
        },
      };
      const service = makeCurrentPricingDecisionEvaluationService(source, unexpectedResolvedPublication);
      const tenantExit = yield* Effect.exit(
        service.evaluate(fixture.request, { ...fixture.trustedScope, tenantId: 'tenant-other' }),
      );
      const legalEntityExit = yield* Effect.exit(
        service.evaluate(fixture.request, {
          ...fixture.trustedScope,
          sellingLegalEntityId: '79000000-0000-4000-8000-000000000099',
        }),
      );

      expect(Exit.isFailure(tenantExit)).toBe(true);
      expect(Exit.isFailure(legalEntityExit)).toBe(true);
      expect(calls).toBe(0);
    }),
  );
});
