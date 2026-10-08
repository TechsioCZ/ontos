import type { DomainEventReference, OperationalScope } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CorrectTaxRuleRevisionPayloadSchema,
  CreateTaxRulePayloadSchema,
  CreateTaxRuleRevisionPayloadSchema,
  EndTaxFactAuthorityContractPayloadSchema,
  EndTaxRuleRevisionPayloadSchema,
  EstablishTaxFactAuthorityContractPayloadSchema,
  ReviseTaxFactAuthorityContractPayloadSchema,
} from '../../shared/actions/tax-governance.ts';
import { TaxGovernanceAuditEvidenceSchema } from '../../shared/domain/tax-governance-errors.ts';
import { handleCorrectTaxRuleRevision } from '../../src/actions/correct-tax-rule-revision.action.ts';
import { handleCreateTaxRuleRevision } from '../../src/actions/create-tax-rule-revision.action.ts';
import { handleCreateTaxRule } from '../../src/actions/create-tax-rule.action.ts';
import { handleEndTaxFactAuthorityContract } from '../../src/actions/end-tax-fact-authority-contract.action.ts';
import { handleEndTaxRuleRevision } from '../../src/actions/end-tax-rule-revision.action.ts';
import { handleEstablishTaxFactAuthorityContract } from '../../src/actions/establish-tax-fact-authority-contract.action.ts';
import { handleReviseTaxFactAuthorityContract } from '../../src/actions/revise-tax-fact-authority-contract.action.ts';
import type { TaxAuthorityGovernancePersistence } from '../../src/services/tax-authority-governance.service.ts';
import type { TaxRuleGovernancePersistence } from '../../src/services/tax-rule-governance.service.ts';

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
const contractRef = ref('commerce.tax.tax-fact-authority-contract', 'contract-1');
const revisionContent = {
  compositionKind: 'EXCLUSIVE',
  effectiveFrom: '2027-01-01T00:00:00.000Z',
  jurisdiction: 'CZ_DOMESTIC',
  ratePercent: '21',
  taxClassificationCode: 'cz-standard-goods',
  treatmentCategory: 'TAXABLE',
};
const authority = {
  authorityFrom: '2027-01-01T00:00:00.000Z',
  evidenceSourceRefs: [],
  systemOfRecordRef: 'party.registry',
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
const authorityServices = (
  overrides: Partial<TaxAuthorityGovernancePersistence>,
): TaxAuthorityGovernancePersistence => ({
  endContract: unused,
  establishContract: unused,
  reviseContract: unused,
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

it.effect('#950 F46-F47 every governed TAX mutation audits its expected-current evidence and resulting state', () =>
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
    const contractOutcome = (revisionId: string) =>
      Effect.succeed({ contractId: 'contract-1', created: true, meaningFingerprint, revisionId, revisionNumber: 1 });
    const contracts = authorityServices({
      endContract: () => contractOutcome('ending-revision'),
      establishContract: () => contractOutcome('initial-contract-revision'),
      reviseContract: () => contractOutcome('revised-contract-revision'),
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
    const established = context(contracts);
    yield* handleEstablishTaxFactAuthorityContract(
      yield* Schema.decodeEffect(EstablishTaxFactAuthorityContractPayloadSchema)({
        ...attribution,
        authority,
        factFamily: 'SELLING_LEGAL_ENTITY_VAT_REGISTRATION',
        stableCode: 'vat-registration',
      }),
      established.value,
    );
    const contractRevised = context(contracts);
    yield* handleReviseTaxFactAuthorityContract(
      yield* Schema.decodeUnknownEffect(ReviseTaxFactAuthorityContractPayloadSchema)({
        ...attribution,
        authority,
        contractRef,
        expectedBasisFingerprint,
      }),
      contractRevised.value,
    );
    const contractEnded = context(contracts);
    yield* handleEndTaxFactAuthorityContract(
      yield* Schema.decodeUnknownEffect(EndTaxFactAuthorityContractPayloadSchema)({
        ...attribution,
        authorityTo: '2028-01-01T00:00:00.000Z',
        contractRef,
        expectedBasisFingerprint,
      }),
      contractEnded.value,
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
    expect(yield* evidence(established)).toEqual({ reason, resultingRevisionId: 'initial-contract-revision' });
    expect(yield* evidence(contractRevised)).toEqual({
      expectedBasisFingerprint,
      reason,
      resultingRevisionId: 'revised-contract-revision',
    });
    expect(yield* evidence(contractEnded)).toEqual({
      expectedBasisFingerprint,
      reason,
      resultingRevisionId: 'ending-revision',
    });
  }),
);
