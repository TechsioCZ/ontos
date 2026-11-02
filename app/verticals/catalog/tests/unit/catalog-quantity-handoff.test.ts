import { describe, expect, it } from 'effect-rstest';
import { Effect, Option, Schema } from 'effect';
import { NodeCrypto } from '@effect/platform-node';
import type { CatalogSelectionCurrentFacts } from '../../shared/domain/catalog-selection-assessment.ts';
import {
  CatalogSelectionBasisSchema,
  CatalogSelectionMembershipSchema,
  CatalogSelectionSchema,
  CatalogSelectionEvidenceSchema,
  PackageDefinitionSelectionRevisionSchema,
  VariantSelectionRevisionSchema,
} from '../../shared/domain/catalog-selection-evidence.ts';
import { resolvePricingPurposeEquivalence } from '../../src/api/pricing-purpose-equivalence.read.ts';
import { PricingPurposeEquivalenceRequestSchema } from '../../shared/apis/pricing-purpose-equivalence.ts';

import {
  assembleCatalogQuantityHandoff,
  prepareCatalogQuantityHandoff,
} from '../../shared/domain/catalog-quantity-handoff.ts';
import { CatalogResourceRefSchema } from '../../shared/domain/catalog-revision-reference.ts';
import type { CatalogSelectionEvidence } from '../../shared/domain/catalog-selection-evidence.ts';
import type { PackageContentRevision, PackageResolution } from '../../shared/domain/package-content.ts';
import type { QuantityNormalization } from '../../shared/domain/purchase-quantity.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType,
  tenantId,
});
const productRef = ref('commerce.catalog.product', '22222222-2222-4222-8222-222222222222');
const variantRef = ref('commerce.catalog.variant', '33333333-3333-4333-8333-333333333333');
const packageRef = ref('commerce.catalog.package-definition', '44444444-4444-4444-8444-444444444444');
const unitRef = ref('commerce.catalog.product-unit', '55555555-5555-4555-8555-555555555555');
const revision = { resourceRef: packageRef, revision: 1 };
const pinnedRevision = Schema.decodeUnknownSync(PackageDefinitionSelectionRevisionSchema)(revision);
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  packageOption: { contentRevision: revision, optionRef: packageRef },
  productRef,
  variantRef,
});
const variantRevision = Schema.decodeUnknownSync(VariantSelectionRevisionSchema)({
  resourceRef: variantRef,
  revision: 1,
});
const evidence: CatalogSelectionEvidence = Schema.decodeUnknownSync(CatalogSelectionEvidenceSchema)({
  assessedAt: '2026-09-17T12:00:00.000Z',
  basis: [
    { role: 'PRODUCT', source: { resourceRef: productRef, revision: 1 } },
    { role: 'VARIANT', source: variantRevision },
    {
      provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
      role: 'PRODUCT_TYPE_UNTYPED_DECISION',
      source: { resourceRef: productRef, revision: 1 },
    },
    { role: 'PACKAGE_CONTENT', source: pinnedRevision },
    { role: 'UNIT_RULE', source: { resourceRef: unitRef, revision: 1 } },
    { role: 'UNIT_TARGET_DIVISIBILITY', source: { resourceRef: packageRef, revision: 1 } },
  ],
  membership: {
    attestationId: '99999999-9999-4999-8999-999999999999',
    observedAt: '2026-09-17T12:00:00.000Z',
    productRef: selection.productRef,
    source: 'CATALOG_OWNER_CURRENT_READ',
    variant: variantRevision,
  },
  purpose: 'purchase',
  selection,
  status: 'VALID',
});
const quantity: QuantityNormalization = {
  changed: false,
  notice: null,
  requested: '2',
  resulting: '2',
  rounding: 'UP',
  status: 'VALID',
  step: '1',
  targetId: packageRef.resourceId,
  tenantId,
  unitId: unitRef.resourceId,
  unitRuleRevision: 1,
};
const packageRevision: PackageContentRevision = {
  amount: '10',
  form: { productRef: selection.productRef, variantRef: selection.variantRef },
  reference: pinnedRevision,
  unitRef: Schema.decodeUnknownSync(CatalogResourceRefSchema)(unitRef),
};
const content: PackageResolution = {
  amount: '20',
  path: [pinnedRevision],
  status: 'VALID',
  unitRef: packageRevision.unitRef,
};
const input = () => ({
  divisibilityRevision: 1,
  divisible: false,
  evidence,
  packageContent: content,
  packageRevision,
  quantity,
  selection,
  unitRef: packageRevision.unitRef,
});

