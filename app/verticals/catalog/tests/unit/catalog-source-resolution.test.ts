import { describe, expect, it } from 'effect-rstest';

import {
  assessCatalogSourceAssertion,
  assessCatalogSourceAssertions,
  resolveCatalogSourceFact,
} from '../../src/domain/catalog-source-resolution.ts';
import type { CatalogLocalOverride } from '../../src/domain/catalog-source-resolution.ts';

const scope = { factKey: 'height', targetId: 'product-1', targetKind: 'PRODUCT', tenantId: 'tenant-1' } as const;
const at = new Date('2026-09-18T12:00:00.000Z');
const authority = { issuerSystemId: 'source-1', scope, status: 'VERIFIED' } as const;
const admission = {
  assertionAdmission: 'EXTERNAL_SOURCE',
  factOwnership: 'CATALOG_LOCAL',
  overridePermitted: true,
  overrideValueValid: true,
} as const;
const valuesEqual = (left: string, right: string): boolean => left === right;
const base80 = {
  assertionId: 'assertion-r1',
  effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
  evidencedAt: new Date('2026-09-02T00:00:00.000Z'),
  issuerSystemId: 'source-1',
  scope,
  sourceRecordId: 'record-1',
  sourceRevision: 1n,
  value: '80 cm',
  valueFingerprint: 'height:80cm',
};
const base95 = {
  ...base80,
  assertionId: 'assertion-r2',
  sourceRevision: 2n,
  value: '95 cm',
  valueFingerprint: 'height:95cm',
};
const override90: CatalogLocalOverride<string> = {
  actorPrincipalId: 'principal-1',
  evidenceRef: 'evidence-1',
  lifecycle: 'ACTIVE',
  reason: 'Measured correction',
  revision: 1n,
  scope,
  value: '90 cm',
};

