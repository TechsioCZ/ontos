import { describe, expect, it } from 'effect-rstest';
import { Effect, Match, Schema } from 'effect';

import {
  assessCurrentPackageOptionSnapshot,
  assessSkuLookupSnapshot,
  currentPackageOptionSnapshotMatches,
  SkuPersistenceUnavailable,
  skuPersistenceForScope,
  validSkuChangeInput,
} from '../../src/persistence/sku-persistence.ts';

const base = {
  actionInvocationId: '00000000-0000-4000-8000-000000000001',
  code: '  Ab-12  ',
  evidenceRefs: ['source:1'],
  expectedRevision: 0,
  principalId: '00000000-0000-4000-8000-000000000002',
  reason: 'Verified against source',
  target: { kind: 'VARIANT', tenantId: 'tenant-a', variantId: '00000000-0000-4000-8000-000000000003' },
} as const;

const invalidReason = (snapshot: Parameters<typeof assessCurrentPackageOptionSnapshot>[0]) =>
  Match.value(assessCurrentPackageOptionSnapshot(snapshot)).pipe(
    Match.tag('INVALID_CURRENT', ({ reason }) => reason),
    Match.orElse(() => null),
  );

const emptyAuthoritativeSelect = () => {
  const query = {
    for: () => query,
    from: () => query,
    limit: () => Effect.succeed([]),
    where: () => query,
  };
  return query;
};

const persistenceWithEmptyAuthoritativeLookup = () =>
  // @ts-expect-error This focused mock implements the authoritative empty-select path only.
  skuPersistenceForScope({ select: emptyAuthoritativeSelect }, { tenantId: 'tenant-a' });

describe('SKU persistence input guard', () => {
  it('accepts a tenant-scoped Variant and preserves display spelling', () => {
    expect(validSkuChangeInput(base, 'tenant-a')).toBe(true);
    expect(base.code).toBe('  Ab-12  ');
  });

  it('accepts only an exact Package Option in the same Tenant', () => {
    const option = {
      ...base,
      target: {
        kind: 'PACKAGE_OPTION' as const,
        packageDefinitionId: '00000000-0000-4000-8000-000000000004',
        tenantId: 'tenant-a',
      },
    };
    expect(validSkuChangeInput(option, 'tenant-a')).toBe(true);
    expect(validSkuChangeInput(option, 'tenant-b')).toBe(false);
    expect(validSkuChangeInput({ ...option, target: { ...option.target, packageDefinitionId: '' } }, 'tenant-a')).toBe(
      false,
    );
  });

  it('rejects cross-tenant, blank, and overlong comparison codes', () => {
    expect(validSkuChangeInput(base, 'tenant-b')).toBe(false);
    expect(validSkuChangeInput({ ...base, code: '  ' }, 'tenant-a')).toBe(false);
    expect(validSkuChangeInput({ ...base, code: 'A'.repeat(241) }, 'tenant-a')).toBe(false);
  });

  it('requires bounded, trimmed reason and durable evidence', () => {
    expect(validSkuChangeInput({ ...base, reason: ' ' }, 'tenant-a')).toBe(false);
    expect(validSkuChangeInput({ ...base, reason: ' padded ' }, 'tenant-a')).toBe(false);
    expect(validSkuChangeInput({ ...base, evidenceRefs: [] }, 'tenant-a')).toBe(false);
    expect(validSkuChangeInput({ ...base, evidenceRefs: [' '] }, 'tenant-a')).toBe(false);
    expect(validSkuChangeInput({ ...base, expectedRevision: -1 }, 'tenant-a')).toBe(false);
    expect(validSkuChangeInput({ ...base, actionInvocationId: 'not-a-uuid' }, 'tenant-a')).toBe(false);
  });
});

