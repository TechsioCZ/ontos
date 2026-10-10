import type { DomainEventReference, OperationalScope } from '@app/core-runtime';
import { Effect, Match, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CorrectTaxRuleRevisionPayloadSchema,
  CreateTaxRulePayloadSchema,
  CreateTaxRuleRevisionPayloadSchema,
  EndTaxRuleRevisionPayloadSchema,
} from '../../shared/actions/tax-governance.ts';
import {
  DeclareSellerVatRegimePayloadSchema,
  DeclareSellerVatRegimeResultSchema,
} from '../../shared/actions/seller-vat-regime-declaration.ts';
import { TaxGovernanceAuditEvidenceSchema, TaxGovernanceConflict } from '../../shared/domain/tax-governance-errors.ts';
import { handleCorrectTaxRuleRevision } from '../../src/actions/correct-tax-rule-revision.action.ts';
import { handleCreateTaxRuleRevision } from '../../src/actions/create-tax-rule-revision.action.ts';
import { handleCreateTaxRule } from '../../src/actions/create-tax-rule.action.ts';
import { handleDeclareSellerVatRegime } from '../../src/actions/declare-seller-vat-regime.action.ts';
import { handleEndTaxRuleRevision } from '../../src/actions/end-tax-rule-revision.action.ts';
import type { TaxRuleGovernancePersistence } from '../../src/services/tax-rule-governance.service.ts';
import type {
  SellerVatRegimeDeclarationOutcome,
  SellerVatRegimeDeclarations,
} from '../../src/services/seller-vat-regime-declaration.service.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const scope = {
  authContextRef: 'better-auth-session:tax-governance-test',
  authMethod: 'session',
  correlationId: 'tax-governance-test',
  legalEntityId,
  principalId,
  tenantId,
} satisfies OperationalScope;

const expectedBasisFingerprint = 'a'.repeat(64);
const meaningFingerprint = 'b'.repeat(64);
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.tax',
  resourceId,
  resourceType,
  tenantId,
});
const ruleRevisionRef = (resourceId: string) => ref('commerce.tax.tax-rule-revision', resourceId);
const revisionContent = {
  compositionKind: 'EXCLUSIVE',
  effectiveFrom: '2027-01-01T00:00:00.000Z',
  jurisdiction: 'CZ_DOMESTIC',
  ratePercent: '21',
  taxClassificationCode: 'cz-standard-goods',
  treatmentCategory: 'TAXABLE',
};
const attribution = { provenanceRef: 'test:tax-governance', reason: 'Governed tax change' };

const unused = () => Effect.die('unused tax governance service method');
const ruleServices = (overrides: Partial<TaxRuleGovernancePersistence>): TaxRuleGovernancePersistence => ({
  correctTaxRuleRevision: unused,
  createTaxRule: unused,
  createTaxRuleRevision: unused,
  endTaxRuleRevision: unused,
  ...overrides,
});
const declarationServices = (overrides: Partial<SellerVatRegimeDeclarations>): SellerVatRegimeDeclarations => ({
  atInstant: unused,
  declare: unused,
  history: Effect.die('unused tax governance service method'),
  ...overrides,
});

const context = <Services>(services: Services) => {
  const audit: unknown[] = [];
  // The production collector owns this opaque reference; this handler unit harness never dereferences it.
  const eventReference: DomainEventReference = Schema.decodeSync(Schema.Any)({});
  const value = {
    actionInvocationId: 'action-invocation-1',
    addDomainEvent: () => Effect.succeed(eventReference),
    addOutboxMessage: () => Effect.void,
    compositionRevision: 'c'.repeat(64),
    recordAuditEvidence: (evidence: Readonly<Record<string, Schema.Json>>) => {
      audit.push(evidence);
      return Effect.void;
    },
    recordDataAccess: () => Effect.void,
    scope,
    services,
  };
  return { audit, value };
};

const decodeAudit = (audit: readonly unknown[]) =>
  Schema.decodeUnknownEffect(Schema.Array(TaxGovernanceAuditEvidenceSchema))(audit);

