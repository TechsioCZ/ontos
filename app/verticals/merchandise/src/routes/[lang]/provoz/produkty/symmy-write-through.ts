// Staff price and stock edits of a product imported through Symmy, written to their owners first: the variant's base
// Price in Pricing (value-only revision under the staff source authority) and its on-hand in Inventory (a granted
// staff source assertion for an ERP-held position, else a receipt or an issue of the difference). The same owner
// operations and source semantics the former ERP editor used (catalog products-admin/erp-variant-editor.tsx), so
// Symmy reads the staff value back and an older import does not overwrite it. The merchandise row is saved only after
// this succeeds. The owner endpoints are declared locally, like catalog's erp-offer.ts reads, because merchandise does
// not depend on the Pricing, Inventory or Catalog packages.
import { issueGatewayContext, makeOperationGateway } from '@app/shared-contracts';
import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import { DateTime, Effect, Option, Random, Redacted, Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';

export interface SymmyWriteThroughInput {
  readonly catalogProductId: string;
  readonly catalogVariantId: string;
  /** The new base price without VAT as a decimal text (e.g. `7.33`); omitted when unchanged. */
  readonly priceNet?: string;
  /** The new absolute on-hand as a decimal text (e.g. `37`); omitted when unchanged. Exclusive with stockDelta. */
  readonly stockOnHand?: string;
  /**
   * A stock movement: the signed change applied to Inventory's CURRENT on-hand of the variant (never to the merchandise
   * figure, which can lag behind the ERP). Exclusive with stockOnHand.
   */
  readonly stockDelta?: number;
  /** The staff member's reason, kept in the owners' audit. */
  readonly reason: string;
}

const staffSource = 'ontos-staff-erp-editor';
const staffAuthority = { sourceAuthorityRef: staffSource, sourceAuthorityVersion: '1' } as const;
const staffMapping = { mappingContractRef: staffSource, mappingContractVersion: '1' } as const;
/** A fixed grant start, so a repeated grant for the same key is the same grant. */
const grantFrom = '2020-01-01T00:00:00.000Z';

const uuid = Effect.gen(function* fresh() {
  const hex = yield* Effect.forEach(Array.from({ length: 16 }), () => Random.nextIntBetween(0, 256));
  const bytes = hex.map((byte, index) => (index === 6 ? (byte & 0x0f) | 0x40 : index === 8 ? (byte & 0x3f) | 0x80 : byte));
  const text = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
});

/** One owner endpoint: the payload goes as JSON as it is, the answer is decoded where it is used. */
const endpointApi = (name: string, path: `/${string}`) =>
  HttpApi.make(`SymmyWriteThrough${name}`).add(
    HttpApiGroup.make('owner').add(
      HttpApiEndpoint.post('execute', path, {
        payload: Schema.Record(Schema.String, Schema.Unknown),
        success: Schema.Unknown,
      }),
    ),
  );

type Audience = 'catalog' | 'inventory' | 'pricing' | 'symmy-integration';

const gateways = {
  catalog: makeOperationGateway('catalog'),
  inventory: makeOperationGateway('inventory'),
  pricing: makeOperationGateway('pricing'),
  // A shop operator holds the Symmy stock-source read but not the Integrace panel, so the gateway asks the Shell
  // directly (as catalog's erp-offer.ts does); Symmy still decides the read for that person.
  'symmy-integration': makeOperationGateway('symmy-integration', (payload, options) =>
    issueGatewayContext(payload, options),
  ),
} as const;

const prefixes: Readonly<Record<Audience, string>> = {
  catalog: '/catalog-api',
  inventory: '/inventory-api',
  pricing: '/pricing-api',
  'symmy-integration': '/symmy-integration-api',
};

/** Calls one owner endpoint under a fresh Shell assertion; any failure becomes the step's Czech sentence. */
const call = (
  label: string,
  audience: Audience,
  path: `/${string}`,
  payload: Readonly<Record<string, unknown>>,
  idempotencyKey?: string,
) =>
  uuid.pipe(
    Effect.flatMap((requestCorrelation) =>
      gateways[audience].invoke((credential, { apiBaseUrl, compositionRevision }) =>
        makeGovernedEffectBffClient(
          {
            api: endpointApi(label.replace(/[^A-Za-z]/gu, ''), path),
            credential: Redacted.make(credential),
            defaultApiPrefix: prefixes[audience],
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
            requestCorrelation,
          },
          { baseUrl: apiBaseUrl, compositionRevision },
        ).pipe(
          Effect.flatMap((client) =>
client.owner.execute({ payload })
          ),
        ),
      ),
    ),
    Effect.mapError((problem) => {
      const tag = typeof problem === 'object' && problem !== null && '_tag' in problem ? String(problem._tag) : 'chyba';
      return `${label} se nepodařil (${tag})`;
    }),
  );

const decode =
  <S extends Schema.Top>(label: string, schema: S) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => `${label}: neočekávaná odpověď`));