describe('SKU authoritative target absence', () => {
  it.effect('returns not_found when the authoritative Variant lookup succeeds with no row', () =>
    Effect.gen(function* missingVariant() {
      const outcome = yield* persistenceWithEmptyAuthoritativeLookup().assign(base);
      expect(
        Match.value(outcome).pipe(
          Match.tag('not_found', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
    }),
  );

  it.effect('returns not_found when the authoritative Package Definition lookup succeeds with no row', () =>
    Effect.gen(function* missingPackageDefinition() {
      const outcome = yield* persistenceWithEmptyAuthoritativeLookup().assign({
        ...base,
        target: {
          kind: 'PACKAGE_OPTION',
          packageDefinitionId: '00000000-0000-4000-8000-000000000004',
          tenantId: 'tenant-a',
        },
      });
      expect(
        Match.value(outcome).pipe(
          Match.tag('not_found', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
    }),
  );

  it.effect('keeps an authoritative lookup outage distinct from target absence', () =>
    Effect.gen(function* unavailableTargetOwner() {
      const query = {
        for: () => query,
        from: () => query,
        limit: () => Effect.fail(new Error('database unavailable')),
        where: () => query,
      };
      const persistence = skuPersistenceForScope(
        // @ts-expect-error This focused mock implements the failing authoritative-select path only.
        { select: () => query },
        { tenantId: 'tenant-a' },
      );
      const failure = yield* Effect.flip(persistence.assign(base));
      expect(Schema.is(SkuPersistenceUnavailable)(failure)).toBe(true);
    }),
  );
});

describe('SKU Package Option Current proof', () => {
  const now = new Date('2026-09-17T10:00:00.000Z');
  const active = {
    content: {
      effectiveAt: new Date('2026-09-16T10:00:00.000Z'),
      lifecycleState: 'ACTIVE',
      productId: 'product-a',
      unitResourceType: 'commerce.catalog.product-unit',
      variantId: 'variant-a',
    },
    contentRevision: 4,
    definition: {
      currentOptionRevision: 2,
      currentRevision: 4,
      lifecycleState: 'ACTIVE',
      optionState: 'ACTIVE',
      packageDefinitionId: 'package-a',
      productId: 'product-a',
      variantId: 'variant-a',
    },
    effectiveContentRevision: 4,
    now,
    productLifecycle: 'ACTIVE',
    role: {
      contentRevision: 4,
      effectiveAt: new Date('2026-09-16T11:00:00.000Z'),
      independentlyRequested: true,
      looseUnitsSubstitutable: false,
      productId: 'product-a',
      revision: 2,
      state: 'ACTIVE',
      variantId: 'variant-a',
    },
    unitLifecycle: 'ACTIVE',
    variantLifecycle: 'ACTIVE',
  } as const;
  it('accepts only pinned active role and content for an independent Option', () => {
    expect(currentPackageOptionSnapshotMatches(active)).toBe(true);
    expect(currentPackageOptionSnapshotMatches({ ...active, contentRevision: 3 })).toBe(false);
    expect(currentPackageOptionSnapshotMatches({ ...active, effectiveContentRevision: 3 })).toBe(false);
    expect(currentPackageOptionSnapshotMatches({ ...active, role: { ...active.role, contentRevision: 3 } })).toBe(
      false,
    );
    expect(currentPackageOptionSnapshotMatches({ ...active, role: { ...active.role, revision: 1 } })).toBe(false);
    expect(
      currentPackageOptionSnapshotMatches({ ...active, role: { ...active.role, independentlyRequested: false } }),
    ).toBe(false);
    expect(
      currentPackageOptionSnapshotMatches({ ...active, role: { ...active.role, looseUnitsSubstitutable: true } }),
    ).toBe(false);
  });

  it('accepts the exact effective content when a later revision is pending', () => {
    expect(
      currentPackageOptionSnapshotMatches({
        ...active,
        definition: { ...active.definition, currentRevision: 5 },
      }),
    ).toBe(true);
    expect(
      currentPackageOptionSnapshotMatches({
        ...active,
        contentRevision: 5,
        definition: { ...active.definition, currentRevision: 5 },
      }),
    ).toBe(false);
  });

  it('rejects future or retired Current basis and parent lifecycle loss', () => {
    expect(
      currentPackageOptionSnapshotMatches({ ...active, definition: { ...active.definition, optionState: 'RETIRED' } }),
    ).toBe(false);
    expect(currentPackageOptionSnapshotMatches({ ...active, productLifecycle: 'RETIRED' })).toBe(false);
    expect(currentPackageOptionSnapshotMatches({ ...active, variantLifecycle: 'RETIRED' })).toBe(false);
    expect(currentPackageOptionSnapshotMatches({ ...active, unitLifecycle: 'RETIRED' })).toBe(false);
    expect(currentPackageOptionSnapshotMatches({ ...active, content: { ...active.content, variantId: 'other' } })).toBe(
      false,
    );
    expect(
      currentPackageOptionSnapshotMatches({
        ...active,
        content: { ...active.content, effectiveAt: new Date('2026-09-18T00:00:00.000Z') },
      }),
    ).toBe(false);
  });

  it('separates known invalid Current state from contradictory Current proof', () => {
    expect(invalidReason({ ...active, productLifecycle: 'RETIRED' })).toBe('PRODUCT_NOT_ACTIVE');
    expect(invalidReason({ ...active, variantLifecycle: 'RETIRED' })).toBe('VARIANT_NOT_ACTIVE');
    expect(invalidReason({ ...active, definition: { ...active.definition, optionState: 'RETIRED' } })).toBe(
      'PACKAGE_OPTION_NOT_ACTIVE',
    );
    expect(invalidReason({ ...active, content: { ...active.content, lifecycleState: 'RETIRED' } })).toBe(
      'CONTENT_NOT_ACTIVE',
    );
    expect(invalidReason({ ...active, unitLifecycle: 'RETIRED' })).toBe('UNIT_NOT_ACTIVE');
    expect(
      Match.value(
        assessCurrentPackageOptionSnapshot({
          ...active,
          role: { ...active.role, contentRevision: 3 },
        }),
      ).pipe(
        Match.tag('INDETERMINATE', ({ reason }) => reason),
        Match.orElse(() => null),
      ),
    ).toBe('CURRENT_SNAPSHOT_CONTRADICTORY');
  });
});

describe('owner-local SKU lookup', () => {
  const tenantId = 'tenant-a';
  const current = {
    currentRevision: 1,
    displayCode: ' D-10 ',
    normalizedCode: 'D-10',
    packageDefinitionId: null,
    state: 'CURRENT',
    tenantId,
    variantId: 'variant-a',
  };
  const first = {
    normalizedCode: 'D-10',
    packageDefinitionId: null,
    revision: 1,
    state: 'CURRENT',
    tenantId,
    variantId: 'variant-a',
  };

  it('returns a precise Current Variant in one Tenant using normalized comparison', () => {
    expect(assessSkuLookupSnapshot(tenantId, ' d-10 ', current, [first])).toMatchObject({
      displayCode: ' D-10 ',
      revision: 1,
      state: 'CURRENT',
      target: { kind: 'VARIANT', tenantId, variantId: 'variant-a' },
    });
    expect(
      Match.value(assessSkuLookupSnapshot('tenant-b', 'D-10', undefined, [])).pipe(
        Match.tag('not_found', () => true),
        Match.orElse(() => false),
      ),
    ).toBe(true);
  });

  it('preserves Historical status without declaring Current usability', () => {
    expect(
      assessSkuLookupSnapshot(tenantId, 'D-10', { ...current, currentRevision: 2, state: 'HISTORICAL' }, [
        { ...first, revision: 2, state: 'HISTORICAL' },
        first,
      ]),
    ).toMatchObject({ state: 'HISTORICAL', target: { kind: 'VARIANT', variantId: 'variant-a' } });
  });

  it('keeps Package Option identity distinct from its Variant', () => {
    const option = { ...current, packageDefinitionId: 'package-a' };
    const optionRevision = { ...first, packageDefinitionId: 'package-a' };
    expect(assessSkuLookupSnapshot(tenantId, 'D-10', option, [optionRevision])).toMatchObject({
      target: { kind: 'PACKAGE_OPTION', packageDefinitionId: 'package-a', tenantId },
    });
  });

  it('does not silently reinterpret an earlier incorrect attribution', () => {
    const corrected = { ...current, currentRevision: 2, variantId: 'variant-b' };
    const correctedOutcome = assessSkuLookupSnapshot(tenantId, 'D-10', corrected, [
      { ...first, revision: 2, variantId: 'variant-b' },
      first,
    ]);
    expect(
      Match.value(correctedOutcome).pipe(
        Match.tag('ambiguous', () => true),
        Match.orElse(() => false),
      ),
    ).toBe(true);
    const unresolvedOutcome = assessSkuLookupSnapshot(tenantId, 'D-10', { ...current, state: 'UNRESOLVED' }, [first]);
    expect(
      Match.value(unresolvedOutcome).pipe(
        Match.tag('ambiguous', () => true),
        Match.orElse(() => false),
      ),
    ).toBe(true);
  });

  it('rejects blank input and fails closed on incomplete or cross-tenant history', () => {
    expect(
      Match.value(assessSkuLookupSnapshot(tenantId, ' ', undefined, [])).pipe(
        Match.tag('invalid', () => true),
        Match.orElse(() => false),
      ),
    ).toBe(true);
    expect(Schema.is(SkuPersistenceUnavailable)(assessSkuLookupSnapshot(tenantId, 'D-10', current, []))).toBe(true);
    expect(
      Schema.is(SkuPersistenceUnavailable)(
        assessSkuLookupSnapshot(tenantId, 'D-10', current, [{ ...first, tenantId: 'tenant-b' }]),
      ),
    ).toBe(true);
    expect(
      Schema.is(SkuPersistenceUnavailable)(
        assessSkuLookupSnapshot(tenantId, 'D-10', { ...current, currentRevision: 2 }, [{ ...first, revision: 2 }]),
      ),
    ).toBe(true);
  });
});