it.effect(
  '#950 F45-F47 Tax Rule correction audit names the reason, expected-current evidence and resulting revision',
  () =>
    Effect.gen(function* correctionAudit() {
      const payload = yield* Schema.decodeUnknownEffect(CorrectTaxRuleRevisionPayloadSchema)({
        ...attribution,
        confirmedAt: '2026-02-01T00:00:00.000Z',
        correctingContent: revisionContent,
        expectedBasisFingerprint,
        wrongRevisionRef: ruleRevisionRef('wrong-revision'),
      });
      const prepared = context(
        ruleServices({
          correctTaxRuleRevision: (input) => {
            expect(input.operationTime).toBeInstanceOf(Date);
            return Effect.succeed({
              correctingRevisionId: 'correcting-revision',
              created: true,
              meaningFingerprint,
              wrongRevisionId: 'wrong-revision',
            });
          },
        }),
      );
      yield* handleCorrectTaxRuleRevision(payload, prepared.value);
      expect(yield* decodeAudit(prepared.audit)).toEqual([
        {
          action: 'CORRECT_TAX_RULE_REVISION',
          changed: true,
          expectedBasisFingerprint,
          meaningFingerprint,
          operation: 'CORRECT',
          reason: attribution.reason,
          resourceId: 'wrong-revision',
          resourceType: 'commerce.tax.tax-rule-revision',
          resultingRevisionId: 'correcting-revision',
        },
      ]);
    }),
);

it.effect(
  '#950 F46-F47 every governed Tax Rule mutation audits its expected-current evidence and resulting state',
  () =>
    Effect.gen(function* everyMutationAudit() {
      const rule = ruleServices({
        createTaxRule: () =>
          Effect.succeed({
            created: true,
            initialRevisionId: 'initial-revision',
            meaningFingerprint,
            revisionNumber: 1,
            taxRuleId: 'rule-1',
          }),
        createTaxRuleRevision: () =>
          Effect.succeed({ created: true, meaningFingerprint, revisionId: 'next-revision', revisionNumber: 2 }),
        endTaxRuleRevision: () =>
          Effect.succeed({ ended: true, endFactId: 'end-fact-1', meaningFingerprint, revisionId: 'ended-revision' }),
      });

      const created = context(rule);
      yield* handleCreateTaxRule(
        yield* Schema.decodeUnknownEffect(CreateTaxRulePayloadSchema)({
          ...attribution,
          initialRevision: revisionContent,
          meaningKind: 'VAT_RATE',
          stableCode: 'cz.standard',
        }),
        created.value,
      );
      const revised = context(rule);
      yield* handleCreateTaxRuleRevision(
        yield* Schema.decodeUnknownEffect(CreateTaxRuleRevisionPayloadSchema)({
          ...attribution,
          content: revisionContent,
          expectedBasisFingerprint,
          taxRuleRef: ref('commerce.tax.tax-rule', 'rule-1'),
        }),
        revised.value,
      );
      const ended = context(rule);
      yield* handleEndTaxRuleRevision(
        yield* Schema.decodeUnknownEffect(EndTaxRuleRevisionPayloadSchema)({
          ...attribution,
          endedEffectiveTo: '2028-01-01T00:00:00.000Z',
          expectedBasisFingerprint,
          taxRuleRevisionRef: ruleRevisionRef('ended-revision'),
        }),
        ended.value,
      );

      const evidence = (prepared: { readonly audit: readonly unknown[] }) =>
        decodeAudit(prepared.audit).pipe(
          Effect.map(([only]) => ({
            expectedBasisFingerprint: only?.expectedBasisFingerprint,
            reason: only?.reason,
            resultingEndFactId: only?.resultingEndFactId,
            resultingRevisionId: only?.resultingRevisionId,
          })),
        );
      const { reason } = attribution;
      expect(yield* evidence(created)).toEqual({ reason, resultingRevisionId: 'initial-revision' });
      expect(yield* evidence(revised)).toEqual({
        expectedBasisFingerprint,
        reason,
        resultingRevisionId: 'next-revision',
      });
      expect(yield* evidence(ended)).toEqual({ expectedBasisFingerprint, reason, resultingEndFactId: 'end-fact-1' });
    }),
);