describe('Catalog source authority and Local Override resolution', () => {
  it('accepts a newer base beneath an active override, then release reveals the latest accepted base', () => {
    expect(
      resolveCatalogSourceFact({ acceptedBases: [base80], admission, at, overrides: [override90], scope, valuesEqual }),
    ).toEqual({ source: 'LOCAL_OVERRIDE', status: 'CURRENT', value: '90 cm' });
    const accepted = assessCatalogSourceAssertion({
      activeOverride: override90,
      admission,
      assertion: base95,
      at,
      authority,
      currentBase: base80,
      targetVerified: true,
      valuesEqual,
      valueValid: true,
    });
    expect(accepted).toEqual({ base: base95, currentChanged: false, status: 'ACCEPTED' });
    expect(
      resolveCatalogSourceFact({
        acceptedBases: [base80, base95],
        admission,
        at,
        overrides: [{ ...override90, lifecycle: 'RELEASED' }],
        scope,
        valuesEqual,
      }),
    ).toEqual({ source: 'BASE', status: 'CURRENT', value: '95 cm' });
  });

  it('returns duplicate and stale without replacing the accepted base', () => {
    const common = {
      activeOverride: null,
      admission,
      at,
      authority,
      currentBase: base95,
      targetVerified: true,
      valuesEqual,
      valueValid: true,
    };
    expect(assessCatalogSourceAssertion({ ...common, assertion: base95 }).status).toBe('DUPLICATE');
    expect(assessCatalogSourceAssertion({ ...common, assertion: base80 }).status).toBe('STALE');
    expect(
      assessCatalogSourceAssertion({ ...common, assertion: { ...base95, valueFingerprint: 'different' } }).status,
    ).toBe('INDETERMINATE');
  });

  it('fails closed for wrong Tenant, unverified target or authority, and incomparable source records', () => {
    const common = {
      activeOverride: null,
      admission,
      at,
      currentBase: base80,
      targetVerified: true,
      valuesEqual,
      valueValid: true,
    };
    expect(assessCatalogSourceAssertion({ ...common, assertion: base95, authority: null }).status).toBe('NO_AUTHORITY');
    expect(
      assessCatalogSourceAssertion({ ...common, assertion: base95, authority, targetVerified: false }).status,
    ).toBe('INDETERMINATE');
    expect(
      assessCatalogSourceAssertion({
        ...common,
        assertion: { ...base95, scope: { ...scope, tenantId: 'other' } },
        authority,
      }).status,
    ).toBe('NO_AUTHORITY');
    expect(
      assessCatalogSourceAssertion({ ...common, assertion: { ...base95, sourceRecordId: 'other' }, authority }).status,
    ).toBe('INDETERMINATE');
    expect(
      assessCatalogSourceAssertion({ ...common, assertion: { ...base95, issuerSystemId: 'other' }, authority }).status,
    ).toBe('NO_AUTHORITY');
  });

  it('does not treat arrival time or a released override as a Current value', () => {
    const deliveredLater = { ...base80, evidencedAt: new Date('2026-09-18T11:00:00.000Z') };
    expect(
      assessCatalogSourceAssertion({
        activeOverride: null,
        admission,
        assertion: deliveredLater,
        at,
        authority,
        currentBase: base95,
        targetVerified: true,
        valuesEqual,
        valueValid: true,
      }).status,
    ).toBe('STALE');
    expect(
      resolveCatalogSourceFact({
        acceptedBases: [],
        admission,
        at,
        overrides: [{ ...override90, lifecycle: 'RELEASED' }],
        scope,
        valuesEqual,
      }).status,
    ).toBe('ABSENT');
    expect(
      resolveCatalogSourceFact({
        acceptedBases: [base95],
        admission,
        at,
        overrides: [override90, { ...override90, value: '85 cm' }],
        scope,
        valuesEqual,
      }).status,
    ).toBe('INDETERMINATE');
  });

  it('does not accept invalid, expired, or unverifiable assertion values', () => {
    const common = { activeOverride: null, admission, at, authority, currentBase: null, targetVerified: true };
    expect(assessCatalogSourceAssertion({ ...common, assertion: base80, valuesEqual, valueValid: false }).status).toBe(
      'INVALID',
    );
    expect(
      assessCatalogSourceAssertion({
        ...common,
        assertion: { ...base80, effectiveTo: at },
        valuesEqual,
        valueValid: true,
      }).status,
    ).toBe('INVALID');
    expect(
      assessCatalogSourceAssertion({
        ...common,
        assertion: { ...base80, sourceRevision: -1n },
        valuesEqual,
        valueValid: true,
      }).status,
    ).toBe('INVALID');
  });

  it('D1 rejects a foreign, unknown, unpermitted, or value-invalid Local Override', () => {
    const common = { acceptedBases: [base80], at, overrides: [override90], scope, valuesEqual };
    expect(
      resolveCatalogSourceFact({ ...common, admission: { ...admission, factOwnership: 'EXTERNAL_SOURCE' } }).status,
    ).toBe('NO_AUTHORITY');
    expect(resolveCatalogSourceFact({ ...common, admission: { ...admission, factOwnership: 'UNKNOWN' } }).status).toBe(
      'NO_AUTHORITY',
    );
    expect(resolveCatalogSourceFact({ ...common, admission: { ...admission, overridePermitted: false } }).status).toBe(
      'NO_AUTHORITY',
    );
    expect(resolveCatalogSourceFact({ ...common, admission: { ...admission, overrideValueValid: false } }).status).toBe(
      'INVALID',
    );
    expect(resolveCatalogSourceFact({ ...common, admission: null }).status).toBe('INDETERMINATE');
    expect(
      resolveCatalogSourceFact({
        acceptedBases: [base80],
        admission,
        at,
        overrides: [{ ...override90, scope: { ...scope, factKey: 'width' } }],
        scope,
        valuesEqual,
      }),
    ).toEqual({ source: 'BASE', status: 'CURRENT', value: '80 cm' });
  });

  it('D2 returns a typed failure for an invalid Date instead of throwing', () => {
    const invalid = new Date('not-a-date');
    expect(
      assessCatalogSourceAssertion({
        activeOverride: null,
        admission,
        assertion: base80,
        at: invalid,
        authority,
        currentBase: null,
        targetVerified: true,
        valuesEqual,
        valueValid: true,
      }).status,
    ).toBe('INVALID');
    expect(
      assessCatalogSourceAssertion({
        activeOverride: null,
        admission,
        assertion: { ...base80, effectiveFrom: invalid },
        at,
        authority,
        currentBase: null,
        targetVerified: true,
        valuesEqual,
        valueValid: true,
      }).status,
    ).toBe('INVALID');
    expect(
      resolveCatalogSourceFact({ acceptedBases: [base80], admission, at: invalid, overrides: [], scope, valuesEqual })
        .status,
    ).toBe('INVALID');
  });

  it('D3 retains a future-effective accepted base and uses it inside its valid window', () => {
    const future = {
      ...base80,
      assertionId: 'assertion-r-future',
      effectiveFrom: new Date('2026-10-01T00:00:00.000Z'),
      sourceRevision: 2n,
      value: '95 cm',
      valueFingerprint: 'height:95cm',
    };
    expect(
      assessCatalogSourceAssertion({
        activeOverride: null,
        admission,
        assertion: future,
        at,
        authority,
        currentBase: base80,
        targetVerified: true,
        valuesEqual,
        valueValid: true,
      }),
    ).toEqual({ base: future, currentChanged: false, status: 'ACCEPTED' });
    expect(
      resolveCatalogSourceFact({
        acceptedBases: [base80, future],
        admission,
        at,
        overrides: [],
        scope,
        valuesEqual,
      }),
    ).toEqual({ source: 'BASE', status: 'CURRENT', value: '80 cm' });
    expect(
      resolveCatalogSourceFact({
        acceptedBases: [base80, future],
        admission,
        at: new Date('2026-10-02T00:00:00.000Z'),
        overrides: [],
        scope,
        valuesEqual,
      }),
    ).toEqual({ source: 'BASE', status: 'CURRENT', value: '95 cm' });
  });

  it('D4 requires qualified nonempty Tenant, source, fact, and override identities', () => {
    const common = {
      activeOverride: null,
      admission,
      at,
      authority,
      currentBase: null,
      targetVerified: true,
      valuesEqual,
      valueValid: true,
    };
    expect(
      assessCatalogSourceAssertion({ ...common, assertion: { ...base80, scope: { ...scope, tenantId: '' } } }).status,
    ).toBe('NO_AUTHORITY');
    expect(
      assessCatalogSourceAssertion({ ...common, assertion: { ...base80, scope: { ...scope, factKey: '' } } }).status,
    ).toBe('NO_AUTHORITY');
    expect(
      assessCatalogSourceAssertion({
        ...common,
        assertion: { ...base80, issuerSystemId: '' },
        authority: { ...authority, issuerSystemId: '' },
      }).status,
    ).toBe('NO_AUTHORITY');
    expect(assessCatalogSourceAssertion({ ...common, assertion: { ...base80, sourceRecordId: '  ' } }).status).toBe(
      'INVALID',
    );
    expect(
      resolveCatalogSourceFact({
        acceptedBases: [base80],
        admission,
        at,
        overrides: [{ ...override90, actorPrincipalId: '' }],
        scope,
        valuesEqual,
      }).status,
    ).toBe('INVALID');
    expect(
      resolveCatalogSourceFact({
        acceptedBases: [base80],
        admission,
        at,
        overrides: [],
        scope: { ...scope, tenantId: '' },
        valuesEqual,
      }).status,
    ).toBe('INVALID');
  });

  it('D5 compares the actual value instead of trusting the caller fingerprint', () => {
    expect(
      assessCatalogSourceAssertion({
        activeOverride: null,
        admission,
        assertion: { ...base95, value: '200 cm' },
        at,
        authority,
        currentBase: base95,
        targetVerified: true,
        valuesEqual,
        valueValid: true,
      }).status,
    ).toBe('INDETERMINATE');
    expect(
      assessCatalogSourceAssertion({
        activeOverride: null,
        admission,
        assertion: base95,
        at,
        authority,
        currentBase: base95,
        targetVerified: true,
        valuesEqual,
        valueValid: true,
      }).status,
    ).toBe('DUPLICATE');
  });

  it('D6 lets the newest override revision decide over an older ACTIVE revision', () => {
    expect(
      resolveCatalogSourceFact({
        acceptedBases: [base80],
        admission,
        at,
        overrides: [override90, { ...override90, lifecycle: 'RELEASED', revision: 2n }],
        scope,
        valuesEqual,
      }),
    ).toEqual({ source: 'BASE', status: 'CURRENT', value: '80 cm' });
    expect(
      resolveCatalogSourceFact({
        acceptedBases: [base80],
        admission,
        at,
        overrides: [override90, { ...override90, revision: 2n, value: '85 cm' }],
        scope,
        valuesEqual,
      }),
    ).toEqual({ source: 'LOCAL_OVERRIDE', status: 'CURRENT', value: '85 cm' });
  });

  it('returns one typed result per import item so a batch cannot hide partial rejection', () => {
    const results = assessCatalogSourceAssertions({
      activeOverride: null,
      admission,
      at,
      currentBase: base80,
      items: [
        { assertion: base95, authority, targetVerified: true, valueValid: true },
        { assertion: base80, authority, targetVerified: true, valueValid: true },
        { assertion: base95, authority, targetVerified: true, valueValid: false },
      ],
      valuesEqual,
    });
    expect(results.map((result) => result.status)).toEqual(['ACCEPTED', 'DUPLICATE', 'INVALID']);
  });

  it('resolves release to the newest usable base and declares absence or conflict otherwise', () => {
    const released: CatalogLocalOverride<string>[] = [{ ...override90, lifecycle: 'RELEASED' }];
    expect(
      resolveCatalogSourceFact({
        acceptedBases: [base80, base95],
        admission,
        at,
        overrides: released,
        scope,
        valuesEqual,
      }),
    ).toEqual({ source: 'BASE', status: 'CURRENT', value: '95 cm' });
    expect(
      resolveCatalogSourceFact({ acceptedBases: [], admission, at, overrides: released, scope, valuesEqual }).status,
    ).toBe('ABSENT');
    expect(
      resolveCatalogSourceFact({
        acceptedBases: [base95, { ...base80, issuerSystemId: 'source-2', sourceRecordId: 'record-2' }],
        admission,
        at,
        overrides: released,
        scope,
        valuesEqual,
      }).status,
    ).toBe('INDETERMINATE');
    expect(
      resolveCatalogSourceFact({
        acceptedBases: [base95, { ...base95, assertionId: 'assertion-r2b', value: '96 cm' }],
        admission,
        at,
        overrides: released,
        scope,
        valuesEqual,
      }).status,
    ).toBe('INDETERMINATE');
  });
});
