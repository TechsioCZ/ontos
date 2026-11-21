import { NodeCrypto } from '@effect/platform-node';
import {
  ReadHandlerNotFound,
  ReadPermissionDenied,
  TrustedPrincipalContextSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import { makeAccessDecisionService } from '@app/core-runtime/access/enforcement';
import type { AccessPrincipalKind, AccessWorkloadBindings } from '@app/core-runtime/access/enforcement';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { makeScriptedBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { Effect, Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CatalogVariantOnHandPageRequestSchema,
  CatalogVariantOnHandPageResponseSchema,
} from '../../shared/apis/catalog-variant-on-hand-page.ts';
import type { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';

import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import { InventorySourceAssertionSchema } from '../../shared/domain/inventory-source-assertion.ts';
import type { InventorySourceAssertion } from '../../shared/domain/inventory-source-assertion.ts';
import { PhysicalStockEffectRecordSchema } from '../../shared/domain/physical-stock-effect.ts';
import type { PhysicalStockEffectRecord } from '../../shared/domain/physical-stock-effect.ts';
import { StockPositionSchema } from '../../shared/domain/stock-position.ts';
import type { StockPosition, StockPositionOnHandEvidenceSchema } from '../../shared/domain/stock-position.ts';
import { catalogVariantOnHandPageRead } from '../../src/api/catalog-variant-on-hand-page.read.ts';
import {
  CatalogVariantBindingSchema,
  CatalogVariantPositionRowSchema,
} from '../../src/persistence/catalog-variant-on-hand-page-repository.ts';
import type {
  CatalogVariantBinding,
  CatalogVariantPositionRow,
} from '../../src/persistence/catalog-variant-on-hand-page-repository.ts';
import { readCatalogVariantOnHandPage } from '../../src/services/catalog-variant-on-hand-page.service.ts';
import type { CatalogVariantOnHandPageServices } from '../../src/services/catalog-variant-on-hand-page.service.ts';
import { inventoryRegistration } from '../../vertical.registration.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const configurationId = '44444444-4444-4444-8444-444444444444';
const customerConfigurationId = 'akros-shop';
const storefrontWorkload = 'commerce.storefront-client';
const selectedAt = '2026-11-01T08:00:00.000Z';
const observedAt = '2026-11-20T09:00:00.000Z';
const receivedAt = '2026-11-20T09:05:00.000Z';
const erp = { backendId: 'symmy-erp', backendKind: 'external_business_system' } as const;

const ref = <const ModuleId extends string, const ResourceType extends string>(
  moduleId: ModuleId,
  resourceType: ResourceType,
  resourceId: string,
) => ({
  moduleId,
  resourceId,
  resourceType,
  tenantId,
});
/** One distinct UUID per fixture role (the first hex digit) and number. */
const id = (role: string, n: number) => `${role}000000${n}-0000-4000-8000-000000000000`;
const unitRef = ref('commerce.catalog', 'commerce.catalog.product-unit', id('5', 0));
const variantRef = (n: number) => ref('commerce.catalog', 'commerce.catalog.variant', id('7', n));
const stockItemRef = (n: number) => ref('commerce.inventory', 'commerce.inventory.stock-item', id('8', n));
const locationRef = (n: number) => ref('commerce.inventory', 'commerce.inventory.stock-location', id('9', n));
const positionRef = (n: number) => ref('commerce.inventory', 'commerce.inventory.stock-position', id('a', n));
const ownerConfigurationRef = ref(
  'commerce.inventory',
  'commerce.inventory.inventory-backend-configuration',
  configurationId,
);

const configuration = (backend: 'external_business_system' | 'ontos_wms') =>
  Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
    configurationId,
    customerConfigurationId,
    revision: 1,
    selectedAt,
    selection: {
      backend,
      backendId: backend === 'ontos_wms' ? 'ontos-wms' : erp.backendId,
      exactReservationCapability: backend === 'ontos_wms' ? 'SUPPORTED' : 'UNSUPPORTED',
      stockCorrectionCapability: backend === 'ontos_wms' ? 'SUPPORTED' : 'UNSUPPORTED',
    },
    tenantId,
  });

/** A binding of Variant `variant` to Stock Item `item`; `selection` adds a Package of it. */
const binding = (
  variant: number,
  item: number,
  selection: Pick<typeof CatalogSelectionSchema.Encoded, 'packageOption'> = {},
) =>
  Schema.decodeUnknownSync(CatalogVariantBindingSchema)({
    catalogSelection: {
      productRef: ref('commerce.catalog', 'commerce.catalog.product', id('6', variant)),
      variantRef: variantRef(variant),
      ...selection,
    },
    stockItem: {
      bindingRef: ref('commerce.inventory', 'commerce.inventory.catalog-to-stock-binding', id('b', item)),
      exactSelectionMeaning: { id: `catalog-variant:${variant}:${item}`, kind: 'PRODUCT_VARIANT' },
      stockItemRef: stockItemRef(item),
      unitRef,
    },
  });

const unknownOnHand = { _tag: 'UNKNOWN', meaning: 'ON_HAND', ownerConfigurationRef, unitRef } as const;
const indeterminateOnHand = { ...unknownOnHand, _tag: 'INDETERMINATE' } as const;
const currentOnHand = (amount: string) =>
  ({
    _tag: 'CURRENT',
    evidenceRef: 'wms:count',
    meaning: 'ON_HAND',
    observedAt,
    ownerConfigurationRef,
    quantity: { amount, unitRef },
  }) as const;

interface PositionFixture {
  readonly position: StockPosition;
  readonly row: CatalogVariantPositionRow;
}

/** Position `n` of Stock Item `item` at Location `n`. */
const position = (
  n: number,
  item: number,
  onHand: typeof StockPositionOnHandEvidenceSchema.Encoded,
): PositionFixture => ({
  position: Schema.decodeUnknownSync(StockPositionSchema)({
    createdAt: selectedAt,
    endedAt: null,
    lifecycle: 'CURRENT',
    onHand,
    ref: positionRef(n),
    revision: 1,
    scope: { customerConfigurationId, stockItemRef: stockItemRef(item), stockLocationRef: locationRef(n), unitRef },
  }),
  row: Schema.decodeUnknownSync(CatalogVariantPositionRowSchema)({
    positionRef: positionRef(n),
    stockItemId: stockItemRef(item).resourceId,
    stockLocation: { displayName: `Sklad ${n}`, ref: locationRef(n) },
  }),
});

const externalKey = (identifierKind: 'ITEM' | 'LOCATION', externalValue: string) => ({
  customerConfigurationId,
  externalScope: 'akros',
  externalValue,
  identifierKind,
  issuer: erp,
  namespace: 'symmy-stock',
  tenantId,
});

/** The accepted absolute ON_HAND assertion the Symmy stock route imports for Position `n` of Stock Item `item`. */
const assertion = (
  n: number,
  item: number,
  amount: string,
  overrides: Partial<
    Pick<typeof InventorySourceAssertionSchema.Encoded, 'businessObservedAt' | 'issuerAuthority'>
  > = {},
) =>
  Schema.decodeUnknownSync(InventorySourceAssertionSchema)({
    assertionId: id('c', n),
    authorityConfiguration: configuration('external_business_system'),
    businessObservedAt: observedAt,
    coverage: [],
    customerConfigurationId,
    factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
    issuer: erp,
    issuerAuthority: 'SELECTED_BACKEND',
    itemCorrelationRef: ref('commerce.inventory', 'commerce.inventory.external-stock-correlation', id('d', n)),
    itemExternalKey: externalKey('ITEM', `ITEM-${item}`),
    locationCorrelationRef: ref('commerce.inventory', 'commerce.inventory.external-stock-correlation', id('e', n)),
    locationExternalKey: externalKey('LOCATION', `LOCATION-${n}`),
    orderingEvidence: { _tag: 'SOURCE_REVISION', revision: '7' },
    ownerEvidenceRef: `symmy-stock:${n}`,
    positionRef: positionRef(n),
    quantity: { amount, unitRef },
    receivedAt,
    sourceReference: `symmy:${n}`,
    stockItemRef: stockItemRef(item),
    stockLocationRef: locationRef(n),
    ...overrides,
  });

/** An applied Stock Issue OntOS knows of at Position `n`, which an assertion without coverage cannot account for. */
const materialIssue = (n: number, item: number) => {
  const backendConfigurationRef = ownerConfigurationRef;
  const effectId = id('f', n);
  return Schema.decodeUnknownSync(PhysicalStockEffectRecordSchema)({
    _tag: 'APPLIED',
    evidence: {
      appliedAt: '2026-11-20T08:30:00.000Z',
      backend: erp.backendKind,
      backendConfigurationRef,
      backendEvidenceRef: 'erp:issue:1',
      backendId: erp.backendId,
      effectId,
      issuer: erp.backendId,
      kind: 'ISSUE',
      positionRef: positionRef(n),
      quantity: { amount: '1', unitRef },
    },
    request: {
      actionInvocationId: id('1', n),
      backend: erp.backendKind,
      backendConfigurationRef,
      backendId: erp.backendId,
      customerConfigurationId,
      effectId,
      kind: 'ISSUE',
      legalEntityId,
      positionRef: positionRef(n),
      quantity: { amount: '1', unitRef },
      reason: { code: 'ORDER_FULFILLMENT', reference: 'order:1' },
      requestedAt: '2026-11-20T08:29:00.000Z',
      stockItemRef: stockItemRef(item),
      stockLocationRef: locationRef(n),
    },
  });
};

const owner = (input: {
  readonly assertions?: readonly InventorySourceAssertion[];
  readonly backend?: 'external_business_system' | 'ontos_wms';
  readonly bindings?: readonly CatalogVariantBinding[];
  readonly effects?: Readonly<Record<string, readonly PhysicalStockEffectRecord[]>>;
  readonly positions?: readonly PositionFixture[];
}): CatalogVariantOnHandPageServices => {
  const positions = input.positions ?? [];
  return {
    findConfiguration: (requested) =>
      Effect.succeed(
        requested === customerConfigurationId
          ? Option.some(configuration(input.backend ?? 'external_business_system'))
          : Option.none(),
      ),
    listBindings: () => Effect.succeed(input.bindings ?? []),
    listMaterialEffects: ({ resourceId }) => Effect.succeed(input.effects?.[resourceId] ?? []),
    listPositions: ({ stockItemIds }) =>
      Effect.succeed(positions.map(({ row }) => row).filter(({ stockItemId }) => stockItemIds.includes(stockItemId))),
    readLatestSourceAssertion: ({ resourceId }) =>
      Effect.succeed(
        Option.fromNullishOr(input.assertions?.find((candidate) => candidate.positionRef.resourceId === resourceId)),
      ),
    readPosition: ({ resourceId }) =>
      Effect.succeed(
        Option.fromNullishOr(positions.find((candidate) => candidate.row.positionRef.resourceId === resourceId)).pipe(
          Option.map((candidate) => candidate.position),
        ),
      ),
  };
};

const request = (...variants: readonly number[]) =>
  Schema.decodeUnknownSync(CatalogVariantOnHandPageRequestSchema)({
    customerConfigurationId,
    variantRefs: variants.map(variantRef),
  });
const read = (services: CatalogVariantOnHandPageServices, ...variants: readonly number[]) =>
  readCatalogVariantOnHandPage(request(...variants), services, { tenantId });

describe('Catalog Variant on-hand page', () => {
  it('declares the staff capability, the registered storefront workload and a required company', () => {
    const { descriptor } = catalogVariantOnHandPageRead;
    expect(descriptor.accessDeclaration).toMatchObject({
      key: 'commerce.inventory.catalog-variant-on-hand-page.read',
      kind: 'read',
      modes: ['run'],
      risk: 'routine',
      selectors: [],
    });
    expect(descriptor.accessWorkload?.workloads).toEqual([storefrontWorkload]);
    expect(descriptor.legalEntityScope).toBe('required');
  });

  it('bounds the page and names each Variant once', () => {
    const decode = Schema.decodeUnknownResult(CatalogVariantOnHandPageRequestSchema);
    expect(Result.isFailure(decode({ customerConfigurationId, variantRefs: [] }))).toBe(true);
    expect(Result.isFailure(decode({ customerConfigurationId, variantRefs: [variantRef(1), variantRef(1)] }))).toBe(
      true,
    );
    const page = Array.from({ length: 101 }, (_, index) =>
      ref('commerce.catalog', 'commerce.catalog.variant', `70000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
    );
    expect(Result.isFailure(decode({ customerConfigurationId, variantRefs: page }))).toBe(true);
    expect(Result.isSuccess(decode({ customerConfigurationId, variantRefs: page.slice(0, 100) }))).toBe(true);
  });

  it.effect('sums the accepted ERP figures of two Locations and keeps each one with its source and receipt times', () =>
    Effect.gen(function* twoLocations() {
      const result = yield* read(
        owner({
          assertions: [assertion(1, 1, '12'), assertion(2, 1, '3.5')],
          bindings: [binding(1, 1)],
          positions: [position(1, 1, unknownOnHand), position(2, 1, unknownOnHand)],
        }),
        1,
      );
      expect(result).toMatchObject({
        backend: { backendId: erp.backendId, kind: erp.backendKind },
        purpose: 'INFORMATIONAL_DISPLAY',
        sharingEligibility: 'NOT_EVALUATED',
      });
      expect(result.items).toEqual([
        {
          outcome: 'ON_HAND',
          positions: [
            {
              onHand: {
                _tag: 'SOURCE_REPORTED',
                quantity: { amount: '12', unitRef },
                receivedAt,
                sourceObservedAt: observedAt,
              },
              positionRef: positionRef(1),
              stockLocation: { displayName: 'Sklad 1', ref: locationRef(1) },
            },
            {
              onHand: {
                _tag: 'SOURCE_REPORTED',
                quantity: { amount: '3.5', unitRef },
                receivedAt,
                sourceObservedAt: observedAt,
              },
              positionRef: positionRef(2),
              stockLocation: { displayName: 'Sklad 2', ref: locationRef(2) },
            },
          ],
          stockItem: binding(1, 1).stockItem,
          total: { amount: '15.5', unitRef },
          variantRef: variantRef(1),
        },
      ]);
      expect(Schema.is(CatalogVariantOnHandPageResponseSchema)(result)).toBe(true);
    }),
  );

  it.effect('names each Variant without a figure by its reason, never as zero, in request order', () =>
    Effect.gen(function* reasons() {
      const result = yield* read(
        owner({
          assertions: [assertion(3, 3, '4')],
          bindings: [
            // A Package of Variant 1 is another selection: Variant 1 itself has no Stock Item.
            binding(1, 1, {
              packageOption: {
                contentRevision: {
                  resourceRef: ref('commerce.catalog', 'commerce.catalog.package-definition', id('2', 1)),
                  revision: 1,
                },
                optionRef: ref('commerce.catalog', 'commerce.catalog.package-definition', id('2', 1)),
              },
            }),
            binding(2, 2),
            binding(3, 3),
            binding(4, 4),
            binding(4, 5),
          ],
          positions: [position(3, 3, unknownOnHand), position(4, 3, unknownOnHand)],
        }),
        1,
        2,
        3,
        4,
        5,
      );
      expect(result.items.map(({ outcome }) => outcome)).toEqual([
        'NO_STOCK_ITEM',
        'NO_POSITION',
        'ON_HAND_UNKNOWN',
        'CONFLICTING_BINDINGS',
        'NO_STOCK_ITEM',
      ]);
      expect(result.items[2]).toMatchObject({
        positions: [
          { onHand: { _tag: 'SOURCE_REPORTED', quantity: { amount: '4', unitRef } }, positionRef: positionRef(3) },
          { onHand: { _tag: 'NOT_ESTABLISHED', state: 'UNKNOWN' }, positionRef: positionRef(4) },
        ],
      });
      expect(result.items[2]).not.toHaveProperty('total');
      expect(result.items[3]).toMatchObject({ stockItemRefs: [stockItemRef(4), stockItemRef(5)] });
    }),
  );

  it.effect('shows no earlier figure over an open source conflict and reads no assertion for it', () =>
    Effect.gen(function* conflict() {
      const services = owner({
        assertions: [assertion(1, 1, '12')],
        bindings: [binding(1, 1)],
        positions: [position(1, 1, indeterminateOnHand)],
      });
      const result = yield* read(
        { ...services, readLatestSourceAssertion: () => Effect.die('An INDETERMINATE Position reads no assertion') },
        1,
      );
      expect(result.items[0]).toMatchObject({
        outcome: 'ON_HAND_UNKNOWN',
        positions: [{ onHand: { _tag: 'NOT_ESTABLISHED', state: 'INDETERMINATE' } }],
      });
    }),
  );

  it.effect('keeps an uncovered physical effect INDETERMINATE and a pre-cutover figure STALE', () =>
    Effect.gen(function* coverage() {
      const result = yield* read(
        owner({
          assertions: [
            assertion(1, 1, '12'),
            assertion(2, 2, '9', {
              businessObservedAt: '2026-10-31T23:00:00.000Z',
              issuerAuthority: 'HISTORICAL_PRE_CUTOVER_ISSUER',
            }),
          ],
          bindings: [binding(1, 1), binding(2, 2)],
          effects: { [positionRef(1).resourceId]: [materialIssue(1, 1)] },
          positions: [position(1, 1, unknownOnHand), position(2, 2, unknownOnHand)],
        }),
        1,
        2,
      );
      expect(result.items.map((item) => ('positions' in item ? item.positions[0].onHand : undefined))).toEqual([
        { _tag: 'NOT_ESTABLISHED', state: 'INDETERMINATE' },
        { _tag: 'NOT_ESTABLISHED', state: 'STALE' },
      ]);
    }),
  );

  it.effect('reports the OntOS WMS Current ON_HAND and its other Stock Evidence states', () =>
    Effect.gen(function* wms() {
      const services = owner({
        backend: 'ontos_wms',
        bindings: [binding(1, 1), binding(2, 2)],
        positions: [position(1, 1, currentOnHand('0')), position(2, 2, unknownOnHand)],
      });
      const result = yield* read(
        { ...services, readLatestSourceAssertion: () => Effect.die('The OntOS WMS reads no Source Assertion') },
        1,
        2,
      );
      expect(result.backend).toEqual({ backendId: 'ontos-wms', kind: 'ontos_wms' });
      expect(result.items).toMatchObject([
        {
          outcome: 'ON_HAND',
          positions: [{ onHand: { _tag: 'OWNER_RECORDED', observedAt, quantity: { amount: '0', unitRef } } }],
          total: { amount: '0', unitRef },
        },
        { outcome: 'ON_HAND_UNKNOWN', positions: [{ onHand: { _tag: 'NOT_ESTABLISHED', state: 'UNKNOWN' } }] },
      ]);
    }),
  );

  it.effect('refuses a Variant of another Tenant and a Customer Configuration without a selected backend', () =>
    Effect.gen(function* notFound() {
      const services = owner({});
      const foreign = Schema.decodeUnknownSync(CatalogVariantOnHandPageRequestSchema)({
        customerConfigurationId,
        variantRefs: [{ ...variantRef(1), tenantId: '99999999-9999-4999-8999-999999999999' }],
      });
      const foreignTenant = yield* readCatalogVariantOnHandPage(foreign, services, { tenantId }).pipe(Effect.flip);
      expect(Schema.is(ReadHandlerNotFound)(foreignTenant)).toBe(true);
      const otherConfiguration = yield* readCatalogVariantOnHandPage(
        {
          ...request(1),
          customerConfigurationId: Schema.decodeUnknownSync(
            CatalogVariantOnHandPageRequestSchema.fields.customerConfigurationId,
          )('other-shop'),
        },
        services,
        { tenantId },
      ).pipe(Effect.flip);
      expect(Schema.is(ReadHandlerNotFound)(otherConfiguration)).toBe(true);
    }),
  );
});

/** The trusted scope of the storefront BFF's direct API-key request: a service principal of one company. */
const storefrontScope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '44444444-4444-4444-8444-444444444444',
    authContextRef: 'api-key:catalog-variant-on-hand-page',
    authMethod: 'api_key',
    legalEntityId,
    principalId,
    tenantId,
  }),
  correlationId: 'catalog-variant-on-hand-page-admission',
};

const gateFor = (options: { readonly boundWorkloadKeys?: readonly string[]; readonly kind: AccessPrincipalKind }) => {
  const workloadBindings: AccessWorkloadBindings = {
    readWorkloadAuthority: () =>
      Effect.succeed({
        activeCompanyIds: new Set([LegalEntityIdSchema.make(legalEntityId)]),
        workloadKeys: new Set(options.boundWorkloadKeys),
      }),
  };
  return makeAccessDecisionService({
    authorityFor: () => ({
      readCells: () => Effect.die('Only a human decision reads authority cells'),
      readCompanyOwnership: () => Effect.succeed(true),
      readConnection: () => Effect.die('Only an agent decision reads a connection'),
      readScope: () => Effect.succeed(Option.none()),
      readTeamIds: () => Effect.die('Only a human decision reads team ids'),
    }),
    check: { checkBulk: () => Effect.die('A workload admission never asks the v2 engine') },
    decisionLog: { record: () => Effect.die('A workload decision is never a v2 evidence row') },
    legalEntities: { listCandidateIds: () => Effect.die('A workload admission never lists companies') },
    principalKinds: { readKind: () => Effect.succeed(Option.some(options.kind)) },
    workloadBindings,
  });
};

const question = {
  carrier: {
    accessDeclaration: catalogVariantOnHandPageRead.descriptor.accessDeclaration,
    accessWorkload: catalogVariantOnHandPageRead.descriptor.accessWorkload,
  },
  legalEntityScope: 'required' as const,
  now: new Date('2026-11-21T00:00:00.000Z'),
  scope: storefrontScope,
};

describe('Catalog Variant on-hand page admission', () => {
  it.effect('admits the service principal bound to the storefront workload', () =>
    Effect.gen(function* bound() {
      const decision = yield* gateFor({ boundWorkloadKeys: [storefrontWorkload], kind: 'service' }).decide(question);
      expect(decision.reasons.map(({ code }) => code)).toEqual(['allow.workload']);
    }),
  );

  it.effect('refuses an unbound service principal and one bound to another workload', () =>
    Effect.gen(function* unbound() {
      for (const boundWorkloadKeys of [[], ['demo.storefront-client']]) {
        const decision = yield* gateFor({ boundWorkloadKeys, kind: 'service' }).decide(question);
        expect(decision.outcome).toBe('DENIED');
        expect(decision.reasons.map(({ code }) => code)).toEqual(['deny.workload_unbound']);
      }
    }),
  );

  it.effect('keeps a person on the declaration path and never reads the workload registry', () =>
    Effect.gen(function* person() {
      const decision = yield* gateFor({ kind: 'human' }).decide(question);
      expect(decision.outcome).toBe('DENIED');
      expect(decision.reasons.map(({ code }) => code)).not.toContain('allow.workload');
    }),
  );
});

it.layer(NodeCrypto.layer)('Catalog Variant on-hand page governed runtime', (suite) => {
  suite.effect('a refused caller never reaches the owner queries', () =>
    Effect.gen(function* refused() {
      const scope = trustVerifiedGatewayPrincipalContext(
        {
          authBindingId: principalId,
          authContextRef: 'better-auth-session:test',
          authMethod: 'session',
          correlationId: 'catalog-variant-on-hand-page-refused',
          legalEntityId,
          principalId,
          tenantId,
        },
        'a'.repeat(64),
      );
      const gate = makeScriptedBoundAccessGate('denied');
      const harness = yield* makeReadTestHarness({
        accessDecision: gate.bound,
        compositionRevision: 'a'.repeat(64),
        executeOwnerQuery: () => Effect.die('A refused read must not query owner data'),
        operationTime: new Date('2026-11-21T00:00:00.000Z'),
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: inventoryRegistration,
        scope,
      });
      const failure = yield* harness.runtime
        .runRead({
          input: Schema.encodeSync(CatalogVariantOnHandPageRequestSchema)(request(1)),
          principal: scope,
          registration: catalogVariantOnHandPageRead,
          transport: { correlationId: scope.correlationId },
        })
        .pipe(Effect.flip);
      expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
      expect(gate.accessDecision.askedDecisions[0]?.carrier.accessDeclaration).toEqual(
        catalogVariantOnHandPageRead.descriptor.accessDeclaration,
      );
      expect(harness.snapshot().ownerQueries).toEqual([]);
    }),
  );
});
