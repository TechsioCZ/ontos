import { toBusinessPermissionAccessObjectId } from '@app/core-runtime';
import type { BusinessPermissionAccessTarget, OperationalScope } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { getActionBusinessPermissionTargetResolver } from '../../../../packages/core-runtime/src/actions/definition.ts';

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

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const sellerA = '30000000-0000-4000-8000-000000000001';
const sellerB = '30000000-0000-4000-8000-000000000002';
const scopeFor = (legalEntityId: string) =>
  ({
    authContextRef: 'better-auth-session:tax-governance-permissions',
    authMethod: 'session',
    correlationId: 'tax-governance-permissions',
    legalEntityId,
    principalId,
    tenantId,
  }) satisfies OperationalScope;

const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.tax',
  resourceId,
  resourceType,
  tenantId,
});
const expectedBasisFingerprint = 'a'.repeat(64);
// Both sellers operate in Czech jurisdiction; the jurisdiction must never become the authorization target.
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

type ResolveFor = (scope: OperationalScope) => BusinessPermissionAccessTarget | undefined;

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
  return {
    [correctTaxRuleRevisionAction.descriptor.actionKey]: (scope) =>
      getActionBusinessPermissionTargetResolver(correctTaxRuleRevisionAction)?.(correctRevision, scope),
    [createTaxRuleAction.descriptor.actionKey]: (scope) =>
      getActionBusinessPermissionTargetResolver(createTaxRuleAction)?.(createRule, scope),
    [createTaxRuleRevisionAction.descriptor.actionKey]: (scope) =>
      getActionBusinessPermissionTargetResolver(createTaxRuleRevisionAction)?.(createRevision, scope),
    [endTaxRuleRevisionAction.descriptor.actionKey]: (scope) =>
      getActionBusinessPermissionTargetResolver(endTaxRuleRevisionAction)?.(endRevision, scope),
  } satisfies Record<string, ResolveFor>;
});

/** Core's exact SpiceDB object identity: a grant admits only the identical permission, Tenant and seller. */
const grantedTo = (grants: readonly BusinessPermissionAccessTarget[]) => {
  const objectIds = new Set(grants.map((grant) => toBusinessPermissionAccessObjectId(grant.permission, grant.target)));
  return (resolved: BusinessPermissionAccessTarget | undefined): boolean =>
    resolved !== undefined && objectIds.has(toBusinessPermissionAccessObjectId(resolved.permission, resolved.target));
};

it('#950 F14-F15 declares the Tax Rule management permission on the exact Selling Legal Entity scope', () => {
  expect(taxRuleManagePermission.allowedScopeKinds).toEqual(['tax_selling_legal_entity']);
  expect(taxRuleManagePermission.protectedEntrypoints.toSorted()).toEqual(
    [correctTaxRuleRevisionAction, createTaxRuleAction, createTaxRuleRevisionAction, endTaxRuleRevisionAction]
      .map((action) => action.descriptor.entrypoint.entrypointKey)
      .toSorted(),
  );
});

it.effect('#950 BDD Principal manages one seller scope: permission for A never admits a Tax Rule Action for B', () =>
  Effect.gen(function* principalManagesOneSeller() {
    const rule = yield* governedActions;
    const sellerARuleManager = grantedTo([
      {
        permission: 'tax.rule.manage',
        target: { kind: 'tax_selling_legal_entity', legalEntityId: sellerA, tenantId },
      },
    ]);
    for (const resolveFor of Object.values(rule)) {
      expect(resolveFor(scopeFor(sellerA))).toEqual({
        permission: 'tax.rule.manage',
        target: { kind: 'tax_selling_legal_entity', legalEntityId: sellerA, tenantId },
      });
      expect(sellerARuleManager(resolveFor(scopeFor(sellerA)))).toBe(true);
      expect(resolveFor(scopeFor(sellerB))?.target).toEqual({
        kind: 'tax_selling_legal_entity',
        legalEntityId: sellerB,
        tenantId,
      });
      expect(sellerARuleManager(resolveFor(scopeFor(sellerB)))).toBe(false);
    }
  }),
);

it.effect('#950 BDD Czech jurisdiction is not global administrator scope', () =>
  Effect.gen(function* czechJurisdictionIsNotScope() {
    const rule = yield* governedActions;
    const sellerAManager = grantedTo([
      {
        permission: 'tax.rule.manage',
        target: { kind: 'tax_selling_legal_entity', legalEntityId: sellerA, tenantId },
      },
    ]);
    for (const resolveFor of Object.values(rule)) {
      const otherCzechSeller = resolveFor(scopeFor(sellerB));
      expect(Object.keys(otherCzechSeller?.target ?? {}).toSorted()).toEqual(['kind', 'legalEntityId', 'tenantId']);
      expect(sellerAManager(otherCzechSeller)).toBe(false);
    }
  }),
);

it('#907 Unit 10 declaring a Seller VAT Regime has no business Permission target (explicit Action provisioning instead)', () => {
  expect(getActionBusinessPermissionTargetResolver(declareSellerVatRegimeAction)).toBeUndefined();
  expect(declareSellerVatRegimeAction.descriptor.entrypoint.authorization).toEqual({
    kind: 'action_execution',
    provisioning: 'explicit',
  });
});
