import { Effect, Exit, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PrivacyOwnerCoverageResultSchema, PrivacyOwnerExecutionOutcomeSchema } from '@app/shared-contracts';

import { DeclareSellerVatRegimePayloadSchema } from '../../shared/actions/seller-vat-regime-declaration.ts';
import { TaxPrivacyOwnerCoverageRequestSchema } from '../../shared/apis/tax-privacy-owner-coverage.ts';
import { taxEvidenceReadPermission } from '../../shared/permissions/tax-evidence-read.ts';
import {
  assessTaxPrivacyOwnerCoverage,
  evaluateTaxPrivacyMeasure,
  taxPrivacyOwnerDeclaration,
  taxPrivacyOwnerScopeParts,
  taxPrivacyOwnerScopeRefs,
} from '../../shared/tax-privacy-owner-contract.ts';
import type {
  TaxPrivacyMeasureEvaluationInput,
  TaxPrivacyScopeObservation,
} from '../../shared/tax-privacy-owner-contract.ts';
import { readTaxPrivacyOwnerCoverage } from '../../src/api/tax-privacy-owner-coverage.read.ts';
import { TAX_TABLE_INVENTORY } from '../../src/database/schema.ts';
import { unavailable } from '../../src/services/tax-governance-persistence.ts';
import { taxPrivacyScopePartTables } from '../../src/services/tax-privacy-coverage.service.ts';

const scope = {
  controllerRef: 'legal-entity:controller-a',
  dsrControllerObligationRef: 'privacy:dsr-obligation-956',
  ownerCapability: 'commerce.tax',
  requestedScopePartRefs: [...taxPrivacyOwnerScopeRefs],
  requestedScopeRef: 'privacy-owner-scope:tax/956',
  subject: { _tag: 'RESOLVED_DATA_SUBJECT', subjectRef: 'party:sole-trader-956' },
  tenantId: 'tenant-a',
  trustedLookupRefs: ['seller-lookup:956'],
} as const;

const declarationContent = 'commerce.tax.seller-vat-regime-declaration:declaration-956';

const completeObservations = (foundByPart: Partial<Record<string, readonly string[]>> = {}) =>
  taxPrivacyOwnerScopeParts.map((scopePart): TaxPrivacyScopeObservation => ({
    coverageStatus: 'COMPLETE',
    evidenceRefs: [`tax-coverage:${scopePart}`],
    foundContentRefs: foundByPart[scopePart] ?? [],
    observedAt: '2026-10-08T12:00:00.000Z',
    scopePart,
  }));

const assess = (observations: readonly TaxPrivacyScopeObservation[]) =>
  assessTaxPrivacyOwnerCoverage({
    assessedAt: '2026-10-08T12:01:00.000Z',
    evidenceRefs: ['tax-coverage:assessment-956'],
    observations,
    scope,
  });

const foundCoverage = assess(completeObservations({ SELLER_VAT_REGIME_DECLARATION_HISTORY: [declarationContent] }));

const measure = {
  expectedEvidenceRefs: ['privacy:expected-owner-outcome-956'],
  idempotencyKey: 'privacy-measure:956/revision-1',
  intendedOutcome: 'DELETE',
  measureRef: 'privacy-measure:956',
  preconditionRefs: ['privacy:legal-hold-check-956'],
  requestedAt: '2026-10-08T12:02:00.000Z',
  scope,
  sourceDecisionRef: 'privacy-disposition-decision:956',
  sourceDecisionRevision: 'revision-1',
  targetContentRefs: [declarationContent],
} as const;

const evaluate = (overrides: Partial<TaxPrivacyMeasureEvaluationInput> = {}) =>
  evaluateTaxPrivacyMeasure({
    blockers: [],
    confirmedAt: '2026-10-08T12:03:00.000Z',
    coverage: foundCoverage,
    evidenceRefs: ['tax-privacy-measure-evaluation:956'],
    measure,
    outcomeRef: 'privacy-owner-outcome:tax/956',
    ...overrides,
  });

const decodeCoverage = Schema.decodeUnknownSync(PrivacyOwnerCoverageResultSchema, { onExcessProperty: 'error' });
const decodeOutcome = Schema.decodeUnknownSync(PrivacyOwnerExecutionOutcomeSchema, { onExcessProperty: 'error' });

