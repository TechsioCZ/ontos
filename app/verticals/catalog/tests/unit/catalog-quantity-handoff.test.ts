import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { prepareCatalogQuantityHandoff } from '../../shared/domain/catalog-quantity-handoff.ts';
import {
  CatalogSelectionSchema,
  CatalogSelectionEvidenceSchema,
  PackageDefinitionSelectionRevisionSchema,
  VariantSelectionRevisionSchema,
} from '../../shared/domain/catalog-selection-evidence.ts';
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
