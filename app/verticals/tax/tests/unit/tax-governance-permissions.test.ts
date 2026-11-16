import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { getActionOwnerPermissionTargetResolver } from '../../../../packages/core-runtime/src/actions/definition.ts';

import {
  CorrectTaxRuleRevisionPayloadSchema,
  CreateTaxRulePayloadSchema,
  CreateTaxRuleRevisionPayloadSchema,
  EndTaxRuleRevisionPayloadSchema,
} from '../../shared/actions/tax-governance.ts';
import { taxRuleManagePermission } from '../../shared/permissions/tax-rule-manage.ts';
import { correctTaxRuleRevisionAction } from '../../src/actions/correct-tax-rule-revision.action.ts';
import { createTaxRuleRevisionAction } from '../../src/actions/create-tax-rule-revision.action.ts';
import { createTaxRuleAction } from '../../src/actions/create-tax-rule.action.ts';
import { declareSellerVatRegimeAction } from '../../src/actions/declare-seller-vat-regime.action.ts';
import { endTaxRuleRevisionAction } from '../../src/actions/end-tax-rule-revision.action.ts';
import { importSellerVatRegimeDeclarationsAction } from '../../src/actions/import-seller-vat-regime-declarations.action.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';

const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.tax',
  resourceId,
  resourceType,
  tenantId,
});
const expectedBasisFingerprint = 'a'.repeat(64);
// The payload's Czech jurisdiction must never become the authorization target.
const czechRevision = {
  compositionKind: 'EXCLUSIVE',
  effectiveFrom: '2027-01-01T00:00:00.000Z',
  jurisdiction: 'CZ_DOMESTIC',
  ratePercent: '21',
  taxClassificationCode: 'cz-standard-goods',
  treatmentCategory: 'TAXABLE',
};
const attribution = { provenanceRef: 'test:tax-governance-permissions', reason: 'Governed tax change' };
const ruleRevisionRef = ref('commerce.tax.tax-rule-revision', 'revision-1');

/**
 * The governed Tax Rule Actions. v2 replaced the per-seller business Permission target with the
 * Action's own scope-wide capability decided in the Selling Legal Entity's access scope (O7,
 * O67-Q2), so these suites read the declaration and the payload each Action still decodes.
 */
const governedActions = Effect.gen(function* decodeGovernedActions() {
  const createRule = yield* Schema.decodeUnknownEffect(CreateTaxRulePayloadSchema)({
    ...attribution,
    initialRevision: czechRevision,
    meaningKind: 'VAT_RATE',
    stableCode: 'cz.standard',
  });
  const createRevision = yield* Schema.decodeUnknownEffect(CreateTaxRuleRevisionPayloadSchema)({
    ...attribution,
    content: czechRevision,
    expectedBasisFingerprint,
    taxRuleRef: ref('commerce.tax.tax-rule', 'rule-1'),
  });
  const correctRevision = yield* Schema.decodeUnknownEffect(CorrectTaxRuleRevisionPayloadSchema)({
    ...attribution,
    confirmedAt: '2026-02-01T00:00:00.000Z',
    correctingContent: czechRevision,
    expectedBasisFingerprint,
    wrongRevisionRef: ruleRevisionRef,
  });
  const endRevision = yield* Schema.decodeUnknownEffect(EndTaxRuleRevisionPayloadSchema)({
    ...attribution,
    endedEffectiveTo: '2028-01-01T00:00:00.000Z',
    expectedBasisFingerprint,
    taxRuleRevisionRef: ruleRevisionRef,
  });
  return [
    { action: correctTaxRuleRevisionAction, payload: correctRevision },
    { action: createTaxRuleAction, payload: createRule },
    { action: createTaxRuleRevisionAction, payload: createRevision },
    { action: endTaxRuleRevisionAction, payload: endRevision },
  ] as const;
});

it('#950 F14-F15 declares the Tax Rule management permission on the exact Selling Legal Entity scope', () => {
  expect(taxRuleManagePermission.allowedScopeKinds).toEqual(['tax_selling_legal_entity']);
  expect(taxRuleManagePermission.protectedEntrypoints.toSorted()).toEqual(
    [correctTaxRuleRevisionAction, createTaxRuleAction, createTaxRuleRevisionAction, endTaxRuleRevisionAction]
      .map((action) => action.descriptor.entrypoint.entrypointKey)
      .toSorted(),
  );
});

it.effect('#950 BDD a Selling Legal Entity capability is the Action scope: no per-record business target', () =>
  Effect.gen(function* principalManagesOneSeller() {
    const governed = [
      correctTaxRuleRevisionAction,
      createTaxRuleAction,
      createTaxRuleRevisionAction,
      endTaxRuleRevisionAction,
    ];
    for (const action of governed) {
      // The capability is decided in the selected seller's access scope and nowhere else (O7).
      expect(action.descriptor.legalEntityScope).toBe('required');
      expect(action.descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
      expect(action.descriptor.accessDeclaration?.selectors).toEqual([]);
      // The retired per-seller business target is removed from the descriptor.
      expect(Object.keys(action.descriptor)).not.toContain('ownerPermissions');
    }
    expect(governed.map((action) => action.descriptor.accessDeclaration?.key)).toEqual([
      'commerce.tax.tax-rule-revision.correct',
      'commerce.tax.tax-rule.create',
      'commerce.tax.tax-rule-revision.create',
      'commerce.tax.tax-rule-revision.end',
    ]);
    // The seller never comes from the payload: one payload decodes for any selected seller.
    const payloads = yield* governedActions;
    expect(payloads).toHaveLength(4);
  }),
);

it('#907 Unit 10 declaring a Seller VAT Regime carries its own capability instead of an owner Permission target', () => {
  expect(getActionOwnerPermissionTargetResolver(declareSellerVatRegimeAction)).toBeUndefined();
  expect(declareSellerVatRegimeAction.descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
  expect(declareSellerVatRegimeAction.descriptor.accessDeclaration).toMatchObject({
    key: 'commerce.tax.seller-vat-regime-declaration.declare',
    kind: 'action',
    selectors: [],
  });
});

it('907-Q08 #960 importing Seller VAT Regime declarations carries its own capability instead of an owner Permission target', () => {
  expect(getActionOwnerPermissionTargetResolver(importSellerVatRegimeDeclarationsAction)).toBeUndefined();
  expect(importSellerVatRegimeDeclarationsAction.descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
  expect(importSellerVatRegimeDeclarationsAction.descriptor.accessDeclaration).toMatchObject({
    key: 'commerce.tax.seller-vat-regime-declaration.import',
    kind: 'action',
    selectors: [],
  });
});

it('freezes every published owner descriptor including canonical capability and dormant entrypoints', () => {
  expect([taxRuleManagePermission]).toEqual([
    {
      allowedScopeKinds: ['tax_selling_legal_entity'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: false,
      internalGrantable: false,
      key: 'tax.rule.manage',
      meaning: 'Tax Rule Manage business permission.',
      owningCapability: 'commerce.tax',
      protectedEntrypoints: [
        'commerce.tax.create-tax-rule',
        'commerce.tax.create-tax-rule-revision',
        'commerce.tax.correct-tax-rule-revision',
        'commerce.tax.end-tax-rule-revision',
      ],
      schemaVersion: '1',
    },
  ]);
});