const OwnerRefSchema = Schema.Struct({
  moduleId: Schema.String,
  resourceId: Schema.String,
  resourceType: Schema.String,
  tenantId: Schema.String,
});

const OfferScopesSchema = Schema.Struct({
  scopes: Schema.Array(
    Schema.Struct({
      channelId: Schema.String,
      currencyCode: Schema.String,
      marketId: Schema.String,
      unitId: Schema.String,
      unitQuantity: Schema.String,
    }),
  ),
});
const StockSourcesSchema = Schema.Struct({ customerConfigurationIds: Schema.Array(Schema.String) });

/** The ERP offer of the signed-in company: its one standing price scope and its one Symmy stock configuration. */
const readOffer = Effect.gen(function* offer() {
  const [scopes, sources] = yield* Effect.all(
    [
      call('Čtení cenového rozsahu', 'pricing', '/reads/external-price-source-scopes', {}).pipe(
        Effect.flatMap(decode('Čtení cenového rozsahu', OfferScopesSchema)),
      ),
      call('Čtení skladového zdroje', 'symmy-integration', '/reads/symmy-company-stock-source', {}).pipe(
        Effect.flatMap(decode('Čtení skladového zdroje', StockSourcesSchema)),
      ),
    ],
    { concurrency: 2 },
  );
  const [scope, ...otherScopes] = scopes.scopes;
  const [customerConfigurationId, ...otherSources] = sources.customerConfigurationIds;
  if (scope === undefined || otherScopes.length > 0) {
    return yield* Effect.fail('Firma nemá jednoznačný cenový rozsah ERP');
  }
  if (customerConfigurationId === undefined || otherSources.length > 0) {
    return yield* Effect.fail('Firma nemá jednoznačný skladový zdroj ERP');
  }
  return { ...scope, customerConfigurationId };
});

const ProductPageSchema = Schema.Struct({
  count: Schema.Number,
  items: Schema.Array(
    Schema.Struct({
      productRef: OwnerRefSchema,
      variants: Schema.Array(Schema.Struct({ variantRef: OwnerRefSchema })),
    }),
  ),
});
const pageSize = 100;

/**
 * The Catalog references of the variant (Pricing and Inventory key them with the tenant), page by page. The variant id
 * alone decides: a shop product linked to Symmy by SKU can hold variants of several Catalog products.
 */
const findCatalogRefs = (
  input: SymmyWriteThroughInput,
  offset = 0,
): Effect.Effect<{ productRef: typeof OwnerRefSchema.Type; variantRef: typeof OwnerRefSchema.Type }, string> =>
  call('Čtení produktu z ERP', 'catalog', '/reads/product-page', {
    lifecycles: ['DRAFT', 'ACTIVE', 'RETIRED'],
    limit: pageSize,
    locale: 'cs',
    offset,
  }).pipe(
    Effect.flatMap(decode('Čtení produktu z ERP', ProductPageSchema)),
    Effect.flatMap((page) => {
      const item = page.items.find(({ variants }) =>
        variants.some(({ variantRef }) => variantRef.resourceId === input.catalogVariantId),
      );
      const variant = item?.variants.find(({ variantRef }) => variantRef.resourceId === input.catalogVariantId);
      if (item !== undefined && variant !== undefined) {
        return Effect.succeed({ productRef: item.productRef, variantRef: variant.variantRef });
      }
      return page.items.length < pageSize || offset + pageSize >= page.count
        ? Effect.fail('Produkt z ERP nebyl v katalogu nalezen')
        : findCatalogRefs(input, offset + pageSize);
    }),
  );