const declarePayload = Schema.decodeEffect(DeclareSellerVatRegimePayloadSchema)({
  effectiveFrom: '2026-02-01T00:00:00.000Z',
  expectedCurrentRevision: 0,
  regime: 'VAT_PAYER',
});

it.effect(
  '#907 Unit 10 a merchant-declared regime audits a merchant-declaration reason, never a verification claim',
  () =>
    Effect.gen(function* declareAudit() {
      const prepared = context(
        declarationServices({
          declare: () =>
            Effect.succeed<SellerVatRegimeDeclarationOutcome>({
              audit: {
                changed: true,
                meaningFingerprint,
                resourceId: 'declaration-1',
                resourceType: 'commerce.tax.seller-vat-regime-declaration',
              },
              result: {
                _tag: 'DECLARED',
                created: true,
                declarationRef: {
                  moduleId: 'commerce.tax',
                  resourceId: 'declaration-1',
                  resourceType: 'commerce.tax.seller-vat-regime-declaration',
                  tenantId,
                },
                replacedScheduledRevisions: [],
                revision: 1,
              },
            }),
        }),
      );
      const result = yield* handleDeclareSellerVatRegime(yield* declarePayload, prepared.value);
      const declaredResult = Match.value(result).pipe(
        Match.tag('DECLARED', ({ created, declarationRef: declared, replacedScheduledRevisions, revision }) => ({
          created,
          declarationRef: declared,
          replacedScheduledRevisions,
          revision,
        })),
        Match.orElse(() => Effect.die('expected a DECLARED result')),
      );
      expect(declaredResult).toEqual({
        created: true,
        declarationRef: ref('commerce.tax.seller-vat-regime-declaration', 'declaration-1'),
        replacedScheduledRevisions: [],
        revision: 1,
      });
      expect(yield* decodeAudit(prepared.audit)).toEqual([
        {
          action: 'DECLARE_SELLER_VAT_REGIME',
          changed: true,
          meaningFingerprint,
          operation: 'CREATE',
          reason: 'MERCHANT_DECLARATION',
          resourceId: 'declaration-1',
          resourceType: 'commerce.tax.seller-vat-regime-declaration',
        },
      ]);
      // Never a verification vocabulary: the regime is merchant-declared, never checked against an external source.
      const encoded = yield* Schema.encodeEffect(DeclareSellerVatRegimeResultSchema)(result);
      expect(Object.keys(encoded).join(',')).not.toMatch(/verif/iu);
    }),
);

it.effect('#907 Unit 10 a stale CAS basis fails the Action as a typed governance error', () =>
  Effect.gen(function* staleBasisFails() {
    const prepared = context(declarationServices({ declare: () => Effect.succeed({ kind: 'stale_basis' }) }));
    const failure = yield* handleDeclareSellerVatRegime(yield* declarePayload, prepared.value).pipe(Effect.flip);
    expect(
      Schema.is(Schema.TaggedStruct('TaxGovernanceStaleBasis', { code: Schema.String, reason: Schema.String }))(
        failure,
      ),
    ).toBe(true);
    expect(prepared.audit).toEqual([]);
  }),
);

it.effect('#955 G Core idempotency reuse of a declaration is the only conflict audited as nothing', () =>
  Effect.gen(function* idempotencyReuseFails() {
    const prepared = context(
      declarationServices({ declare: () => Effect.succeed({ conflict: 'IDEMPOTENCY_REUSED', kind: 'conflict' }) }),
    );
    const failure = yield* handleDeclareSellerVatRegime(yield* declarePayload, prepared.value).pipe(Effect.flip);
    expect(Schema.is(TaxGovernanceConflict)(failure)).toBe(true);
    expect(Schema.is(TaxGovernanceConflict)(failure) ? failure.conflict : undefined).toBe('IDEMPOTENCY_REUSED');
    expect(prepared.audit).toEqual([]);
  }),
);
