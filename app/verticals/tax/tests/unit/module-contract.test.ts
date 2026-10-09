import { describe, expect, it } from 'effect-rstest';
import { taxApi } from '../../shared/api.ts';
import { getTaxReadiness } from '../../src/api/tax-client.ts';
import { taxManifest } from '../../vertical.manifest.ts';
import { taxRegistration } from '../../vertical.registration.ts';

const governanceActionKeys = [
  'commerce.tax.correct-tax-rule-revision',
  'commerce.tax.create-tax-rule',
  'commerce.tax.create-tax-rule-revision',
  'commerce.tax.declare-seller-vat-regime',
  'commerce.tax.end-tax-rule-revision',
  'commerce.tax.finalize-order-tax',
];

describe('Tax module contract', () => {
  it('publishes the headless Tax Rule and Seller VAT Regime Declaration governance surface', () => {
    expect(taxManifest.module.id).toBe('commerce.tax');
    expect(Object.keys(taxManifest.publicSurface.api).toSorted()).toEqual([
      'applicable-tax-rule-set',
      'final-order-tax',
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

  it('#958 F21-F22 #893 evidence enters only through the governed declare Action, never an Integration Route', () => {
    const actionKeys = taxManifest.publicSurface.actions.map(({ descriptor }) => descriptor.actionKey);
    expect(actionKeys.filter((actionKey) => /vies|ares|import|sync|route|assertion/u.test(actionKey))).toEqual([]);
    expect(actionKeys.filter((actionKey) => /seller-vat-regime/u.test(actionKey))).toEqual([
      'commerce.tax.declare-seller-vat-regime',
    ]);
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
    expect(Object.keys(finalize?.descriptor ?? {})).not.toContain('businessPermission');
    expect(finalize?.descriptor.entrypoint.authorization).toEqual({
      kind: 'action_execution',
      provisioning: 'explicit',
    });
    expect(finalize?.descriptor.legalEntityScope).toBe('required');
  });

  it('#949/#950 declares the Seller VAT Regime through explicit Action provisioning, without a Core business Permission scope', () => {
    const declare = taxManifest.publicSurface.actions.find(
      ({ descriptor }) => descriptor.actionKey === 'commerce.tax.declare-seller-vat-regime',
    );
    expect(Object.keys(declare?.descriptor ?? {})).not.toContain('businessPermission');
    expect(declare?.descriptor.entrypoint.authorization).toEqual({
      kind: 'action_execution',
      provisioning: 'explicit',
    });
    expect(declare?.descriptor.legalEntityScope).toBe('required');
  });
});