type Offer = Effect.Success<typeof readOffer>;
type Refs = Effect.Success<ReturnType<typeof findCatalogRefs>>;

const MoneySchema = Schema.Struct({ amount: Schema.String, currencyCode: Schema.String });
const PagePricesSchema = Schema.Struct({
  _tag: Schema.String,
  prices: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        _tag: Schema.String,
        priceRef: Schema.optionalKey(Schema.Unknown),
        priceRevision: Schema.optionalKey(Schema.Struct({ monetaryAmount: MoneySchema })),
      }),
    ),
  ),
});
const ScheduleSchema = Schema.Struct({
  outcome: Schema.String,
  schedule: Schema.optionalKey(
    Schema.Struct({
      current: Schema.optionalKey(
        Schema.Struct({
          definition: Schema.Struct({
            identityKey: Schema.Struct({ currencyCode: Schema.String, unitBasis: Schema.Unknown }),
            revision: Schema.Struct({ revision: Schema.Unknown, revisionId: Schema.Unknown }),
          }),
          effectivePeriod: Schema.Struct({ effectiveFrom: Schema.String }),
        }),
      ),
      scheduleRevision: Schema.Unknown,
    }),
  ),
});
const ProposalSchema = Schema.Struct({ proposalId: Schema.optionalKey(Schema.Unknown) });

const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;
/** A canonical decimal text (no leading zeros, no trailing fractional zeros); null when it is no decimal. */
const canonical = (value: string): string | null => {
  const trimmed = value.trim().replace(',', '.');
  if (!decimalPattern.test(trimmed)) {
    return null;
  }
  return trimmed.includes('.') ? trimmed.replace(/0+$/u, '').replace(/\.$/u, '') : trimmed;
};

