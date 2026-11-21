import {
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  TrustedPrincipalContextSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import { makeAccessDecisionService } from '@app/core-runtime/access/enforcement';
import type { AccessPrincipalKind } from '@app/core-runtime/access/enforcement';
import { inertAccessEnforcementPorts } from '@app/core-runtime/testing/access-gate';
import type { TestAccessOutcome } from '@app/core-runtime/testing/access-gate';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import type { ReadTestOwnerQuery } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { Cause, DateTime, Effect, Exit, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { bindAccessGate } from '../../../../packages/core-runtime/src/operations/access-gate.ts';
import type {
  AccessEnforcementPorts,
  BoundAccessGate,
} from '../../../../packages/core-runtime/src/operations/access-gate.ts';
import { ProductPageRequestSchema } from '../../shared/apis/product-page.ts';
import type { ProductPageRequest } from '../../shared/apis/product-page.ts';
import { CatalogMediaAssignmentSchema, selectCatalogMediaSet } from '../../shared/domain/catalog-media-assignment.ts';
import { ProductSchema } from '../../shared/domain/product.ts';
import { productDetailRead } from '../../src/api/product-detail.read.ts';
import { productPageRead, readProductPage } from '../../src/api/product-page.read.ts';
import type { ProductPageServices } from '../../src/persistence/product-page-reads.ts';
import type { VariantAxisPersistence } from '../../src/persistence/variant-axis-persistence.ts';
import { catalogRegistration } from '../../vertical.registration.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const categoryId = '55555555-5555-4555-8555-555555555555';
const compositionRevision = 'a'.repeat(64);
const at = DateTime.toDateUtc(DateTime.makeUnsafe('2030-06-01T00:00:00Z'));
const storefrontWorkload = 'commerce.storefront-client';
const pageCapability = 'commerce.catalog.product-page.read';
const detailCapability = 'commerce.catalog.product-detail.read';

const request = (fields: Partial<typeof ProductPageRequestSchema.Encoded> = {}): ProductPageRequest =>
  Schema.decodeUnknownSync(ProductPageRequestSchema)({
    lifecycles: ['ACTIVE'],
    limit: 5,
    locale: 'cs-CZ',
    offset: 10,
    ...fields,
  });

/** A storefront BFF's API-key principal or a staff session: no company, because Catalog has none. */
const principalOf = (authMethod: 'api_key' | 'session') =>
  trustVerifiedGatewayPrincipalContext(
    Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
      authBindingId: '44444444-4444-4444-8444-444444444444',
      authContextRef: `${authMethod}:product-page`,
      authMethod,
      principalId,
      tenantId,
    }),
    compositionRevision,
  );

/** The real Core gate over a scripted principal kind and workload registry (O73); no grant is ever read. */
const workloadGate = (kind: AccessPrincipalKind, boundWorkloadKeys: readonly string[]): BoundAccessGate => {
  const ports: AccessEnforcementPorts = {
    ...inertAccessEnforcementPorts(),
    principalKinds: { readKind: () => Effect.succeed(Option.some(kind)) },
    workloadBindings: {
      readWorkloadAuthority: () =>
        Effect.succeed({ activeCompanyIds: new Set(), workloadKeys: new Set(boundWorkloadKeys) }),
    },
  };
  return bindAccessGate(
    makeAccessDecisionService({
      authorityFor: ports.intent.authorityFor,
      check: ports.check,
      decisionLog: ports.decisionLog,
      legalEntities: ports.candidates,
      principalKinds: ports.principalKinds,
      workloadBindings: ports.workloadBindings,
    }),
    ports,
  );
};

/** Owner SQL of an empty page: its total, then the page. Any other statement fails the test. */
const emptyPage = ({ sql }: ReadTestOwnerQuery) => {
  if (sql.startsWith('select count(*) from "catalog"."products"')) {
    return Effect.succeed([{ total: 0 }]);
  }
  if (sql.startsWith('select "catalog"."products"."product_id" from "catalog"."products"')) {
    return Effect.succeed([]);
  }
  return Effect.die(`Unexpected owner query: ${sql}`);
};

