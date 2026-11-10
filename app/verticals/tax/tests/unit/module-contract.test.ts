import { decideModuleStateAccess } from '@app/core-runtime';
import { getReadPermissionTargetResolver } from '../../../../packages/core-runtime/src/reads/definition.ts';
import { describe, expect, it } from 'effect-rstest';
import { taxApi } from '../../shared/api.ts';
import { getTaxReadiness } from '../../src/api/tax-client.ts';
import {
  FinalizeOrderTaxResultSchema,
  FinalOrderTaxHandoffSchema,
} from '../../shared/actions/order-tax-finalization.ts';
import { correctTaxRuleRevisionAction } from '../../src/actions/correct-tax-rule-revision.action.ts';
import { createTaxRuleAction } from '../../src/actions/create-tax-rule.action.ts';
import { createTaxRuleRevisionAction } from '../../src/actions/create-tax-rule-revision.action.ts';
import { declareSellerVatRegimeAction } from '../../src/actions/declare-seller-vat-regime.action.ts';
import { endTaxRuleRevisionAction } from '../../src/actions/end-tax-rule-revision.action.ts';
import { finalizeOrderTaxAction } from '../../src/actions/finalize-order-tax.action.ts';
import { importSellerVatRegimeDeclarationsAction } from '../../src/actions/import-seller-vat-regime-declarations.action.ts';
import { applicableTaxRuleSetRead } from '../../src/api/applicable-tax-rule-set.read.ts';
import { finalOrderTaxRead } from '../../src/api/final-order-tax.read.ts';
import { taxEvaluationRead } from '../../src/api/tax-evaluation.read.ts';
import { taxManifest } from '../../vertical.manifest.ts';
import { taxRegistration } from '../../vertical.registration.ts';

const taxActionRegistrations = [
  correctTaxRuleRevisionAction,
  createTaxRuleAction,
  createTaxRuleRevisionAction,
  declareSellerVatRegimeAction,
  endTaxRuleRevisionAction,
  finalizeOrderTaxAction,
  importSellerVatRegimeDeclarationsAction,
];

const RISK_ORDER = ['routine', 'sensitive', 'critical'] as const;

/** True when a declaration's risk tier is at least `sensitive` (O19: financial materiality is sensitive). */
const atLeastSensitive = (risk: (typeof RISK_ORDER)[number]): boolean =>
  RISK_ORDER.indexOf(risk) >= RISK_ORDER.indexOf('sensitive');

const governanceActionKeys = [
  'commerce.tax.correct-tax-rule-revision',
  'commerce.tax.create-tax-rule',
  'commerce.tax.create-tax-rule-revision',
  'commerce.tax.declare-seller-vat-regime',
  'commerce.tax.end-tax-rule-revision',
  'commerce.tax.finalize-order-tax',
  'commerce.tax.import-seller-vat-regime-declarations',
];