/** Pricing's Current Revision of the variant's base Price, revised value-only under the staff source authority. */
const writePrice = Effect.fn('SymmyWriteThrough.writePrice')(function* price(
  offer: Offer,
  refs: Refs,
  amount: string,
  reason: string,
) {
  const answer = yield* call('Čtení ceny', 'pricing', '/reads/catalog-page-prices', {
    channelId: offer.channelId,
    currencyCode: offer.currencyCode,
    items: [
      {
        catalogSelection: refs,
        unitBasis: {
          quantity: offer.unitQuantity,
          unitRef: {
            moduleId: 'commerce.catalog',
            resourceId: offer.unitId,
            resourceType: 'commerce.catalog.product-unit',
            tenantId: refs.productRef.tenantId,
          },
        },
      },
    ],
    marketId: offer.marketId,
  }).pipe(Effect.flatMap(decode('Čtení ceny', PagePricesSchema)));
  const found = answer.prices?.find(({ _tag }) => _tag === 'PRICE_FOUND');
  if (found?.priceRef === undefined || found.priceRevision === undefined) {
    return yield* Effect.fail('Varianta nemá v Cenách žádnou cenu, kterou by šlo změnit');
  }
  if (canonical(found.priceRevision.monetaryAmount.amount) === amount) {
    return;
  }
  const schedule = yield* call('Rozvrh ceny', 'pricing', '/reads/price-schedule', { priceRef: found.priceRef }).pipe(
    Effect.flatMap(decode('Rozvrh ceny', ScheduleSchema)),
  );
  const current = schedule.schedule?.current;
  if (schedule.outcome !== 'PRICE_SCHEDULE_CURRENT' || schedule.schedule === undefined || current === undefined) {
    return yield* Effect.fail(`Cena nemá platnou aktuální revizi (${schedule.outcome})`);
  }
  const { identityKey } = current.definition;
  const grant = yield* call(
    'Oprávnění zdroje ceny',
    'pricing',
    '/pricing/actions/grant-external-price-source-authority',
    {
      authority: staffAuthority,
      effectivePeriod: { effectiveFrom: grantFrom },
      exactIdentityKey: identityKey,
      mapping: staffMapping,
      reason,
      verificationRef: staffSource,
    },
    yield* uuid,
  ).pipe(Effect.flatMap(decode('Oprávnění zdroje ceny', ProposalSchema)));
  if (grant.proposalId !== undefined) {
    return yield* Effect.fail('Oprávnění zdroje ceny čeká na schválení');
  }
  // Pricing takes a value-only change at the stated effectiveFrom and requires the assertion's business time to be that
  // instant: not after the server's operation time (5 s back absorbs clock skew), not before the revision it replaces.
  const skewed = DateTime.subtract(yield* DateTime.now, { seconds: 5 });
  const currentFrom = DateTime.make(current.effectivePeriod.effectiveFrom);
  const at = DateTime.formatIso(
    Option.isSome(currentFrom) && DateTime.isLessThanOrEqualTo(skewed, currentFrom.value)
      ? DateTime.add(currentFrom.value, { milliseconds: 1 })
      : skewed,
  );
  const [sourceAssertionId, version, revisionKey] = yield* Effect.all([uuid, uuid, uuid]);
  const monetaryAmount = { amount, currencyCode: identityKey.currencyCode };
  const priceRef = found.priceRef as { readonly resourceId: string };
  const revised = yield* call(
    'Změna ceny',
    'pricing',
    '/pricing/actions/revise-price',
    {
      effectiveFrom: at,
      expectedCurrent: {
        effectivePeriod: current.effectivePeriod,
        priceRef,
        revision: current.definition.revision.revision,
        revisionId: current.definition.revision.revisionId,
        scheduleRevision: schedule.schedule.scheduleRevision,
      },
      intent: 'VALUE_ONLY_CURRENT',
      monetaryAmount,
      priceRef,
      reason,
      sourceAssertion: {
        lineage: { kind: 'INITIAL' },
        mapping: staffMapping,
        originalAssertion: { monetaryAmount, monetaryBoundary: 'PRE_TAX', unitBasis: identityKey.unitBasis },
        sourceAssertionId,
        sourceAuthority: staffAuthority,
        sourceRecord: {
          sourceChangeCorrelation: `ontos-admin:${version}`,
          sourceRecordRef: priceRef.resourceId,
          sourceRecordVersion: version,
          sourceSystem: { ownerModuleId: 'commerce.catalog', sourceSystemRef: staffSource },
        },
        timing: { importedAt: at, ownerBusinessEffectiveAt: at, sourceEffectiveAt: at },
      },
    },
    revisionKey,
  ).pipe(Effect.flatMap(decode('Změna ceny', ProposalSchema)));
  if (revised.proposalId !== undefined) {
    return yield* Effect.fail('Změna ceny čeká na schválení');
  }
});

const QuantitySchema = Schema.Struct({ amount: Schema.String });
const OnHandPageSchema = Schema.Struct({
  backend: Schema.Struct({ kind: Schema.String }),
  items: Schema.Array(
    Schema.Struct({
      outcome: Schema.String,
      positions: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            onHand: Schema.Struct({ _tag: Schema.String, quantity: Schema.optionalKey(QuantitySchema) }),
            positionRef: Schema.Unknown,
          }),
        ),
      ),
      stockItem: Schema.optionalKey(Schema.Struct({ stockItemRef: Schema.Unknown, unitRef: Schema.Unknown })),
      total: Schema.optionalKey(QuantitySchema),
    }),
  ),
});
const StockGrantSchema = Schema.Struct({
  coverageEffectIds: Schema.optionalKey(Schema.Array(Schema.String)),
  issuer: Schema.optionalKey(Schema.Unknown),
  itemExternalKey: Schema.optionalKey(Schema.Unknown),
  locationExternalKey: Schema.optionalKey(Schema.Unknown),
  orderingEvidence: Schema.optionalKey(Schema.Unknown),
  selectedAt: Schema.optionalKey(Schema.String),
});
const StockImportSchema = Schema.Struct({
  items: Schema.optionalKey(Schema.Array(Schema.Struct({ status: Schema.String }))),
});

