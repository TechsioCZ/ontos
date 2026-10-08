import { describe, expect, it } from 'effect-rstest';
import { taxApi } from '../../shared/api.ts';
import { getTaxReadiness } from '../../src/api/tax-client.ts';
import { taxManifest } from '../../vertical.manifest.ts';
import { taxRegistration } from '../../vertical.registration.ts';

const governanceActionKeys = [
  'commerce.tax.correct-tax-rule-revision',
  'commerce.tax.create-tax-rule',
  'commerce.tax.create-tax-rule-revision',
  'commerce.tax.end-tax-fact-authority-contract',
  'commerce.tax.end-tax-rule-revision',
  'commerce.tax.establish-tax-fact-authority-contract',
  'commerce.tax.revise-tax-fact-authority-contract',
];

describe('Tax module contract', () => {
  it('publishes the headless Tax Rule and Tax Fact Authority governance surface', () => {
    expect(taxManifest.module.id).toBe('commerce.tax');
    expect(Object.keys(taxManifest.publicSurface.api).toSorted()).toEqual([
      'applicable-tax-rule-set',
      'tax-fact-authority-current',
      'tax-rule-history',
    ]);
    expect(taxManifest.publicSurface.actions.map(({ descriptor }) => descriptor.actionKey).toSorted()).toEqual(
      governanceActionKeys,
    );
    expect(taxManifest.publicSurface.resourceTypes.map(({ key }) => key).toSorted()).toEqual([
      'commerce.tax.tax-fact-authority-contract',
      'commerce.tax.tax-rule',
      'commerce.tax.tax-rule-revision',
    ]);
    expect((taxManifest.publicSurface.businessPermissions ?? []).map(({ key }) => key).toSorted()).toEqual([
      'tax.authority_contract.manage',
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

  it('offers no generic edit Action for derived or historical Tax meaning (#949 F33-F42)', () => {
    const forbidden = /classification|participant|vat-registration|decision|result|accepted-tax-terms/u;
    expect(
      taxManifest.publicSurface.actions
        .map(({ descriptor }) => descriptor.actionKey)
        .filter((actionKey) => forbidden.test(actionKey)),
    ).toEqual([]);
  });
});
