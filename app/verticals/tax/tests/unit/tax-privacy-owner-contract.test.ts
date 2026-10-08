import { Effect, Exit, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PrivacyOwnerCoverageResultSchema, PrivacyOwnerExecutionOutcomeSchema } from '@app/shared-contracts';

import { RecordTaxSourceAssertionPayloadSchema } from '../../shared/actions/tax-source-assertion.ts';
import { TaxPrivacyOwnerCoverageRequestSchema } from '../../shared/apis/tax-privacy-owner-coverage.ts';
import {
  assessTaxPrivacyOwnerCoverage,
  evaluateTaxPrivacyMeasure,
  taxPrivacyOwnerContract,
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

const assertionContent = 'commerce.tax/tax_source_assertions/assertion-956';

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

const foundCoverage = assess(
  completeObservations({ SELLING_LEGAL_ENTITY_SOURCE_ASSERTION_HISTORY: [assertionContent] }),
);

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
  targetContentRefs: [assertionContent],
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
    const covered = new Set(Object.values(taxPrivacyOwnerContract.scopePartTables).flat());
    expect([...covered].toSorted()).toEqual([...TAX_TABLE_INVENTORY].toSorted());
    expect(Object.keys(taxPrivacyOwnerContract.scopePartTables).toSorted()).toEqual(
      [...taxPrivacyOwnerScopeParts].toSorted(),
    );
  });

  it('declares Order/Billing copies of Accepted Tax Terms instead of persisting them (D2 default a, F14)', () => {
    expect(taxPrivacyOwnerContract.scopePartTables.ACCEPTED_TAX_TERMS_COPIES).toEqual([]);
    expect(taxPrivacyOwnerContract.acceptedTaxTermsCopyHolders.length).toBeGreaterThan(0);
    expect(taxPrivacyOwnerContract.externalCopyRecipients).toEqual([]);
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
      observation.scopePart === 'SELLING_LEGAL_ENTITY_SOURCE_ASSERTION_HISTORY'
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
    const { outcome } = evaluate();
    expect(decodeOutcome(outcome).status).toBe('BUSINESS_REJECTED');
    expect(outcome.reason).toBe('NO_SUPPORTED_TAX_PRIVACY_LIFECYCLE_OPERATION');
    expect(outcome.remainingContentRefs).toEqual([assertionContent]);
    expect(outcome.affectedContentRefs).toEqual([]);
  });

  it('reports BLOCKED under a Current Legal Hold instead of bypassing it (F33-F35, BDD required evidence)', () => {
    const { outcome } = evaluate({
      blockers: [{ blockerRef: 'privacy:legal-hold-956', contentRefs: [assertionContent], kind: 'LEGAL_HOLD' }],
    });
    expect(decodeOutcome(outcome).status).toBe('BLOCKED');
    expect(outcome.reason).toBe('LEGAL_HOLD_OR_RETENTION_OBLIGATION_IS_CURRENT');
  });

  it('validates the Current target against TAX owner coverage before any effect (F33)', () => {
    const { outcome } = evaluate({
      measure: { ...measure, targetContentRefs: ['commerce.tax/tax_rules/not-covered'] },
    });
    expect(outcome.status).toBe('BUSINESS_REJECTED');
    expect(outcome.reason).toBe('TARGET_CONTENT_NOT_IN_CURRENT_TAX_OWNER_COVERAGE');
  });

  it('returns NOT_APPLICABLE only on complete NO_DATA and INDETERMINATE on incomplete coverage (F18-F19)', () => {
    expect(evaluate({ coverage: assess(completeObservations()) }).outcome.status).toBe('NOT_APPLICABLE');
    const incomplete = evaluate({ coverage: assess([]) }).outcome;
    expect(decodeOutcome(incomplete).status).toBe('INDETERMINATE');
    expect(incomplete.reconciliationRequired).toBe(true);
  });

  it('rejects coverage that belongs to another Privacy scope', () => {
    const { outcome } = evaluate({
      coverage: { ...foundCoverage, scope: { ...scope, requestedScopeRef: 'privacy-owner-scope:tax/other' } },
    });
    expect(outcome.reason).toBe('OWNER_COVERAGE_SCOPE_DOES_NOT_MATCH_MEASURE_SCOPE');
  });

  it('replays a retry of the same measure without a second effect and rejects a changed identity (F47)', () => {
    const first = evaluate().outcome;
    expect(evaluate({ previousAttempt: { measure, outcome: first } }).outcome).toEqual(first);
    const changed = evaluate({
      measure: { ...measure, intendedOutcome: 'ANONYMIZE' },
      previousAttempt: { measure, outcome: first },
    }).outcome;
    expect(changed.reason).toBe('IDEMPOTENCY_IDENTITY_OR_MEASURE_SCOPE_CONFLICT');
  });

  it('requires owner reconciliation before retrying an indeterminate attempt (F48)', () => {
    const indeterminate = evaluate({ coverage: assess([]) }).outcome;
    const previousAttempt = { measure, outcome: indeterminate };
    expect(evaluate({ previousAttempt }).outcome.reason).toBe('OWNER_RECONCILIATION_REQUIRED_BEFORE_RETRY');
    const retried = evaluate({
      previousAttempt,
      reconciliation: {
        evidenceRefs: ['privacy:reconciliation-956'],
        measureRef: measure.measureRef,
        observedAt: '2026-10-08T12:04:00.000Z',
        preconditionsRecheckedAt: '2026-10-08T12:05:00.000Z',
        retryAllowed: true,
        sourceDecisionRevision: measure.sourceDecisionRevision,
        status: 'NOT_EXECUTED',
      },
    }).outcome;
    expect(retried.reason).toBe('NO_SUPPORTED_TAX_PRIVACY_LIFECYCLE_OPERATION');
  });

  it('accepts a confirmed disposition only with exact, payload-free anti-resurrection evidence (F42-F45, F50)', () => {
    const previousAttempt = { measure, outcome: evaluate({ coverage: assess([]) }).outcome };
    const reconciliation = {
      evidenceRefs: ['privacy:reconciliation-956'],
      measureRef: measure.measureRef,
      observedAt: '2026-10-08T12:04:00.000Z',
      retryAllowed: false,
      sourceDecisionRevision: measure.sourceDecisionRevision,
      status: 'EXECUTION_CONFIRMED',
    } as const;
    const protection = {
      enforcedAt: '2026-10-08T12:04:00.000Z',
      evidenceRefs: ['tax:protection-956'],
      kind: 'DELETED_SCOPE',
      protectedContentRefs: [assertionContent],
      protectionRef: 'tax:protection-956',
      retainsRemovedPayload: false,
      scope,
      sourceDecisionRef: measure.sourceDecisionRef,
      sourceDecisionRevision: measure.sourceDecisionRevision,
      sourceOutcomeRef: 'privacy-owner-outcome:tax/956',
      staleSourceResponsibilities: ['IMPORT', 'REPLAY', 'PROJECTION_REBUILD', 'BACKUP_RECOVERY'],
    } as const;
    expect(evaluate({ previousAttempt, reconciliation }).outcome.status).toBe('PARTIAL');
    const partialProtection = { ...protection, staleSourceResponsibilities: ['IMPORT'] as const };
    expect(
      evaluate({ antiResurrectionProtection: partialProtection, previousAttempt, reconciliation }).outcome.status,
    ).toBe('PARTIAL');
    const achieved = evaluate({ antiResurrectionProtection: protection, previousAttempt, reconciliation });
    expect(decodeOutcome(achieved.outcome).status).toBe('ACHIEVED');
    expect(achieved.antiResurrectionProtection?.protectedContentRefs).toEqual([assertionContent]);
  });
});

describe('#956 TAX data minimization', () => {
  const payload = {
    factFamily: 'SELLING_LEGAL_ENTITY_VAT_REGISTRATION',
    jurisdiction: 'CZ_DOMESTIC',
    provenanceRef: 'acceptance:source-assertion',
    reason: 'Record seller VAT registration evidence',
    registrationMeaning: 'REGISTERED',
    sourceAssertionKey: 'erp-assertion-1',
    sourceRecordRef: 'erp-record-1',
    sourceRef: 'erp.finance',
    validFrom: '2026-01-01T00:00:00.000Z',
  };

  it.each(['rawPayload', 'providerResponse', 'legalName', 'address', 'contactPoint', 'apiKey', 'token'])(
    'does not accept %s as TAX source evidence (F6-F11, BDD provider payload with unrelated fields)',
    (field) => {
      const decode = Schema.decodeUnknownResult(RecordTaxSourceAssertionPayloadSchema, { onExcessProperty: 'error' });
      expect(Result.isSuccess(decode(payload))).toBe(true);
      expect(Result.isSuccess(decode({ ...payload, [field]: 'unrelated provider content' }))).toBe(false);
    },
  );
});