describe('#956 TAX Privacy Owner coverage declaration', () => {
  it('assigns every private TAX table to a declared owner scope part (F13-F16)', () => {
    const covered = new Set<string>(Object.values(taxPrivacyScopePartTables).flat());
    expect([...covered].toSorted()).toEqual([...TAX_TABLE_INVENTORY].toSorted());
    expect(Object.keys(taxPrivacyScopePartTables).toSorted()).toEqual([...taxPrivacyOwnerScopeParts].toSorted());
  });

  it('publishes the coverage read only under the privileged Tax Evidence permission (#956 F27, #950)', () => {
    expect(taxEvidenceReadPermission.protectedEntrypoints).toContain('commerce.tax.api.tax-privacy-owner-coverage');
  });

  it('declares Order/Billing copies of Accepted Tax Terms instead of persisting them (D2 default a, F14)', () => {
    expect(taxPrivacyScopePartTables.ACCEPTED_TAX_TERMS_COPIES).toEqual([]);
    expect(taxPrivacyOwnerDeclaration.acceptedTaxTermsCopyHolders.length).toBeGreaterThan(0);
    expect(taxPrivacyOwnerDeclaration.externalCopyRecipients).toEqual([]);
  });

  it('covers the finalized Launch Order Tax table by its own Decision/Result minimization part only (D2 default, ADR-0027)', () => {
    expect(taxPrivacyScopePartTables.ORDER_TAX_FINALIZATION_DECISION_EVIDENCE).toEqual(['tax_order_tax_finalizations']);
    // ACTOR_PRINCIPAL_ATTRIBUTION legitimately spans every TAX table (attribution columns exist on all of them);
    // every other content-specific part must stay disjoint from this minimization part.
    const otherContentParts = taxPrivacyOwnerScopeParts.filter(
      (part) => part !== 'ORDER_TAX_FINALIZATION_DECISION_EVIDENCE' && part !== 'ACTOR_PRINCIPAL_ATTRIBUTION',
    );
    for (const part of otherContentParts) {
      expect(taxPrivacyScopePartTables[part]).not.toContain('tax_order_tax_finalizations');
    }
  });
});

describe('#956 TAX Owner Contribution', () => {
  it('reports NO_DATA only when every TAX responsibility is completely observed (F18-F19)', () => {
    const coverage = decodeCoverage(assess(completeObservations()));
    expect(coverage.coverageStatus).toBe('COMPLETE');
    expect(coverage.contentStatus).toBe('NO_DATA');
  });

  it('does not treat one empty Current query as NO_DATA while other responsibilities are unobserved (F20)', () => {
    const coverage = decodeCoverage(
      assess(completeObservations().filter(({ scopePart }) => scopePart === 'TAX_RULE_GOVERNANCE_HISTORY')),
    );
    expect(coverage.coverageStatus).toBe('INDETERMINATE');
    expect(coverage.contentStatus).toBe('UNKNOWN');
    expect(coverage.coverageParts.find(({ scopeRef }) => scopeRef.endsWith('/ACCEPTED_TAX_TERMS_COPIES'))).toEqual(
      expect.objectContaining({ unresolvedReason: 'REQUIRED_TAX_OWNER_SCOPE_NOT_OBSERVED' }),
    );
  });

  it('keeps an unavailable TAX part unresolved rather than NO_DATA (BDD "TAX is temporarily unavailable")', () => {
    const observations = completeObservations().map((observation) =>
      observation.scopePart === 'SELLER_VAT_REGIME_DECLARATION_HISTORY'
        ? { ...observation, coverageStatus: 'UNAVAILABLE' as const, unresolvedReason: 'TAX_PERSISTENCE_UNAVAILABLE' }
        : observation,
    );
    const coverage = decodeCoverage(assess(observations));
    expect(coverage.coverageStatus).toBe('UNAVAILABLE');
    expect(coverage.contentStatus).toBe('UNKNOWN');
  });

  it('marks a duplicate observation indeterminate and keeps per-part observation times (F21-F22)', () => {
    const [first] = completeObservations();
    const coverage = decodeCoverage(assess(first === undefined ? [] : [...completeObservations(), first]));
    expect(coverage.coverageStatus).toBe('INDETERMINATE');
    expect(foundCoverage.coverageParts.every(({ observedAt }) => observedAt === '2026-10-08T12:00:00.000Z')).toBe(true);
  });

  it('never reports NO_DATA for a requested part TAX does not own or a foreign owner capability (F19)', () => {
    const extraPart = decodeCoverage(
      assessTaxPrivacyOwnerCoverage({
        assessedAt: '2026-10-08T12:01:00.000Z',
        evidenceRefs: [],
        observations: completeObservations(),
        scope: { ...scope, requestedScopePartRefs: [...scope.requestedScopePartRefs, 'commerce.tax/unexamined'] },
      }),
    );
    expect(extraPart.coverageStatus).toBe('INDETERMINATE');
    expect(extraPart.contentStatus).toBe('UNKNOWN');
    const foreign = decodeCoverage(
      assessTaxPrivacyOwnerCoverage({
        assessedAt: '2026-10-08T12:01:00.000Z',
        evidenceRefs: [],
        observations: completeObservations(),
        scope: { ...scope, ownerCapability: 'commerce.inventory' },
      }),
    );
    expect(foreign.contentStatus).toBe('UNKNOWN');
  });

  it('accepts only the exact TAX scope with typed lookups matching the trusted lookup refs', () => {
    const decode = Schema.decodeUnknownResult(TaxPrivacyOwnerCoverageRequestSchema);
    const lookup = {
      _tag: 'SELLING_LEGAL_ENTITY',
      legalEntityId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      lookupRef: 'seller-lookup:956',
    };
    expect(Result.isSuccess(decode({ scope, trustedLookups: [lookup] }))).toBe(true);
    expect(
      Result.isSuccess(
        decode({ scope: { ...scope, ownerCapability: 'commerce.inventory' }, trustedLookups: [lookup] }),
      ),
    ).toBe(false);
    expect(
      Result.isSuccess(
        decode({
          scope: { ...scope, requestedScopePartRefs: scope.requestedScopePartRefs.slice(1) },
          trustedLookups: [lookup],
        }),
      ),
    ).toBe(false);
    expect(Result.isSuccess(decode({ scope, trustedLookups: [{ ...lookup, lookupRef: 'other-lookup' }] }))).toBe(false);
  });
});