describe('Catalog quantity handoff', () => {
  it('requires matching owner revisions for Unit step and target divisibility', () => {
    expect(prepareCatalogQuantityHandoff(input()).status).toBe('READY');
    expect(prepareCatalogQuantityHandoff({ ...input(), divisibilityRevision: 2 }).status).toBe('UNVERIFIABLE');
    expect(prepareCatalogQuantityHandoff({ ...input(), quantity: { ...quantity, unitRuleRevision: 2 } }).status).toBe(
      'UNVERIFIABLE',
    );
    expect(
      prepareCatalogQuantityHandoff({ ...input(), evidence: { ...evidence, basis: evidence.basis.slice(0, -1) } })
        .status,
    ).toBe('UNVERIFIABLE');
  });

  it('does not present a lower package conversion without its exact revision basis', () => {
    const lower = Schema.decodeUnknownSync(PackageDefinitionSelectionRevisionSchema)({
      resourceRef: ref('commerce.catalog.package-definition', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      revision: 3,
    });
    const nested = { ...content, path: [pinnedRevision, lower] };
    expect(prepareCatalogQuantityHandoff({ ...input(), packageContent: nested }).status).toBe('UNVERIFIABLE');
  });
  it('requires matching package content identity beyond the first revision path', () => {
    expect(prepareCatalogQuantityHandoff(input())).toMatchObject({ packageRevision, status: 'READY' });
    expect(
      prepareCatalogQuantityHandoff({
        ...input(),
        packageRevision: {
          ...packageRevision,
          form: {
            ...packageRevision.form,
            variantRef: { ...packageRevision.form.variantRef, resourceId: productRef.resourceId },
          },
        },
      }).status,
    ).toBe('STALE');
  });

  it('keeps missing and invalid package facts distinct from a stale match', () => {
    expect(
      prepareCatalogQuantityHandoff({
        divisibilityRevision: 1,
        divisible: false,
        evidence,
        packageContent: content,
        quantity,
        selection,
        unitRef: packageRevision.unitRef,
      }).status,
    ).toBe('UNVERIFIABLE');
    expect(
      prepareCatalogQuantityHandoff({
        ...input(),
        packageContent: { reason: 'Missing lower revision', status: 'UNVERIFIABLE' },
      }).status,
    ).toBe('UNVERIFIABLE');
    expect(
      prepareCatalogQuantityHandoff({ ...input(), packageContent: { reason: 'Cycle', status: 'INVALID' } }).status,
    ).toBe('INVALID');
  });

  it('ties converted content to prepared package count without replacing the purchase-line quantity', () => {
    expect(prepareCatalogQuantityHandoff(input()).status).toBe('READY');
    expect(prepareCatalogQuantityHandoff({ ...input(), packageContent: { ...content, amount: '16' } }).status).toBe(
      'STALE',
    );
    expect(prepareCatalogQuantityHandoff({ ...input(), quantity: { ...quantity, resulting: '2.5' } }).status).toBe(
      'STALE',
    );
    const ready = prepareCatalogQuantityHandoff(input());
    if (ready.status === 'READY') {
      expect(ready.quantity.resulting).toBe('2');
      expect(ready.packageContent?.amount).toBe('20');
    }
  });

  it('rejects a different content Unit and Set composition', () => {
    const otherUnit = Schema.decodeUnknownSync(CatalogResourceRefSchema)(
      ref('commerce.catalog.unit', '66666666-6666-4666-8666-666666666666'),
    );
    expect(
      prepareCatalogQuantityHandoff({ ...input(), packageRevision: { ...packageRevision, unitRef: otherUnit } }).status,
    ).toBe('STALE');
    const setComposition = {
      resourceRef: ref('commerce.catalog.set-composition', '77777777-7777-4777-8777-777777777777'),
      revision: 1,
    };
    const setSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({ ...selection, setComposition });
    expect(
      prepareCatalogQuantityHandoff({
        ...input(),
        evidence: { ...evidence, selection: setSelection },
        selection: setSelection,
      }).status,
    ).toBe('STALE');
  });

  it('requires an owner-issued configuration key for configured content', () => {
    const configured = Schema.decodeUnknownSync(CatalogSelectionSchema)({
      ...selection,
      configuration: {
        choices: [],
        definition: {
          resourceRef: ref('commerce.catalog.configuration-definition', '88888888-8888-4888-8888-888888888888'),
          revision: 1,
        },
        productRef,
        variantRef,
      },
    });
    const configuredInput = { ...input(), evidence: { ...evidence, selection: configured }, selection: configured };
    expect(prepareCatalogQuantityHandoff(configuredInput).status).toBe('UNVERIFIABLE');
    expect(prepareCatalogQuantityHandoff({ ...configuredInput, configurationKey: 'blue' }).status).toBe('STALE');
    expect(
      prepareCatalogQuantityHandoff({
        ...configuredInput,
        configurationKey: 'blue',
        packageRevision: { ...packageRevision, configurationKey: 'blue' },
      }).status,
    ).toBe('READY');
  });
});

it('keeps material Quantity identity stable across fresh membership attestations', () => {
  const basis = {
    contentPath: [
      {
        amount: '10',
        configurationKey: null,
        lowerCount: null,
        packageDefinitionId: packageRef.resourceId,
        revision: 1,
        unitId: unitRef.resourceId,
      },
    ],
    productRevision: 1,
    unit: {
      divisible: false,
      id: unitRef.resourceId,
      rounding: 'UP' as const,
      ruleRevision: 1,
      step: '1',
      targetDivisibilityRevision: 1,
    },
    variantRevision: 1,
  };
  expect(evidence.status).toBe('VALID');
  if (evidence.status !== 'VALID') {
    return;
  }
  const current: CatalogSelectionCurrentFacts = {
    assessedAt: evidence.assessedAt,
    basis: evidence.basis,
    dependentFactsComplete: true,
    membership: evidence.membership,
    productLifecycle: 'ACTIVE',
    purpose: evidence.purpose,
    selection,
    source: 'CATALOG_OWNER_CURRENT_READ',
    status: 'OBSERVED',
    variantLifecycle: 'ACTIVE',
  };
  const first = assembleCatalogQuantityHandoff({ basis, current, quantity, selection });
  const observedAt = '2026-09-17T12:00:01.000Z';
  const next = {
    ...current,
    assessedAt: observedAt,
    membership: Schema.decodeUnknownSync(CatalogSelectionMembershipSchema)({
      ...current.membership,
      attestationId: '88888888-8888-4888-8888-888888888888',
      observedAt,
    }),
  };
  const fresh = assembleCatalogQuantityHandoff({ basis, current: next, quantity, selection });
  expect(first.status).toBe('READY');
  expect(fresh.status).toBe('READY');
  if (first.status !== 'READY' || fresh.status !== 'READY') {
    return;
  }
  expect(first.evidence).not.toEqual(fresh.evidence);
  expect(first.ownerRevision).toBe(fresh.ownerRevision);
});

// Owner-local unit facts only; public Cart-backed Configuration production is a separate prerequisite.
const configuredMaterialInput = (observedAt = '2026-10-01T12:00:00.000Z', attestationId = 'observation-initial') => {
  const configured = Schema.decodeUnknownSync(CatalogSelectionSchema)({
    configuration: {
      choices: [{ choiceKey: 'mount', value: 'A' }],
      definition: {
        resourceRef: ref('commerce.catalog.configuration-definition', '88888888-8888-4888-8888-888888888888'),
        revision: 1,
      },
      productRef,
      variantRef,
    },
    productRef,
    variantRef,
  });
  const materialBasis = Schema.decodeUnknownSync(Schema.Array(CatalogSelectionBasisSchema))([
    { role: 'PRODUCT', source: { resourceRef: productRef, revision: 1 } },
    { role: 'VARIANT', source: variantRevision },
    {
      provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
      role: 'PRODUCT_TYPE_UNTYPED_DECISION',
      source: { resourceRef: productRef, revision: 1 },
    },
    { role: 'CONFIGURATION_DEFINITION', source: configured.configuration?.definition },
    { role: 'UNIT_RULE', source: { resourceRef: unitRef, revision: 1 } },
    { role: 'UNIT_TARGET_DIVISIBILITY', source: { resourceRef: variantRef, revision: 1 } },
    {
      role: 'CATEGORY',
      source: {
        resourceRef: ref('commerce.catalog.product-category', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
        revision: 1,
      },
    },
  ]);
  const current: Extract<CatalogSelectionCurrentFacts, { status: 'OBSERVED' }> = {
    assessedAt: observedAt,
    basis: materialBasis,
    dependentFactsComplete: true,
    membership: Schema.decodeUnknownSync(CatalogSelectionMembershipSchema)({
      attestationId,
      observedAt,
      productRef,
      source: 'CATALOG_OWNER_CURRENT_READ',
      variant: variantRevision,
    }),
    productLifecycle: 'ACTIVE',
    purpose: 'PRICING',
    selection: configured,
    source: 'CATALOG_OWNER_CURRENT_READ',
    status: 'OBSERVED',
    validUntil: '2026-10-02T00:00:00.000Z',
    variantLifecycle: 'ACTIVE',
  };
  return {
    basis: {
      contentPath: [],
      productRevision: 1,
      unit: {
        divisible: false,
        id: unitRef.resourceId,
        rounding: 'UP' as const,
        ruleRevision: 1,
        step: '1',
        targetDivisibilityRevision: 1,
      },
      variantRevision: 1,
    },
    current,
    quantity: { ...quantity, targetId: variantRef.resourceId },
    selection: configured,
  };
};

it('retains every membership material field and all source, hierarchy, quantity and Unit inputs', () => {
  const original = configuredMaterialInput();
  const stable = assembleCatalogQuantityHandoff(original);
  expect(stable.status).toBe('READY');
  if (stable.status !== 'READY') {
    return;
  }
  const { current } = original;
  for (const membership of [
    { ...current.membership, productRef: { ...current.membership.productRef, resourceId: packageRef.resourceId } },
    {
      ...current.membership,
      variant: {
        ...current.membership.variant,
        resourceRef: { ...variantRevision.resourceRef, resourceId: packageRef.resourceId },
      },
    },
    {
      ...current.membership,
      variant: {
        ...current.membership.variant,
        revision: Schema.decodeUnknownSync(VariantSelectionRevisionSchema)({ ...variantRevision, revision: 2 })
          .revision,
      },
    },
    Schema.decodeUnknownSync(CatalogSelectionMembershipSchema)({
      ...current.membership,
      productRef: { ...productRef, tenantId: '99999999-9999-4999-8999-999999999999' },
      variant: { ...variantRevision, resourceRef: { ...variantRef, tenantId: '99999999-9999-4999-8999-999999999999' } },
    }),
  ]) {
    expect(assembleCatalogQuantityHandoff({ ...original, current: { ...current, membership } }).status).toBe(
      'UNVERIFIABLE',
    );
  }
  expect(
    Option.isNone(
      Schema.decodeUnknownOption(CatalogSelectionMembershipSchema)({
        ...current.membership,
        source: 'UNTRUSTED_SOURCE',
      }),
    ),
  ).toBe(true);
  for (const fact of current.basis) {
    const changed = assembleCatalogQuantityHandoff({
      ...original,
      current: {
        ...current,
        basis: current.basis.map((entry) =>
          entry === fact
            ? Schema.decodeUnknownSync(CatalogSelectionBasisSchema)({
                ...entry,
                source: { ...entry.source, revision: entry.source.revision + 1 },
              })
            : entry,
        ),
      },
    });
    if (changed.status === 'READY') {
      expect(changed.ownerRevision).not.toBe(stable.ownerRevision);
    } else {
      expect(['INVALID', 'UNVERIFIABLE', 'STALE']).toContain(changed.status);
    }
  }
  for (const basis of [
    { ...original.basis, productRevision: 2 },
    { ...original.basis, variantRevision: 2 },
    { ...original.basis, setCompositionRevision: 2 },
    { ...original.basis, unit: { ...original.basis.unit, rounding: 'DOWN' as const } },
    { ...original.basis, unit: { ...original.basis.unit, step: '2' } },
    { ...original.basis, unit: { ...original.basis.unit, divisible: true } },
    { ...original.basis, unit: { ...original.basis.unit, ruleRevision: 2 } },
    { ...original.basis, unit: { ...original.basis.unit, targetDivisibilityRevision: 2 } },
  ]) {
    const changed = assembleCatalogQuantityHandoff({ ...original, basis });
    if (changed.status === 'READY') {
      expect(changed.ownerRevision).not.toBe(stable.ownerRevision);
    } else {
      expect(['INVALID', 'UNVERIFIABLE', 'STALE']).toContain(changed.status);
    }
  }
  const changedQuantity = assembleCatalogQuantityHandoff({
    ...original,
    quantity: { ...original.quantity, requested: '3', resulting: '3' },
  });
  expect(changedQuantity.status).toBe('READY');
  if (changedQuantity.status === 'READY') {
    expect(changedQuantity.ownerRevision).not.toBe(stable.ownerRevision);
  }
});

it.effect('revalidates freshly assembled finite handoffs with stable real equivalence generation', () =>
  Effect.gen(function* freshMaterialEquivalence() {
    const original = configuredMaterialInput();
    const supplied = assembleCatalogQuantityHandoff(original);
    expect(supplied.status).toBe('READY');
    if (supplied.status !== 'READY') {
      return;
    }
    const request = Schema.decodeUnknownSync(PricingPurposeEquivalenceRequestSchema)({
      anchorSelection: supplied.selection,
      effectiveAt: '2026-10-01T12:00:01.000Z',
      members: [{ handoff: supplied, occurrenceId: 'line-1' }],
    });
    let serial = 0;
    const prepare = () =>
      Effect.sync(() => {
        serial += 1;
        return assembleCatalogQuantityHandoff(
          configuredMaterialInput(`2026-10-01T12:00:0${serial + 1}.000Z`, `fresh-observation-${serial}`),
        );
      });
    const first = yield* resolvePricingPurposeEquivalence(request, { prepare });
    const replay = yield* resolvePricingPurposeEquivalence(request, { prepare });
    expect(serial).toBe(4);
    expect(first.outcome).toBe('CATALOG_EQUIVALENCE_CONFIRMED');
    expect(replay.outcome).toBe('CATALOG_EQUIVALENCE_CONFIRMED');
    if (first.outcome !== 'CATALOG_EQUIVALENCE_CONFIRMED' || replay.outcome !== 'CATALOG_EQUIVALENCE_CONFIRMED') {
      return;
    }
    expect(replay.generation).toBe(first.generation);
    expect(replay.currentness.validThrough).toBe('2026-10-02T00:00:00.000Z');
    expect(replay.verificationReceipt.verificationRef).not.toBe(first.verificationReceipt.verificationRef);
    const revised = configuredMaterialInput('2026-10-01T12:00:06.000Z', 'material-revised');
    revised.current = {
      ...revised.current,
      basis: revised.current.basis.map((fact) =>
        fact.role === 'PRODUCT'
          ? Schema.decodeUnknownSync(CatalogSelectionBasisSchema)({ ...fact, source: { ...fact.source, revision: 2 } })
          : fact,
      ),
    };
    const stale = yield* resolvePricingPurposeEquivalence(request, {
      prepare: () => Effect.succeed(assembleCatalogQuantityHandoff(revised)),
    });
    expect(stale.outcome).toBe('CATALOG_EQUIVALENCE_STALE');
    const { validUntil: _end, ...withoutEnd } = revised.current;
    const unbounded = assembleCatalogQuantityHandoff({
      ...original,
      current: { ...withoutEnd, basis: original.current.basis },
    });
    expect(unbounded.status).toBe('READY');
    const noInterval = yield* resolvePricingPurposeEquivalence(request, { prepare: () => Effect.succeed(unbounded) });
    expect(noInterval.outcome).toBe('CATALOG_EQUIVALENCE_UNVERIFIABLE');
    const expired = configuredMaterialInput('2026-10-02T00:00:00.000Z', 'boundary-observation');
    expect(assembleCatalogQuantityHandoff(expired).status).toBe('UNVERIFIABLE');
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(PricingPurposeEquivalenceRequestSchema)({
          ...request,
          effectiveAt: original.current.validUntil,
        }),
      ),
    ).toBe(true);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);