describe('Tax module contract', () => {
  it('#949 E29 frozen final Order Tax remains readable after TAX deactivation without enabling new evaluation or writes', () => {
    const historical = finalOrderTaxRead.descriptor.entrypoint;
    const prospective = taxEvaluationRead.descriptor.entrypoint;
    const finalization = finalizeOrderTaxAction.descriptor.entrypoint;

    expect(historical.access).toBe('historical_read');
    expect(prospective.access).toBe('read');
    expect(finalization.access).toBe('write');
    for (const state of ['inactive', 'suspended', 'archived'] as const) {
      expect(decideModuleStateAccess(state, historical.access), state).toBe('allow');
      expect(decideModuleStateAccess(state, prospective.access), state).toBe('deny');
      expect(decideModuleStateAccess(state, finalization.access), state).toBe('deny');
    }
  });

  it('#949 E29 historical final Order Tax lookup retains current tenant permission and Selling Legal Entity scope', () => {
    const { descriptor } = finalOrderTaxRead;
    expect(descriptor.entrypoint.scope).toBe('tenant');
    expect(descriptor.entrypoint.moduleKey).toBe('commerce.tax');
    expect(descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
    // The one gate decides the read's own capability (CUTOVER-PLAN §3.2); the retired
    // `context_permission` pair is not the carrier any more (O62).
    expect(descriptor.accessDeclaration).toMatchObject({
      key: 'commerce.tax.order-tax.read',
      kind: 'read',
      selectors: [],
    });
    expect(descriptor.accessActor).toEqual({
      callers: ['commerce-order'],
      reason: expect.any(String),
      subject: 'identity',
    });
    expect(descriptor.legalEntityScope).toBe('required');
    // A protected read carries no legacy permission target and no positional target resolver: the
    // access gate decides its record (O62, CUTOVER-PLAN §4.3).
    expect(Object.keys(descriptor)).not.toContain('permissionTarget');
    expect(getReadPermissionTargetResolver(finalOrderTaxRead)).toBeUndefined();
    expect(descriptor.readKey).toBe('commerce.tax.api.final-order-tax');
    expect(descriptor.evidencePolicy).toEqual({
      captureMode: 'metadata_only',
      policyKey: 'commerce.tax.api.final-order-tax.evidence.v1',
    });
  });

  it('#949 E29 historical final Order Tax lookup remains denied for quarantined or missing module state', () => {
    const { access } = finalOrderTaxRead.descriptor.entrypoint;
    expect(decideModuleStateAccess('quarantined', access)).toBe('deny');
    expect(decideModuleStateAccess(null, access)).toBe('deny');
  });

  it('publishes the headless Tax Rule and Seller VAT Regime Declaration governance surface', () => {
    expect(taxManifest.module.id).toBe('commerce.tax');
    expect(Object.keys(taxManifest.publicSurface.api).toSorted()).toEqual([
      'applicable-tax-rule-set',
      'final-order-tax',
      'import-seller-vat-regime-declarations-action',
      'seller-vat-regime-at-instant',
      'seller-vat-regime-history',
      'tax-correction-preview',
      'tax-evaluation',
      'tax-materiality-comparison',
      'tax-privacy-owner-coverage',
      'tax-rule-history',
    ]);
    expect(taxManifest.publicSurface.actions.map(({ descriptor }) => descriptor.actionKey).toSorted()).toEqual(
      governanceActionKeys,
    );
    expect(taxManifest.publicSurface.resourceTypes.map(({ key }) => key).toSorted()).toEqual([
      'commerce.tax.order-tax-finalization',
      'commerce.tax.seller-vat-regime-declaration',
      'commerce.tax.tax-rule',
      'commerce.tax.tax-rule-revision',
    ]);
    expect((taxManifest.publicSurface.businessPermissions ?? []).map(({ key }) => key).toSorted()).toEqual([
      'tax.evidence.read',
      'tax.governed.read',
      'tax.rule.manage',
    ]);
    expect(taxManifest.publicSurface.shellContributions.navigation).toEqual([]);
    expect(taxManifest.publicSurface.shellContributions.pages).toEqual([]);
    expect(taxRegistration.moduleId).toBe(taxManifest.module.id);
    expect(Object.keys(taxApi.groups)).toContain('foundation');
    expect(getTaxReadiness).toBeDefined();
  });

  it('binds every governance Action to an exact Selling Legal Entity with Core idempotency', () => {
    for (const { descriptor } of taxManifest.publicSurface.actions) {
      expect(descriptor.legalEntityScope, descriptor.actionKey).toBe('required');
      expect(descriptor.idempotency, descriptor.actionKey).toBe('required');
      expect(descriptor.auditProfile, descriptor.actionKey).toBe('sensitive');
    }
  });

  it('#923 #924 #925 F3-F6 F29 offers no Action or read for buyer VAT status; only seller evidence is recordable', () => {
    const surface = [
      ...taxManifest.publicSurface.actions.map(({ descriptor }) => descriptor.actionKey),
      ...Object.keys(taxManifest.publicSurface.api),
    ];
    expect(surface.filter((key) => /buyer|customer|counterparty|b2b|b2c/u.test(key))).toEqual([]);
  });

  it('907-Q08 #964 no external seller route: the Seller VAT Regime enters only through the governed declare and import Actions', () => {
    const actionKeys = taxManifest.publicSurface.actions.map(({ descriptor }) => descriptor.actionKey);
    // The import carries the merchant's existing source declaration; it verifies nothing (907-Q08, Q04).
    expect(actionKeys.filter((actionKey) => /vies|ares|sync|route|assertion|verif/u.test(actionKey))).toEqual([]);
    expect(actionKeys.filter((actionKey) => /seller-vat-regime/u.test(actionKey))).toEqual([
      'commerce.tax.declare-seller-vat-regime',
      'commerce.tax.import-seller-vat-regime-declarations',
    ]);
  });

  it('#961 PO #963 §4-5 the final Order Tax handoff carries no Tax TTL, expiry, renewal or proof', () => {
    const noTtlPattern = /ttl|expir|renew|proof|confirm|valid(?<suffix>Until|To)/iu;
    expect(Object.keys(FinalOrderTaxHandoffSchema.fields).filter((key) => noTtlPattern.test(key))).toEqual([]);
    const finalized = FinalizeOrderTaxResultSchema.members.find((member) => 'handoff' in member.fields);
    expect(finalized).toBeDefined();
    expect(Object.keys(finalized?.fields ?? {}).filter((key) => noTtlPattern.test(key))).toEqual([]);
  });

  it('#963 §6 TAX publishes no Outbox message or domain event, so no delivery debt exists', () => {
    for (const { descriptor } of taxActionRegistrations) {
      expect(Object.keys(descriptor.domainEvents), descriptor.actionKey).toEqual([]);
    }
    expect(taxManifest.publicSurface.events).toEqual([]);
  });

  it('offers no generic edit Action for derived or historical Tax meaning (#949 F33-F42)', () => {
    const forbidden = /classification|participant|vat-registration|decision|result|accepted-tax-terms/u;
    expect(
      taxManifest.publicSurface.actions
        .map(({ descriptor }) => descriptor.actionKey)
        .filter((actionKey) => forbidden.test(actionKey)),
    ).toEqual([]);
  });

  it('#944 finalizes Order Tax through explicit Action provisioning, without a Core business Permission scope', () => {
    const finalize = taxManifest.publicSurface.actions.find(
      ({ descriptor }) => descriptor.actionKey === 'commerce.tax.finalize-order-tax',
    );
    expect(Object.keys(finalize?.descriptor ?? {})).not.toContain('ownerPermissions');
    expect(finalize?.descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
    expect(finalize?.descriptor.accessDeclaration).toMatchObject({
      key: 'commerce.tax.order-tax.finalize',
      kind: 'action',
      selectors: [],
    });
    expect(finalize?.descriptor.accessActor).toEqual({
      callers: ['commerce-order'],
      reason: expect.any(String),
      subject: 'identity',
    });
    expect(finalize?.descriptor.legalEntityScope).toBe('required');
  });

  it('907-Q08 #960 imports Seller VAT Regime declarations through explicit Action provisioning, one Selling Legal Entity per call', () => {
    const importAction = taxManifest.publicSurface.actions.find(
      ({ descriptor }) => descriptor.actionKey === 'commerce.tax.import-seller-vat-regime-declarations',
    );
    expect(Object.keys(importAction?.descriptor ?? {})).not.toContain('ownerPermissions');
    expect(importAction?.descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
    expect(importAction?.descriptor.accessDeclaration).toMatchObject({
      key: 'commerce.tax.seller-vat-regime-declaration.import',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      risk: 'critical',
      selectors: [],
    });
    expect(importAction?.descriptor.accessWorkload?.workloads).toEqual([
      'commerce.tax.symmy-seller-vat-fixture-import',
    ]);
    expect(taxManifest.publicSurface.operationContracts).toEqual([
      {
        apiKey: 'import-seller-vat-regime-declarations-action',
        operationKey: 'importSellerVatRegimeDeclarationsAction.execute',
        registration: importSellerVatRegimeDeclarationsAction,
      },
    ]);
    expect(importAction?.descriptor.legalEntityScope).toBe('required');
    expect(importAction?.descriptor.idempotency).toBe('required');
  });

  it('#949/#950 declares the Seller VAT Regime through explicit Action provisioning, without a Core business Permission scope', () => {
    const declare = taxManifest.publicSurface.actions.find(
      ({ descriptor }) => descriptor.actionKey === 'commerce.tax.declare-seller-vat-regime',
    );
    expect(Object.keys(declare?.descriptor ?? {})).not.toContain('ownerPermissions');
    expect(declare?.descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
    expect(declare?.descriptor.accessDeclaration).toMatchObject({
      key: 'commerce.tax.seller-vat-regime-declaration.declare',
      kind: 'action',
      selectors: [],
    });
    expect(declare?.descriptor.legalEntityScope).toBe('required');
  });

  it('a published Tax rate is financial materiality, so the applicable rule-set read is at least sensitive (O21)', () => {
    // The read answers each applicable revision's `ratePercent`: a published Tax rate states a money
    // outcome, which O21 classifies as financial materiality. A routine classification would let an
    // agent run the read (O45) and would keep the exposure out of the catalog's sensitive surface.
    const { accessDeclaration } = applicableTaxRuleSetRead.descriptor;
    expect(accessDeclaration).toMatchObject({ key: 'commerce.tax.tax-rule-set.read', kind: 'read', selectors: [] });
    expect(atLeastSensitive(accessDeclaration?.risk ?? 'routine')).toBe(true);
    // Negative control: the very predicate refuses the `routine` classification this read carried
    // before the O21 alignment, so the assertion above cannot pass vacuously.
    expect(atLeastSensitive('routine')).toBe(false);
  });
});