describe('#956 TAX coverage read', () => {
  it.effect('fails retryably instead of answering NO_DATA when TAX persistence is unavailable (F18)', () =>
    Effect.gen(function* unavailableCoverage() {
      const request = yield* Schema.decodeEffect(TaxPrivacyOwnerCoverageRequestSchema)({
        scope,
        trustedLookups: [
          {
            _tag: 'SELLING_LEGAL_ENTITY',
            legalEntityId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
            lookupRef: 'seller-lookup:956',
          },
        ],
      });
      const exit = yield* Effect.exit(
        readTaxPrivacyOwnerCoverage(request, {
          readKey: 'commerce.tax.api.tax-privacy-owner-coverage',
          scope: {
            authContextRef: 'session:956',
            authMethod: 'session',
            correlationId: 'correlation-956',
            legalEntityId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
            principalId: 'principal-956',
            tenantId: 'tenant-a',
          },
          services: { privacy: { coverage: () => Effect.fail(unavailable()) } },
        }),
      );
      expect(Exit.isFailure(exit) && Exit.findErrorOption(exit)).toEqual(
        expect.objectContaining({ value: expect.objectContaining({ _tag: 'ReadHandlerUnavailable' }) }),
      );
    }),
  );
});

describe('#956 TAX Privacy Measure execution', () => {
  it('never fabricates deletion: TAX has no supported disposition lifecycle for its evidence (F32, F38-F40)', () => {
    const outcome = evaluate();
    expect(decodeOutcome(outcome).status).toBe('BUSINESS_REJECTED');
    expect(outcome.reason).toBe('NO_SUPPORTED_TAX_PRIVACY_LIFECYCLE_OPERATION');
    expect(outcome.remainingContentRefs).toEqual([declarationContent]);
    expect(outcome.affectedContentRefs).toEqual([]);
  });

  it('reports BLOCKED under a Current Legal Hold instead of bypassing it (F33-F35, BDD required evidence)', () => {
    const outcome = evaluate({
      blockers: [{ blockerRef: 'privacy:legal-hold-956', contentRefs: [declarationContent], kind: 'LEGAL_HOLD' }],
    });
    expect(decodeOutcome(outcome).status).toBe('BLOCKED');
    expect(outcome.reason).toBe('LEGAL_HOLD_OR_RETENTION_OBLIGATION_IS_CURRENT');
  });

  it('blocks only destructive measures: a restriction under a Legal Hold is rejected as unsupported (F33-F35)', () => {
    const outcome = evaluate({
      blockers: [{ blockerRef: 'privacy:legal-hold-956', contentRefs: [declarationContent], kind: 'LEGAL_HOLD' }],
      measure: { ...measure, intendedOutcome: 'ENFORCE_PROCESSING_RESTRICTION' },
    });
    expect(outcome.status).toBe('BUSINESS_REJECTED');
    expect(outcome.reason).toBe('NO_SUPPORTED_TAX_PRIVACY_LIFECYCLE_OPERATION');
  });

  it('validates the Current target against TAX owner coverage before any effect (F33)', () => {
    const outcome = evaluate({ measure: { ...measure, targetContentRefs: ['commerce.tax.tax-rule:not-covered'] } });
    expect(outcome.status).toBe('BUSINESS_REJECTED');
    expect(outcome.reason).toBe('TARGET_CONTENT_NOT_IN_CURRENT_TAX_OWNER_COVERAGE');
  });

  it('returns NOT_APPLICABLE only on complete NO_DATA and INDETERMINATE on incomplete coverage (F18-F19)', () => {
    expect(evaluate({ coverage: assess(completeObservations()) }).status).toBe('NOT_APPLICABLE');
    const incomplete = evaluate({ coverage: assess([]) });
    expect(decodeOutcome(incomplete).status).toBe('INDETERMINATE');
    expect(incomplete.reason).toBe('TAX_OWNER_SCOPE_COVERAGE_INCOMPLETE');
  });

  it('settles a found target on partial coverage but never rejects a target that partial coverage cannot see (F20)', () => {
    const partialFound = assess(
      completeObservations({ SELLER_VAT_REGIME_DECLARATION_HISTORY: [declarationContent] }).map((observation) =>
        observation.scopePart === 'ACTOR_PRINCIPAL_ATTRIBUTION'
          ? { ...observation, coverageStatus: 'PARTIAL' as const, unresolvedReason: 'OTHER_SELLERS_NOT_OBSERVED' }
          : observation,
      ),
    );
    expect(partialFound.coverageStatus).toBe('PARTIAL');
    expect(evaluate({ coverage: partialFound }).reason).toBe('NO_SUPPORTED_TAX_PRIVACY_LIFECYCLE_OPERATION');
    const unseen = evaluate({
      coverage: partialFound,
      measure: { ...measure, targetContentRefs: ['commerce.tax.tax-rule:other-seller'] },
    });
    expect(decodeOutcome(unseen).status).toBe('INDETERMINATE');
    expect(unseen.reason).toBe('TAX_OWNER_SCOPE_COVERAGE_INCOMPLETE');
  });

  it('rejects coverage that belongs to another Privacy scope', () => {
    const outcome = evaluate({
      coverage: { ...foundCoverage, scope: { ...scope, requestedScopeRef: 'privacy-owner-scope:tax/other' } },
    });
    expect(outcome.reason).toBe('OWNER_COVERAGE_SCOPE_DOES_NOT_MATCH_MEASURE_SCOPE');
  });

  it('evaluates a retry of the same measure afresh and rejects a changed identity (F47)', () => {
    const first = evaluate();
    expect(evaluate({ previousMeasure: measure })).toEqual(first);
    const changed = evaluate({ measure: { ...measure, intendedOutcome: 'ANONYMIZE' }, previousMeasure: measure });
    expect(changed.reason).toBe('IDEMPOTENCY_IDENTITY_OR_MEASURE_SCOPE_CONFLICT');
  });

  it('re-evaluates a retry against Current coverage because no TAX effect was ever attempted (F48-F49)', () => {
    expect(evaluate({ coverage: assess([]) }).status).toBe('INDETERMINATE');
    const retried = evaluate({ previousMeasure: measure });
    expect(retried.reason).toBe('NO_SUPPORTED_TAX_PRIVACY_LIFECYCLE_OPERATION');
    expect(retried.affectedContentRefs).toEqual([]);
  });

  it('never reports ACHIEVED or PARTIAL for any intended outcome, first attempt or retry (F32, F35, F42)', () => {
    const intendedOutcomes = [
      'RECTIFY',
      'ENFORCE_DISPOSITION_RESTRICTION',
      'ENFORCE_PROCESSING_RESTRICTION',
      'ANONYMIZE',
      'DELETE',
    ] as const;
    const outcomes = intendedOutcomes.flatMap((intendedOutcome) => {
      const candidate = { ...measure, intendedOutcome };
      return [evaluate({ measure: candidate }), evaluate({ measure: candidate, previousMeasure: candidate })];
    });
    expect(outcomes.filter(({ status }) => status === 'ACHIEVED' || status === 'PARTIAL')).toEqual([]);
    expect(
      outcomes.every(
        ({ affectedContentRefs, remainingContentRefs }) =>
          affectedContentRefs.length === 0 && remainingContentRefs.length === 1,
      ),
    ).toBe(true);
  });
});

describe('#956 TAX data minimization', () => {
  const payload = {
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    expectedCurrentRevision: 0,
    regime: 'VAT_PAYER',
  };

  it.each(['rawPayload', 'providerResponse', 'legalName', 'address', 'contactPoint', 'apiKey', 'token'])(
    'does not accept %s as TAX seller VAT regime declaration evidence (F6-F11, BDD provider payload with unrelated fields)',
    (field) => {
      const decode = Schema.decodeUnknownResult(DeclareSellerVatRegimePayloadSchema, { onExcessProperty: 'error' });
      expect(Result.isSuccess(decode(payload))).toBe(true);
      expect(Result.isSuccess(decode({ ...payload, [field]: 'unrelated provider content' }))).toBe(false);
    },
  );
});