const runPage = Effect.fn('ProductPageTest.runPage')(function* runPage(
  input: ProductPageRequest,
  caller:
    | { readonly gate: BoundAccessGate; readonly method: 'api_key' }
    | { readonly access: Readonly<Record<string, TestAccessOutcome>>; readonly method: 'session' },
) {
  const principal = principalOf(caller.method);
  const harness = yield* makeReadTestHarness({
    ...('gate' in caller ? { accessDecision: caller.gate } : { access: caller.access }),
    compositionRevision,
    executeOwnerQuery: emptyPage,
    operationTime: at,
    ownerAuthorizationDecision: 'allowed',
    ownerRegistration: catalogRegistration,
    scope: { ...principal, correlationId: 'product-page' },
  });
  const exit = yield* Effect.exit(
    harness.runtime.runRead({
      input,
      principal,
      registration: productPageRead,
      transport: { correlationId: 'product-page' },
    }),
  );
  return { exit, ownerQueries: harness.snapshot().ownerQueries };
});

const deniedReason = (exit: Exit.Exit<unknown, unknown>) => {
  const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
  return Option.isSome(failure) && Schema.is(ReadPermissionDenied)(failure.value) ? failure.value.reason : undefined;
};

const localizedJoin =
  'from "catalog"."products" left join "catalog"."product_localized_facts" on (("catalog"."product_localized_facts"."tenant_id" = "catalog"."products"."tenant_id") and ("catalog"."product_localized_facts"."product_id" = "catalog"."products"."product_id") and ("catalog"."product_localized_facts"."locale" = $1))';
const tenantAndLifecycle =
  '("catalog"."products"."tenant_id" = $2) and ("catalog"."products"."lifecycle_state" in ($3))';
const retiredReason = 'Only a caller who may read any Product detail may page RETIRED Products';
const pageOrder = 'order by "catalog"."product_localized_facts"."name" asc, "catalog"."products"."product_id" asc';

describe('Catalog product page request', () => {
  it('pages like the source product page, takes the detail read locale and names each lifecycle once', () => {
    const decode = Schema.decodeUnknownOption(ProductPageRequestSchema);
    const base = { lifecycles: ['ACTIVE'], limit: 24, locale: 'cs-CZ', offset: 0 };
    expect(Option.isSome(decode(base))).toBe(true);
    expect(Option.isSome(decode({ ...base, lifecycles: ['DRAFT', 'ACTIVE', 'RETIRED'] }))).toBe(true);
    expect(Option.map(decode({ ...base, search: '  kladivo ' }), ({ search }) => search)).toEqual(
      Option.some('kladivo'),
    );
    for (const bad of [
      { lifecycles: [] },
      { lifecycles: ['ACTIVE', 'ACTIVE'] },
      { lifecycles: ['WORK_IN_PROGRESS'] },
      { limit: 0 },
      { limit: 101 },
      { offset: -1 },
      { search: '   ' },
      { search: 'x'.repeat(201) },
      { locale: 'cs-cz' },
      {
        categoryRef: {
          moduleId: 'commerce.catalog',
          resourceId: 'x',
          resourceType: 'commerce.catalog.product-category',
          tenantId,
        },
      },
    ]) {
      expect(Option.isNone(decode({ ...base, ...bad })), JSON.stringify(bad)).toBe(true);
    }
    const { lifecycles: _required, ...withoutLifecycles } = base;
    expect(Option.isNone(decode(withoutLifecycles))).toBe(true);
  });
});