/** Inventory's on-hand of the variant before and after a stock write; after is what the merchandise row must hold. */
export interface SymmyStockResult {
  readonly before: number;
  readonly after: number;
}

/**
 * Sets the on-hand of the variant's one Inventory Position, the way the former ERP editor did: an absolute target, or a
 * signed delta applied to Inventory's current on-hand (a movement), so the ERP balance is never replaced by an older
 * merchandise figure.
 */
const writeStock = Effect.fn('SymmyWriteThrough.writeStock')(function* stock(
  offer: Offer,
  refs: Refs,
  change: { readonly absolute: string } | { readonly delta: number },
  reason: string,
) {
  const page = yield* call('Čtení skladu', 'inventory', '/reads/catalog-variant-on-hand-page', {
    customerConfigurationId: offer.customerConfigurationId,
    variantRefs: [refs.variantRef],
  }).pipe(Effect.flatMap(decode('Čtení skladu', OnHandPageSchema)));
  const [answer] = page.items;
  const position = answer?.positions?.[0];
  if (
    answer === undefined ||
    (answer.outcome !== 'ON_HAND' && answer.outcome !== 'ON_HAND_UNKNOWN') ||
    position === undefined ||
    answer.stockItem === undefined
  ) {
    return yield* Effect.fail(`Varianta nemá skladovou pozici (${answer?.outcome ?? 'bez odpovědi'})`);
  }
  const known = answer.outcome === 'ON_HAND' && answer.total !== undefined ? Number(answer.total.amount) : undefined;
  if ('delta' in change && (known === undefined || !Number.isFinite(known))) {
    return yield* Effect.fail('Stav skladu v ERP není známý, pohyb nelze zapsat.');
  }
  const before = known ?? 0;
  const targetNumber = 'delta' in change ? Math.round((before + change.delta) * 1000) / 1000 : Number(change.absolute);
  if (targetNumber < 0) {
    return yield* Effect.fail(`Na skladě v ERP je jen ${before}, pohyb by stav snížil pod nulu.`);
  }
  const target = canonical(String(targetNumber)) ?? '0';
  const result: SymmyStockResult = { after: targetNumber, before };
  if (known !== undefined && canonical(String(known)) === target) {
    return result;
  }
  const why = reason.slice(0, 300).trim();
  if (page.backend.kind === 'external_business_system') {
    const grant = yield* call(
      'Oprávnění zdroje skladu',
      'inventory',
      '/inventory/actions/grant-staff-stock-source-authority',
      { customerConfigurationId: offer.customerConfigurationId, positionRef: position.positionRef, reason: why },
      yield* uuid,
    ).pipe(Effect.flatMap(decode('Oprávnění zdroje skladu', StockGrantSchema)));
    if (grant.issuer === undefined || grant.selectedAt === undefined) {
      return yield* Effect.fail('Oprávnění zdroje skladu čeká na schválení');
    }
    const now = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { seconds: 5 }));
    const at = now < grant.selectedAt ? grant.selectedAt : now;
    const [assertionId, evidence, importKey] = yield* Effect.all([uuid, uuid, uuid]);
    const imported = yield* call(
      'Zápis skladu',
      'inventory',
      '/inventory/actions/import-source-assertion',
      {
        authorizationTargetRef: position.positionRef,
        items: [
          {
            assertionId,
            businessObservedAt: at,
            coverage: (grant.coverageEffectIds ?? []).map((effectId) => ({
              assertionId,
              effectId,
              ownerEvidenceRef: `ontos-staff:${evidence}`,
              relation: 'INCLUDES',
            })),
            customerConfigurationId: offer.customerConfigurationId,
            factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
            issuer: grant.issuer,
            itemExternalKey: grant.itemExternalKey,
            locationExternalKey: grant.locationExternalKey,
            orderingEvidence: grant.orderingEvidence,
            ownerEvidenceRef: `ontos-staff:${evidence}`,
            positionRef: position.positionRef,
            quantity: { amount: target, unitRef: answer.stockItem.unitRef },
            receivedAt: at,
            sourceReference: `ontos-staff:${assertionId}`,
          },
        ],
      },
      importKey,
    ).pipe(Effect.flatMap(decode('Zápis skladu', StockImportSchema)));
    const outcome = imported.items?.[0];
    if (imported.items === undefined) {
      return yield* Effect.fail('Zápis skladu čeká na schválení');
    }
    if (outcome === undefined || outcome.status !== 'ACCEPTED') {
      return yield* Effect.fail(`Sklad nepřijal nový stav (${outcome?.status ?? 'bez odpovědi'})`);
    }
    return result;
  }
  // An OntOS-held position: a receipt or an issue of the difference (a movement's own delta).
  const current = Number(position.onHand.quantity?.amount ?? '0');
  const delta = 'delta' in change ? change.delta : Number(target) - current;
  if (delta === 0) {
    return result;
  }
  const amount = canonical(String(Math.abs(Math.round(delta * 1000) / 1000))) ?? '0';
  const [effectId, key] = yield* Effect.all([uuid, uuid]);
  const label = delta > 0 ? 'Příjem na sklad' : 'Výdej ze skladu';
  const done = yield* call(
    label,
    'inventory',
    delta > 0 ? '/inventory/actions/stock-receipt' : '/inventory/actions/stock-issue',
    {
      customerConfigurationId: offer.customerConfigurationId,
      effectId,
      positionRef: position.positionRef,
      quantity: { amount, unitRef: answer.stockItem.unitRef },
      reason: { code: delta > 0 ? 'STAFF_RECEIPT' : 'STAFF_ISSUE', reference: why },
      stockItemRef: answer.stockItem.stockItemRef,
    },
    key,
  ).pipe(Effect.flatMap(decode(label, ProposalSchema)));
  if (done.proposalId !== undefined) {
    return yield* Effect.fail(`${label} čeká na schválení`);
  }
  return result;
});