describe('Catalog product page admission and SQL', () => {
  it('declares the storefront workload beside the staff declaration, scope-wide and with no company', () => {
    const { descriptor } = productPageRead;
    expect(descriptor.accessWorkload?.workloads).toEqual([storefrontWorkload]);
    expect(descriptor.accessDeclaration).toMatchObject({
      key: pageCapability,
      kind: 'read',
      modes: ['run'],
      risk: 'routine',
      selectors: [],
    });
    expect(descriptor.legalEntityScope).toBe('forbidden');
    // The question the read asks for RETIRED targets a declaration no workload is admitted to.
    expect(productDetailRead.descriptor.accessDeclaration?.key).toBe(detailCapability);
    expect(productDetailRead.descriptor.accessWorkload).toBeUndefined();
  });

  it.effect('admits the bound storefront workload to ACTIVE Products in one tenant-scoped page', () =>
    Effect.gen(function* boundStorefront() {
      const { exit, ownerQueries } = yield* runPage(request(), {
        gate: workloadGate('service', [storefrontWorkload]),
        method: 'api_key',
      });
      expect(exit).toEqual(Exit.succeed({ count: 0, items: [] }));
      expect(ownerQueries.map(({ params, sql }) => ({ params, sql }))).toEqual([
        {
          params: ['cs-CZ', tenantId, 'ACTIVE'],
          sql: `select count(*) ${localizedJoin} where (${tenantAndLifecycle})`,
        },
        {
          params: ['cs-CZ', tenantId, 'ACTIVE', 5, 10],
          sql: `select "catalog"."products"."product_id" ${localizedJoin} where (${tenantAndLifecycle}) ${pageOrder} limit $4 offset $5`,
        },
      ]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  // Demo-line rule: imported Products are DRAFTs, so the storefront pages DRAFT and ACTIVE; RETIRED stays reserved.
  it.effect('admits the storefront workload to DRAFT and ACTIVE Products in one tenant-scoped page', () =>
    Effect.gen(function* storefrontDrafts() {
      const { exit, ownerQueries } = yield* runPage(request({ lifecycles: ['DRAFT', 'ACTIVE'] }), {
        gate: workloadGate('service', [storefrontWorkload]),
        method: 'api_key',
      });
      expect(exit).toEqual(Exit.succeed({ count: 0, items: [] }));
      expect(ownerQueries.map(({ params }) => params)).toEqual([
        ['cs-CZ', tenantId, 'DRAFT', 'ACTIVE'],
        ['cs-CZ', tenantId, 'DRAFT', 'ACTIVE', 5, 10],
      ]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('refuses the storefront workload RETIRED Products before it reads a row', () =>
    Effect.gen(function* storefrontRetired() {
      const { exit, ownerQueries } = yield* runPage(request({ lifecycles: ['ACTIVE', 'RETIRED'] }), {
        gate: workloadGate('service', [storefrontWorkload]),
        method: 'api_key',
      });
      expect(deniedReason(exit)).toBe(retiredReason);
      expect(ownerQueries).toEqual([]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('refuses an unbound service principal and one bound to another workload', () =>
    Effect.gen(function* unboundService() {
      for (const bound of [[], ['demo.storefront-client']]) {
        const { exit, ownerQueries } = yield* runPage(request(), {
          gate: workloadGate('service', bound),
          method: 'api_key',
        });
        // Refused by the gate itself (deny.workload_unbound), not by the page's lifecycle rule.
        expect(deniedReason(exit)).toEqual(expect.any(String));
        expect(deniedReason(exit)).not.toBe(retiredReason);
        expect(ownerQueries).toEqual([]);
      }
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('lets staff who may read any Product detail page drafts, searched literally and by Category', () =>
    Effect.gen(function* staffDrafts() {
      const categoryRef = {
        moduleId: 'commerce.catalog',
        resourceId: categoryId,
        resourceType: 'commerce.catalog.product-category',
        tenantId,
      } as const;
      const { exit, ownerQueries } = yield* runPage(
        request({ categoryRef, lifecycles: ['DRAFT'], search: `100%_x\\` }),
        { access: { [detailCapability]: 'allowed', [pageCapability]: 'allowed' }, method: 'session' },
      );
      expect(exit).toEqual(Exit.succeed({ count: 0, items: [] }));
      const filters = `(${tenantAndLifecycle} and ("catalog"."product_localized_facts"."name" ilike $4) and (exists (select "category_id" from "catalog"."product_category_assignments" where (("catalog"."product_category_assignments"."tenant_id" = "catalog"."products"."tenant_id") and ("catalog"."product_category_assignments"."product_id" = "catalog"."products"."product_id") and ("catalog"."product_category_assignments"."category_id" = $5)))))`;
      expect(ownerQueries.map(({ params, sql }) => ({ params, sql }))).toEqual([
        {
          params: ['cs-CZ', tenantId, 'DRAFT', String.raw`%100\%\_x\\%`, categoryId],
          sql: `select count(*) ${localizedJoin} where ${filters}`,
        },
        {
          params: ['cs-CZ', tenantId, 'DRAFT', String.raw`%100\%\_x\\%`, categoryId, 5, 10],
          sql: `select "catalog"."products"."product_id" ${localizedJoin} where ${filters} ${pageOrder} limit $6 offset $7`,
        },
      ]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    'pages DRAFT and ACTIVE but not RETIRED for staff without Product detail, nothing without the capability',
    () =>
      Effect.gen(function* staffWithoutDetail() {
        const pageOnly = { access: { [pageCapability]: 'allowed' as const }, method: 'session' as const };
        const active = yield* runPage(request(), pageOnly);
        expect(active.exit).toEqual(Exit.succeed({ count: 0, items: [] }));
        const drafts = yield* runPage(request({ lifecycles: ['DRAFT'] }), pageOnly);
        expect(drafts.exit).toEqual(Exit.succeed({ count: 0, items: [] }));
        const retired = yield* runPage(request({ lifecycles: ['RETIRED'] }), pageOnly);
        expect(deniedReason(retired.exit)).toBe(retiredReason);
        expect(retired.ownerQueries).toEqual([]);
        const refused = yield* runPage(request(), { access: { [detailCapability]: 'allowed' }, method: 'session' });
        expect(deniedReason(refused.exit)).toEqual(expect.any(String));
        expect(refused.ownerQueries).toEqual([]);
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

const productRef = (resourceId: string) =>
  ({ moduleId: 'commerce.catalog', resourceId, resourceType: 'commerce.catalog.product', tenantId }) as const;
const variantRef = (resourceId: string) =>
  ({ moduleId: 'commerce.catalog', resourceId, resourceType: 'commerce.catalog.variant', tenantId }) as const;
const categoryRefOf = (resourceId: string, categoryTenantId: string) =>
  ({
    moduleId: 'commerce.catalog',
    resourceId,
    resourceType: 'commerce.catalog.product-category',
    tenantId: categoryTenantId,
  }) as const;
const activeProductId = 'a0000000-0000-4000-8000-000000000001';
const draftProductId = 'a0000000-0000-4000-8000-000000000002';
const activeVariantId = 'b0000000-0000-4000-8000-000000000001';
const workVariantId = 'b0000000-0000-4000-8000-000000000002';
const importedVariantId = 'b0000000-0000-4000-8000-000000000003';
const axisId = 'c0000000-0000-4000-8000-000000000001';
const ancestorId = 'd0000000-0000-4000-8000-000000000001';
const instant = '2030-01-01T00:00:00.000Z';
const productOf = (id: string, lifecycle: string, variants: readonly (readonly [string, string])[]) =>
  Schema.decodeUnknownSync(ProductSchema)({
    catalogReady: false,
    createdAt: instant,
    lifecycle,
    productRef: productRef(id),
    revision: 2,
    updatedAt: instant,
    variants: variants.map(([variantId, variantLifecycle]) => ({
      lifecycle: variantLifecycle,
      productRef: productRef(id),
      variantId,
      variantRef: variantRef(variantId),
    })),
  });
const products = new Map([
  [
    activeProductId,
    productOf(activeProductId, 'ACTIVE', [
      [activeVariantId, 'ACTIVE'],
      [workVariantId, 'WORK_IN_PROGRESS'],
    ]),
  ],
  [draftProductId, productOf(draftProductId, 'DRAFT', [[importedVariantId, 'WORK_IN_PROGRESS']])],
]);
const mediaAssignment = Schema.decodeUnknownSync(CatalogMediaAssignmentSchema)({
  assignmentId: 'e0000000-0000-4000-8000-000000000001',
  assignmentRevision: 1,
  order: 1,
  purpose: 'PRIMARY_IMAGE',
  resourceRef: {
    moduleId: 'documents.center',
    resourceId: 'f0000000-0000-4000-8000-000000000001',
    resourceType: 'documents.center.document',
    tenantId,
  },
  target: productRef(activeProductId),
});
const notCalled = (name: string) => () => Effect.die(`${name} must not be read for this page`);

/** Owner services as they answer one ACTIVE Product with an axis and one imported-like DRAFT Product. */
const services = (): ProductPageServices => {
  const axes: VariantAxisPersistence = {
    govern: notCalled('govern'),
    governAllowedValues: notCalled('governAllowedValues'),
    readCurrent: (ref) =>
      ref.resourceId === activeProductId
        ? Effect.succeed({ axes: [], axisRevision: 1, productId: ref.resourceId, productTypeRevision: null })
        : Effect.die('A Product without an ACTIVE Variant has no recorded combination to read'),
    readCurrentAllowedValues: notCalled('readCurrentAllowedValues'),
    readEffectiveValues: notCalled('readEffectiveValues'),
    readRecordedCombinations: notCalled('readRecordedCombinations'),
    readRecordedVariants: () =>
      Effect.succeed([
        {
          axisRevision: 1,
          combinationKey: 'f'.repeat(64),
          values: [
            {
              attributeDefinitionId: axisId,
              definitionRevision: 3,
              items: [
                {
                  attributeDefinitionId: axisId,
                  attributeValueSetId: 'c0000000-0000-4000-8000-000000000002',
                  controlledAttributeValueId: null,
                  numericValue: null,
                  ordinal: 0,
                  specialState: null,
                  tenantId,
                  textValue: 'Červená',
                  unit: null,
                  valueKind: 'TEXT',
                },
              ],
              source: 'VARIANT' as const,
              sourceRevision: 1,
              sourceValueSetRef: null,
            },
          ],
          variantId: activeVariantId,
        },
      ]),
  };
  return {
    axes,
    catalog: { getCurrent: (id) => Effect.succeed(Option.fromNullishOr(products.get(id))) },
    categories: {
      getClassification: (id) =>
        Effect.succeed(
          Option.some(
            id === activeProductId
              ? {
                  ancestors: [
                    {
                      ancestorRef: { resourceId: ancestorId, tenantId },
                      viaDirectCategories: [{ resourceId: categoryId, tenantId }],
                    },
                  ],
                  categoryNames: [
                    { categoryRef: { resourceId: categoryId, tenantId }, name: 'Kladiva' },
                    { categoryRef: { resourceId: ancestorId, tenantId }, name: 'Nářadí' },
                  ],
                  directCategories: [{ resourceId: categoryId, tenantId }],
                  revision: { assignments: 1, hierarchy: 1 },
                  status: 'AVAILABLE' as const,
                }
              : {
                  ancestors: [],
                  categoryNames: [],
                  directCategories: [],
                  revision: { assignments: 0, hierarchy: 1 },
                  status: 'AVAILABLE' as const,
                },
          ),
        ),
    },
    localized: {
      // A description alone is no name: the detail read answers a missing translation for the DRAFT Product.
      currentProduct: (ref, locale) =>
        Effect.succeed(
          ref.resourceId === activeProductId
            ? { kind: 'PRESENT', locale, name: 'Kladivo', revision: 1 }
            : { description: 'Jen popis', kind: 'PRESENT', locale, revision: 1 },
        ),
      currentVariant: (_ref, variant, locale) =>
        Effect.succeed(
          variant.resourceId === importedVariantId
            ? { description: 'Ocelové kladivo', kind: 'PRESENT', locale, name: 'Kladivo 500 g', revision: 1 }
            : { kind: 'MISSING_TRANSLATION', locale, revision: 0 },
        ),
    },
    media: {
      current: (target) =>
        Effect.succeed(
          Option.some(
            target.resourceId === activeProductId
              ? { ...selectCatalogMediaSet([mediaAssignment]), setRevision: 1 }
              : { ...selectCatalogMediaSet([]), setRevision: 0 },
          ),
        ),
    },
    page: {
      count: () => Effect.succeed(2),
      currentSkus: (ids) => Effect.succeed(new Map(ids.includes(activeVariantId) ? [[activeVariantId, 'KL-500']] : [])),
      productIds: () => Effect.succeed([activeProductId, draftProductId]),
    },
  };
};

describe('Catalog product page items', () => {
  it.effect('answers only Catalog facts: text as the detail read does, direct Categories, media, SKU and options', () =>
    Effect.gen(function* pageItems() {
      const page = yield* readProductPage(
        request({ lifecycles: ['ACTIVE', 'DRAFT'] }),
        tenantId,
        'allowed',
        services(),
      );
      // The storefront, which may not read any Product detail, gets the same page with the imported-like DRAFT.
      expect(
        yield* readProductPage(request({ lifecycles: ['ACTIVE', 'DRAFT'] }), tenantId, 'denied', services()),
      ).toEqual(page);
      expect(page.count).toBe(2);
      expect(page.items).toEqual([
        {
          categories: [
            {
              categoryRef: categoryRefOf(categoryId, tenantId),
              name: 'Kladiva',
            },
          ],
          lifecycle: 'ACTIVE',
          localized: { kind: 'PRESENT', locale: 'cs-CZ', name: 'Kladivo' },
          media: [{ assignment: mediaAssignment, ownerAvailability: 'UNVERIFIED' }],
          productRef: productRef(activeProductId),
          revision: 2,
          variants: [
            {
              lifecycle: 'ACTIVE',
              localized: { kind: 'MISSING_TRANSLATION', requestedLocale: 'cs-CZ' },
              options: [
                {
                  attributeDefinitionRef: {
                    moduleId: 'commerce.catalog',
                    resourceId: axisId,
                    resourceType: 'commerce.catalog.attribute-definition',
                    tenantId,
                  },
                  definitionRevision: 3,
                  values: [{ kind: 'TEXT', text: 'Červená' }],
                },
              ],
              sku: 'KL-500',
              variantRef: variantRef(activeVariantId),
            },
            {
              lifecycle: 'WORK_IN_PROGRESS',
              localized: { kind: 'MISSING_TRANSLATION', requestedLocale: 'cs-CZ' },
              options: [],
              variantRef: variantRef(workVariantId),
            },
          ],
        },
        {
          categories: [],
          lifecycle: 'DRAFT',
          localized: { kind: 'MISSING_TRANSLATION', requestedLocale: 'cs-CZ' },
          media: [],
          productRef: productRef(draftProductId),
          revision: 2,
          variants: [
            {
              lifecycle: 'WORK_IN_PROGRESS',
              localized: { description: 'Ocelové kladivo', kind: 'PRESENT', locale: 'cs-CZ', name: 'Kladivo 500 g' },
              options: [],
              variantRef: variantRef(importedVariantId),
            },
          ],
        },
      ]);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('refuses a Category of another Tenant and fails closed on an unanswerable lifecycle question', () =>
    Effect.gen(function* refusals() {
      const foreign = yield* Effect.flip(
        readProductPage(
          request({
            categoryRef: categoryRefOf(categoryId, foreignTenantId),
          }),
          tenantId,
          'allowed',
          services(),
        ),
      );
      expect(Schema.is(ReadHandlerNotFound)(foreign)).toBe(true);
      const unanswered = yield* Effect.flip(
        readProductPage(request({ lifecycles: ['RETIRED'] }), tenantId, 'unavailable', services()),
      );
      expect(Schema.is(ReadHandlerUnavailable)(unanswered)).toBe(true);
      const proposed = yield* Effect.flip(
        readProductPage(request({ lifecycles: ['RETIRED'] }), tenantId, 'needs_approval', services()),
      );
      expect(Schema.is(ReadPermissionDenied)(proposed)).toBe(true);
      const gone = yield* Effect.flip(
        readProductPage(request(), tenantId, 'denied', {
          ...services(),
          page: { ...services().page, productIds: () => Effect.succeed(['a0000000-0000-4000-8000-000000000009']) },
        }),
      );
      expect(Schema.is(ReadHandlerUnavailable)(gone)).toBe(true);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