/** What a write-through answers: Inventory's figures when it wrote stock. */
export interface SymmyWriteThroughResult {
  readonly stock?: SymmyStockResult;
}
const noStock: SymmyWriteThroughResult = {};

/**
 * Writes a staff price and/or stock change of one Symmy-imported variant to Pricing and Inventory. Fails with a Czech
 * sentence for the editor when any owner refuses or cannot be reached; the caller then must not save the merchandise
 * row nor report success. A stock write answers Inventory's on-hand before and after it; the caller brings the
 * merchandise row to `after`. A price write never defines a price: a variant without one in Pricing fails.
 */
export const writeThroughSymmyVariant = Effect.fn('SymmyWriteThrough.variant')(function* writeThrough(
  input: SymmyWriteThroughInput,
) {
  const price = input.priceNet === undefined ? undefined : canonical(input.priceNet);
  const stock = input.stockOnHand === undefined ? undefined : canonical(input.stockOnHand);
  const { stockDelta } = input;
  if (price === null || stock === null || (stockDelta !== undefined && !Number.isFinite(stockDelta))) {
    return yield* Effect.fail('Cena i sklad musí být nezáporná čísla.');
  }
  if (stock !== undefined && stockDelta !== undefined) {
    return yield* Effect.fail('Sklad lze zapsat jen jako nový stav, nebo jako pohyb.');
  }
  const change =
    stock !== undefined ? { absolute: stock } : stockDelta !== undefined ? { delta: stockDelta } : undefined;
  if (price === undefined && change === undefined) {
    return noStock;
  }
  const reason = input.reason.trim() === '' ? 'Úprava ceny a skladu v Produktech' : input.reason.trim();
  const [offer, refs] = yield* Effect.all([readOffer, findCatalogRefs(input)], { concurrency: 2 });
  if (price !== undefined) {
    yield* writePrice(offer, refs, price, reason);
  }
  if (change === undefined) {
    return noStock;
  }
  const written: SymmyWriteThroughResult = { stock: yield* writeStock(offer, refs, change, reason) };
  return written;
});
