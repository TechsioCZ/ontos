#!/usr/bin/env node
/**
 * Live HTTP acceptance, not a seed. Importing this module does not perform I/O.
 * The parent supplies endpoint/env wiring and explicitly executes a runner to create scoped demo records.
 * No orders, invoices, mail, database access, native services, or cleanup deletes are performed here.
 *
 * Public payload sources:
 * apps/shell-super-app/api/symmy/{products,customers,stock,price-lists-batch-upsert,
 * price-lists-prices-batch}-request-contract.ts and customer-groups-batch-request-contract.ts.
 * Receipt semantics: packages/shared-contracts/src/symmy/outcomes.ts and symmy/contract.ts.
 * Only the response fields used by this outside proof are decoded below. Importing the full server
 * schema graph would load unrelated server modules into this standalone operator command.
 */
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { Redacted, Schema } from 'effect';

const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const uuid = Schema.String.check(Schema.isUUID());
const RefSchema = Schema.Struct({
  moduleId: text,
  resourceId: uuid,
  resourceType: text,
  tenantId: uuid,
});
export type ProofRef = typeof RefSchema.Type;
const accepted = Schema.Literals(['accepted_change', 'accepted_no_change']);
const EffectSchema = Schema.Union([
  Schema.Struct({ effectId: uuid, owner: text, status: accepted }),
  Schema.Struct({ effectId: uuid, originalStatus: accepted, owner: text, status: Schema.Literal('duplicate') }),
  Schema.Struct({
    effectId: Schema.optionalKey(uuid),
    owner: text,
    status: Schema.Literals([
      'waiting', 'executing', 'indeterminate', 'unsupported', 'stale', 'unresolved',
      'ambiguous', 'denied', 'conflict', 'unavailable', 'invalid',
    ]),
  }),
]);
const ItemSchema = Schema.Struct({
  effects: Schema.NonEmptyArray(EffectSchema),
  itemId: uuid,
  outcome: Schema.Literals(['accepted', 'partial', 'not_accepted']),
});
const ItemsSchema = Schema.Struct({ items: Schema.NonEmptyArray(ItemSchema) });
type Items = typeof ItemsSchema.Type;
const AdmissionSchema = Schema.Struct({ jobId: uuid, status: Schema.Literal('queued') });
const JobSchema = Schema.Struct({
  items: Schema.optionalKey(Schema.Array(ItemSchema)),
  jobId: uuid,
  status: Schema.Literals([
    'queued', 'running', 'blocked', 'indeterminate', 'completed_all', 'completed_partial', 'completed_none',
  ]),
});
const ProductPageSchema = Schema.Struct({
  count: Schema.Int,
  products: Schema.Array(Schema.Struct({
    id: text,
    product: Schema.Struct({
      name: Schema.optionalKey(text),
      productRef: RefSchema,
      variants: Schema.Array(Schema.Struct({ variantId: uuid, variantRef: RefSchema })),
    }),
    sourceRecordId: text,
    variantSources: Schema.Array(Schema.Struct({ sourceRecordId: text, variantId: uuid })),
  })),
});
const PREFIX = '/api/symmy/v1';
const MAX_RESPONSE_BYTES = 2_000_000;
/** Published Akros stage example refs, not per-item grants or stock seeds. */
export const AKROS_STAGE_PROOF_INPUT = {
  commercialScope: { channelId: 'B2C', marketId: 'e57c614d-3911-5a52-941e-29168b1db5e4' },
  currencyCode: 'CZK',
  locationKey: 'AKROS-SKLAD-1',
  unitRef: {
    moduleId: 'commerce.catalog',
    resourceId: '43d5c797-2b36-4877-85ad-caac3a674d9c',
    resourceType: 'commerce.catalog.product-unit',
    tenantId: 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9',
  },
} satisfies SymmyProofInput;

export const SymmyProofInputSchema = Schema.Struct({
  commercialScope: Schema.Struct({
    channelId: Schema.Literals(['B2C', 'B2B']),
    marketId: text,
  }),
  currencyCode: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/u)),
  locationKey: text,
  unitRef: RefSchema,
});
export type SymmyProofInput = typeof SymmyProofInputSchema.Type;
export interface SymmyProofConfig {
  readonly origin: string;
  readonly apiKey: Redacted.Redacted<string>;
  readonly input: SymmyProofInput;
  /** Whole-run budget; all fetches and polling share it. Defaults to ten minutes. */
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}
export type ProofBoundary =
  | 'configuration' | 'product-unseen' | 'product-import' | 'product-readback' | 'product-replay'
  | 'sku-readback' | 'base-price-readback' | 'stock-import' | 'stock-readback' | 'price-list-import'
  | 'price-list-readback' | 'list-price-import' | 'list-price-readback'
  | 'customer-import' | 'customer-readback' | 'customer-replay' | 'address-readback'
  | 'group-import' | 'group-assignment' | 'group-replay' | 'group-readback'
  | 'category-import' | 'category-readback' | 'image-import' | 'image-readback'
  | 'order-export' | 'full-proof';
type FailureCode =
  | 'input-contract' | 'schema' | 'network' | 'timeout' | 'response-too-large' | 'redirect'
  | 'http-status' | 'job-identity' | 'job-terminal' | 'item-count' | 'effect-count'
  | 'effect-outcome' | 'effect-owner' | 'replay-identity' | 'readback' | 'not-unseen'
  | 'missing-wiring' | 'unsafe-path' | 'unexpected';

/** Contains only fixed boundary/code strings and an optional numeric HTTP status, never a body or cause. */
export class SymmyProofFailure extends Error {
  readonly boundary: ProofBoundary;
  readonly code: FailureCode;
  readonly status: number | undefined;
  constructor(boundary: ProofBoundary, code: FailureCode, status?: number) {
    super(`FAIL ${boundary}:${code}${status === undefined ? '' : `:${status}`}`);
    this.name = 'SymmyProofFailure';
    this.boundary = boundary;
    this.code = code;
    this.status = status;
  }
}
function ensure(condition: unknown, boundary: ProofBoundary, code: FailureCode): asserts condition {
  if (!condition) throw new SymmyProofFailure(boundary, code);
}
function decode<A>(schema: Schema.ConstraintDecoder<A>, body: unknown, boundary: ProofBoundary): A {
  try {
    return Schema.decodeUnknownSync(schema)(body);
  } catch {
    throw new SymmyProofFailure(boundary, 'schema');
  }
}
export interface EffectExpectation {
  readonly itemsAtLeast: number;
  readonly effectsAtLeast: number;
  readonly owners: Readonly<Record<string, number>>;
}
export function assertAcceptedEffects(
  body: unknown,
  expected: EffectExpectation,
  boundary: ProofBoundary,
): Items {
  ensure(
    Number.isInteger(expected.itemsAtLeast) && expected.itemsAtLeast > 0 &&
    Number.isInteger(expected.effectsAtLeast) && expected.effectsAtLeast > 0 &&
    Object.keys(expected.owners).length > 0 &&
    Object.values(expected.owners).every((count) => Number.isInteger(count) && count > 0),
    boundary, 'input-contract',
  );
  const result = decode(ItemsSchema, body, boundary);
  ensure(result.items.length >= expected.itemsAtLeast, boundary, 'item-count');
  const effects = result.items.flatMap((item) => {
    ensure(item.outcome === 'accepted', boundary, 'effect-outcome');
    return item.effects;
  });
  ensure(effects.length >= expected.effectsAtLeast, boundary, 'effect-count');
  for (const effect of effects) {
    ensure(
      effect.status === 'accepted_change' || effect.status === 'accepted_no_change' || effect.status === 'duplicate',
      boundary, 'effect-outcome',
    );
  }
  for (const [owner, count] of Object.entries(expected.owners)) {
    ensure(effects.filter((effect) => effect.owner === owner).length >= count, boundary, 'effect-owner');
  }
  return result;
}
export function assertReplayIdentity(original: Items, replay: Items, boundary: ProofBoundary): void {
  const identity = (result: Items) => result.items.map((item) => ({
    effects: item.effects.map((effect) => ({
      effectId: effect.effectId, owner: effect.owner,
    })).toSorted((a, b) => (a.effectId ?? '').localeCompare(b.effectId ?? '')),
    itemId: item.itemId,
  })).toSorted((a, b) => a.itemId.localeCompare(b.itemId));
  ensure(isDeepStrictEqual(identity(original), identity(replay)), boundary, 'replay-identity');
}
export function makeSymmyProofNames() {
  const prefix = `SP_${randomUUID().replaceAll('-', '').toUpperCase()}`;
  return {
    prefix,
    product: `${prefix}_PRODUCT`,
    variant: `${prefix}_VARIANT`,
    organization: `${prefix}_ORG`,
    person: `${prefix}_PERSON`,
    group: `${prefix}_GROUP`,
    list: `${prefix}_LIST`,
    category: `${prefix}_CATEGORY`,
    image: `${prefix}_IMAGE`,
  };
}
export type SymmyProofNames = ReturnType<typeof makeSymmyProofNames>;
export interface SymmyProductProof {
  readonly names: SymmyProofNames;
  readonly productRef: ProofRef;
  readonly variantRef: ProofRef;
  readonly baseAmount: string;
  readonly stockAmount: string;
  readonly listAmount: string;
  readonly effectiveFrom: string;
}
const PriceListsPageSchema = Schema.Struct({
  count: Schema.Int,
  priceLists: Schema.Array(Schema.Struct({
    code: text,
    name: text,
    priceGroupRef: RefSchema,
    prices: Schema.optionalKey(Schema.Struct({
      count: Schema.Int,
      prices: Schema.Array(Schema.Struct({ price: Schema.Unknown })),
    })),
  })),
});
const CurrentPriceSchema = Schema.Struct({
  definition: Schema.Struct({
    identityKey: Schema.Struct({
      catalogSelection: Schema.Struct({ productRef: RefSchema, variantRef: RefSchema }),
      commercialScope: Schema.Struct({ channelId: text, marketId: text }),
      priceGroupSelector: Schema.Struct({ kind: Schema.Literal('PRICE_GROUP'), priceGroupRef: RefSchema }),
      unitBasis: Schema.Struct({ quantity: text, unitRef: RefSchema }),
    }),
    priceRef: RefSchema,
    revision: Schema.Struct({
      effectiveFrom: text,
      monetaryAmount: Schema.Struct({ amount: text, currencyCode: text }),
      revision: Schema.Int,
      revisionId: uuid,
    }),
  }),
  outcome: Schema.Literal('PRICE_DEFINITION_CURRENT'),
});
export interface SymmyCommerceProof extends SymmyProductProof {
  readonly priceGroupRef: ProofRef;
}
const PRICE_EFFECTS = {
  effectsAtLeast: 1, itemsAtLeast: 1, owners: { 'commerce.pricing': 1 },
} satisfies EffectExpectation;
export async function proveSymmyProductStockList(
  config: SymmyProofConfig,
  client: SymmyProofClient = createSymmyProofClient(config),
): Promise<SymmyCommerceProof> {
  const proof = await proveSymmyProduct(config, client);
  const { input } = config;
  const stockBody = {
    stock: [{
      businessObservedAt: new Date().toISOString(),
      itemKey: proof.names.variant,
      locationKey: input.locationKey,
      quantity: { amount: proof.stockAmount, unitRef: input.unitRef },
      revision: '1',
      sourceReference: `${proof.names.prefix}:stock:1`,
    }],
  };
  const stockResult = await client.write(
    `${PREFIX}/inventory/stock/batch`, stockBody, `${proof.names.prefix}.stock`, 'stock-import',
  );
  await client.settle(stockResult, {
    effectsAtLeast: 1, itemsAtLeast: 1, owners: { 'commerce.inventory': 1 },
  }, 'stock-import');
  const stockKeys = decode(Schema.Struct({
    items: Schema.NonEmptyArray(Schema.Struct({ itemKey: text, locationKey: text })),
  }), stockResult.body, 'stock-import');
  ensure(
    stockKeys.items.length === 1 && stockKeys.items[0]?.itemKey === proof.names.variant &&
    stockKeys.items[0]?.locationKey === input.locationKey,
    'stock-import', 'readback',
  );
  // The Price Group owner requires creation in the future; do not reuse the product timestamp after a slow job.
  const startsAt = new Date(Date.now() + 120_000).toISOString();
  const listBody = {
    priceLists: [{
      businessCode: proof.names.list, code: proof.names.list,
      description: `${proof.names.prefix} acceptance price list`,
      effectiveFrom: startsAt, name: proof.names.list,
      purpose: 'Scoped Symmy HTTP acceptance price list',
    }],
  };
  await client.settle(await client.write(
    `${PREFIX}/price-lists/batch-upsert`, listBody, `${proof.names.prefix}.list`, 'price-list-import',
  ), { effectsAtLeast: 1, itemsAtLeast: 1, owners: { 'pricing.price-group-catalog': 1 } }, 'price-list-import');
  const findList = async (boundary: 'price-list-readback' | 'list-price-readback') => {
    // Public GET /price-lists has no code/q filter. Bound the scan; never dump existing price/customer data.
    for (let offset = 0; offset < 2000; offset += 100) {
      const page = decode(PriceListsPageSchema, await client.read(
        `${PREFIX}/price-lists?limit=100&offset=${offset}&priceLimit=100`, boundary,
      ), boundary);
      const matches = page.priceLists.filter((list) => list.code === proof.names.list);
      ensure(matches.length <= 1, boundary, 'readback');
      if (matches[0] !== undefined) return matches[0];
      if (offset + 100 >= page.count) break;
    }
    throw new SymmyProofFailure(boundary, 'readback');
  };
  const list = await findList('price-list-readback');
  ensure(
    list.name === proof.names.list && list.priceGroupRef.tenantId === proof.productRef.tenantId,
    'price-list-readback', 'readback',
  );
  const priceBody = {
    priceGroupRef: list.priceGroupRef,
    prices: [{
      amount: proof.listAmount, commercialScope: input.commercialScope, currencyCode: input.currencyCode,
      effectiveFrom: startsAt, operation: 'DEFINE', productRef: proof.productRef,
      unitBasis: { quantity: '1', unitRef: input.unitRef }, variantRef: proof.variantRef,
    }],
  };
  const key = `${proof.names.prefix}.list-price`;
  const original = await client.settle(await client.write(
    `${PREFIX}/price-lists/prices/batch`, priceBody, key, 'list-price-import',
  ), PRICE_EFFECTS, 'list-price-import');
  const readback = await findList('list-price-readback');
  ensure(
    readback.prices !== undefined && readback.prices.count === 1 && readback.prices.prices.length === 1,
    'list-price-readback', 'readback',
  );
  const stored = decode(CurrentPriceSchema, readback.prices.prices[0]?.price, 'list-price-readback');
  const identity = stored.definition.identityKey;
  ensure(
    isDeepStrictEqual(identity.catalogSelection, { productRef: proof.productRef, variantRef: proof.variantRef }) &&
    identity.priceGroupSelector.priceGroupRef.resourceId === list.priceGroupRef.resourceId &&
    identity.commercialScope.channelId === input.commercialScope.channelId &&
    identity.commercialScope.marketId === input.commercialScope.marketId &&
    isDeepStrictEqual(identity.unitBasis, { quantity: '1', unitRef: input.unitRef }) &&
    decimalEqual(stored.definition.revision.monetaryAmount.amount, proof.listAmount) &&
    stored.definition.revision.monetaryAmount.currencyCode === input.currencyCode &&
    stored.definition.revision.effectiveFrom === startsAt,
    'list-price-readback', 'readback',
  );
  const replay = await client.settle(await client.write(
    `${PREFIX}/price-lists/prices/batch`, priceBody, key, 'list-price-import',
  ), PRICE_EFFECTS, 'list-price-import');
  assertReplayIdentity(original, replay, 'list-price-import');
  const after = await findList('list-price-readback');
  ensure(
    after.prices !== undefined && after.prices.count === 1 && after.prices.prices.length === 1 &&
    isDeepStrictEqual(after.priceGroupRef, readback.priceGroupRef) &&
    isDeepStrictEqual(decode(CurrentPriceSchema, after.prices.prices[0]?.price, 'list-price-readback'), stored),
    'list-price-readback', 'readback',
  );
  return { ...proof, priceGroupRef: list.priceGroupRef };
}

/** Exact decimal comparison without binary floating point or accepting malformed decimal inputs. */
export function decimalEqual(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown) => {
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return undefined;
    return value.includes('.') ? value.replace(/0+$/u, '').replace(/\.$/u, '') : value;
  };
  const a = canonical(left);
  return a !== undefined && a === canonical(right);
}

/**
 * Explicit adapter contract for worker endpoints not present in the original public Symmy surface.
 * The parent supplies documented paths and JSON pointers, not a boolean "passed" callback.
 * Each read must contain exactly one record matching ALL proof-owned expected fields.
 * `recordsPointer: ''` accepts a single root object or root array.
 */
export interface SymmyRecordRead<Field extends string> {
  readonly path: string;
  readonly recordsPointer: string;
  readonly fields: Readonly<Record<Field, string>>;
}
function atPointer(value: unknown, pointer: string, boundary: ProofBoundary): unknown {
  ensure(pointer === '' || /^\/(?:[^~]|~[01])*$/u.test(pointer), boundary, 'input-contract');
  let current = value;
  for (const part of pointer === '' ? [] : pointer.slice(1).split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    ensure(
      typeof current === 'object' && current !== null && Object.hasOwn(current, key),
      boundary, 'readback',
    );
    current = Reflect.get(current, key);
  }
  return current;
}
/** Pure assertion helper. Never includes the failed value/pointer in an exception. */
export function assertRecordReadback<Field extends string>(
  response: unknown,
  read: Pick<SymmyRecordRead<Field>, 'recordsPointer' | 'fields'>,
  expected: Readonly<Record<Field, unknown>>,
  boundary: ProofBoundary,
  decimalFields: readonly Field[] = [],
): void {
  const selected = atPointer(response, read.recordsPointer, boundary);
  const rows: readonly unknown[] = Array.isArray(selected) ? selected : [selected];
  const entries = Object.entries(expected);
  ensure(entries.length > 0, boundary, 'input-contract');
  const decimalNames = new Set<string>(decimalFields);
  let matches = 0;
  for (const row of rows) {
    let match = true;
    for (const [field, value] of entries) {
      const pointer: unknown = Reflect.get(read.fields, field);
      ensure(typeof pointer === 'string', boundary, 'input-contract');
      const observed = atPointer(row, pointer, boundary);
      if (!(decimalNames.has(field) ? decimalEqual(observed, value) : isDeepStrictEqual(observed, value))) match = false;
    }
    if (match) matches += 1;
  }
  ensure(matches === 1, boundary, 'readback');
}
const CustomerPageSchema = Schema.Struct({
  count: Schema.Int,
  customers: Schema.Array(Schema.Struct({
    sourceRecordId: text,
    partyRef: RefSchema,
    profile: Schema.Struct({ profileRef: Schema.Struct({
      ...RefSchema.fields, kind: Schema.Literals(['RETAIL', 'COUNTERPARTY']),
    }) }),
    party: Schema.Struct({
      outcome: Schema.Literal('AVAILABLE'),
      partyType: Schema.Literals(['PERSON', 'ORGANIZATION']),
      businessName: Schema.NullOr(Schema.String),
      firstName: Schema.NullOr(Schema.String),
      lastName: Schema.NullOr(Schema.String),
      contactPoints: Schema.Array(Schema.Struct({ type: text, normalizedValue: text })),
    }),
  })),
});
export interface SymmyCustomerProof {
  readonly customerId: string;
  readonly partyRef: ProofRef;
  readonly profileId: string;
  readonly kind: 'PERSON' | 'ORGANIZATION';
}
export interface SymmyCustomerFixture {
  readonly label: string;
  readonly postalAddress: {
    readonly addressLine1: string; readonly city: string; readonly postalCode: string; readonly countryCode: string;
  };
  readonly purposes: readonly ['BILLING', 'DELIVERY'];
}
export interface SymmyFullProofContext extends SymmyCommerceProof {
  readonly customers: readonly [SymmyCustomerProof, SymmyCustomerProof];
  readonly address: SymmyCustomerFixture;
}
type BasePriceField = 'productId' | 'variantId' | 'amount' | 'currencyCode' | 'priceGroupKind';
type StockField = 'itemKey' | 'locationKey' | 'amount' | 'unitId';
type AddressField = 'profileId' | 'label' | 'addressLine1' | 'city' | 'postalCode' | 'countryCode' | 'purposes';
type MembershipField = 'profileId' | 'groupCode';
export interface SymmyImportPlan {
  readonly path: string;
  readonly body: unknown;
  readonly expected: EffectExpectation;
}
export interface SymmyFullProofWiring {
  readonly skuRead: (context: SymmyCommerceProof) => SymmyRecordRead<'productId' | 'variantId' | 'sku'>;
  readonly basePriceRead: (context: SymmyCommerceProof) => SymmyRecordRead<BasePriceField>;
  readonly stockRead: (context: SymmyCommerceProof) => SymmyRecordRead<StockField>;
  readonly addressRead: (
    context: SymmyFullProofContext, customer: SymmyCustomerProof,
  ) => SymmyRecordRead<AddressField>;
  readonly membershipRead: (
    context: SymmyFullProofContext, customer: SymmyCustomerProof,
  ) => SymmyRecordRead<MembershipField>;
  /** Bodies must come from the new worker's public schema, include this run's prefix, and contain no native seeds. */
  readonly category: {
    readonly plan: (context: SymmyFullProofContext) => SymmyImportPlan;
    readonly read: (context: SymmyFullProofContext) => SymmyRecordRead<'productId' | 'categoryName'>;
  };
  readonly image: {
    readonly sourceUrl: string;
    readonly plan: (context: SymmyFullProofContext) => SymmyImportPlan;
    readonly read: (context: SymmyFullProofContext) => SymmyRecordRead<'productId' | 'imageName' | 'sourceUrl'>;
  };
  readonly orders: {
    readonly collectionPath: string;
    readonly detailPath: (id: string) => string;
    /** Existing order IDs supplied by the parent. No order is ever placed by this proof. */
    readonly expectedOrderIds: readonly [string, ...string[]];
  };
}
const CUSTOMER_EFFECTS = {
  effectsAtLeast: 11, itemsAtLeast: 8, owners: { 'party.registry': 7, 'commerce.customer-context': 4 },
} satisfies EffectExpectation;
async function proveCustomers(
  config: SymmyProofConfig, client: SymmyProofClient, proof: SymmyCommerceProof,
): Promise<SymmyFullProofContext> {
  const address: SymmyCustomerFixture = {
    label: `${proof.names.prefix}_ADDRESS`,
    postalAddress: {
      addressLine1: 'Acceptance fixture 1', city: 'Test City', postalCode: '11000', countryCode: 'CZ',
    },
    purposes: ['BILLING', 'DELIVERY'],
  };
  const contacts = (id: string) => [
    { preferred: true, type: 'EMAIL', value: `${id.toLowerCase()}@example.invalid` },
    // NANP 202-555-0100..0199 is reserved for fictional use; no message/call is sent.
    { preferred: false, type: 'PHONE', value: '+12025550123' },
  ];
  const body = { customers: [
    {
      addresses: [address], businessName: proof.names.organization, contacts: contacts(proof.names.organization),
      customerId: proof.names.organization, kind: 'ORGANIZATION',
    },
    {
      addresses: [address], contacts: contacts(proof.names.person), customerId: proof.names.person,
      firstName: proof.names.prefix, kind: 'PERSON', lastName: 'Acceptance',
    },
  ] };
  const key = `${proof.names.prefix}.customers`;
  const original = await client.settle(await client.write(
    `${PREFIX}/customers/batch`, body, key, 'customer-import',
  ), CUSTOMER_EFFECTS, 'customer-import');
  const read = async () => decode(CustomerPageSchema, await client.read(
    `${PREFIX}/admin/customers?q=${encodeURIComponent(proof.names.prefix)}&limit=100`, 'customer-readback',
  ), 'customer-readback');
  const page = await read();
  ensure(page.count === 2 && page.customers.length === 2, 'customer-readback', 'readback');
  const customer = (id: string, kind: 'PERSON' | 'ORGANIZATION'): SymmyCustomerProof => {
    const matches = page.customers.filter((item) => item.sourceRecordId === id);
    const [item] = matches;
    ensure(matches.length === 1 && item !== undefined, 'customer-readback', 'readback');
    ensure(
      item.party.partyType === kind && item.partyRef.tenantId === config.input.unitRef.tenantId &&
      item.profile.profileRef.kind === (kind === 'PERSON' ? 'RETAIL' : 'COUNTERPARTY') &&
      (kind === 'ORGANIZATION'
        ? item.party.businessName === proof.names.organization
        : item.party.firstName === proof.names.prefix && item.party.lastName === 'Acceptance'),
      'customer-readback', 'readback',
    );
    for (const contact of contacts(id)) {
      ensure(item.party.contactPoints.filter(
        (point) => point.type === contact.type && point.normalizedValue === contact.value,
      ).length === 1, 'customer-readback', 'readback');
    }
    return { customerId: id, kind, partyRef: item.partyRef, profileId: item.profile.profileRef.resourceId };
  };
  const customers: SymmyFullProofContext['customers'] = [
    customer(proof.names.organization, 'ORGANIZATION'), customer(proof.names.person, 'PERSON'),
  ];
  const replay = await client.settle(await client.write(
    `${PREFIX}/customers/batch`, body, key, 'customer-replay',
  ), CUSTOMER_EFFECTS, 'customer-replay');
  assertReplayIdentity(original, replay, 'customer-replay');
  ensure(isDeepStrictEqual(page, await read()), 'customer-replay', 'readback');
  return { ...proof, address, customers };
}
const OrderSchema = Schema.Struct({
  id: text, number: text, currencyCode: text, totalMinor: Schema.Int, totalVatMinor: Schema.Int,
  totalNetMinor: Schema.Int,
  lines: Schema.NonEmptyArray(Schema.Struct({
    productId: text, sku: text, unitPriceMinor: Schema.Int,
    quantity: Schema.Finite, totalMinor: Schema.Int, totalVatMinor: Schema.Int,
  })),
});
/** Pure check of persisted monetary snapshots; PII fields are deliberately not part of this decoder. */
export function assertOrderSnapshots(body: unknown): readonly typeof OrderSchema.Type[] {
  const orders = decode(Schema.Array(OrderSchema), body, 'order-export');
  ensure(orders.length > 0 && new Set(orders.map((order) => order.id)).size === orders.length, 'order-export', 'readback');
  for (const order of orders) {
    ensure(
      order.totalMinor >= 0 && order.totalVatMinor >= 0 &&
      order.totalNetMinor + order.totalVatMinor === order.totalMinor &&
      order.lines.every((line) =>
        line.quantity > 0 && line.unitPriceMinor >= 0 &&
        line.totalMinor >= line.totalVatMinor && line.totalVatMinor >= 0),
      'order-export', 'readback',
    );
  }
  return orders;
}
export async function proveSymmyOrderExport(
  client: SymmyProofClient, wiring: SymmyFullProofWiring['orders'],
): Promise<void> {
  ensure(
    wiring.expectedOrderIds.length > 0 &&
    wiring.expectedOrderIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 300),
    'order-export', 'input-contract',
  );
  const page = decode(Schema.Struct({ orders: Schema.Array(Schema.Unknown) }),
    await client.read(wiring.collectionPath, 'order-export'), 'order-export');
  const orders = assertOrderSnapshots(page.orders);
  for (const id of wiring.expectedOrderIds) {
    const matches = orders.filter((order) => order.id === id);
    ensure(matches.length === 1, 'order-export', 'readback');
    const detail = decode(Schema.Struct({ order: Schema.Unknown }),
      await client.read(wiring.detailPath(id), 'order-export'), 'order-export');
    const [order] = assertOrderSnapshots([detail.order]);
    ensure(isDeepStrictEqual(matches[0], order), 'order-export', 'readback');
  }
}

/**
 * Full acceptance fails closed before ANY writes if a new worker boundary has not been wired.
 * The commerce helper remains independently callable while workers finish their public endpoints.
 */
export async function proveSymmyFullFunction(
  config: SymmyProofConfig, wiring: SymmyFullProofWiring,
  pass: (boundary: ProofBoundary) => void = (boundary) => { process.stdout.write(`PASS ${boundary}\n`); },
): Promise<void> {
  ensure(
    wiring !== undefined && typeof wiring.skuRead === 'function' &&
    typeof wiring.basePriceRead === 'function' && typeof wiring.stockRead === 'function' &&
    typeof wiring.addressRead === 'function' && typeof wiring.membershipRead === 'function' &&
    typeof wiring.category?.plan === 'function' && typeof wiring.category.read === 'function' &&
    typeof wiring.image?.plan === 'function' && typeof wiring.image.read === 'function' &&
    typeof wiring.orders?.detailPath === 'function' && typeof wiring.orders.collectionPath === 'string' &&
    Array.isArray(wiring.orders.expectedOrderIds) && wiring.orders.expectedOrderIds.length > 0,
    'configuration', 'missing-wiring',
  );
  const origin = checkedOrigin(config.origin);
  checkedPath(wiring.orders.collectionPath, origin, 'configuration');
  try {
    ensure(new URL(wiring.image.sourceUrl).protocol === 'https:', 'configuration', 'input-contract');
  } catch {
    throw new SymmyProofFailure('configuration', 'input-contract');
  }
  const client = createSymmyProofClient(config);
  const verify = async <Field extends string>(
    read: SymmyRecordRead<Field>, expected: Readonly<Record<Field, unknown>>,
    boundary: ProofBoundary, decimals: readonly Field[] = [],
  ) => assertRecordReadback(await client.read(read.path, boundary), read, expected, boundary, decimals);
  const commerce = await proveSymmyProductStockList(config, client);
  pass('product-replay');
  pass('list-price-readback');
  await verify(wiring.skuRead(commerce), {
    productId: commerce.productRef.resourceId, variantId: commerce.variantRef.resourceId, sku: commerce.names.variant,
  }, 'sku-readback');
  pass('sku-readback');
  await verify(wiring.basePriceRead(commerce), {
    productId: commerce.productRef.resourceId, variantId: commerce.variantRef.resourceId,
    amount: commerce.baseAmount, currencyCode: config.input.currencyCode, priceGroupKind: 'NO_GROUP',
  }, 'base-price-readback', ['amount']);
  pass('base-price-readback');
  await verify(wiring.stockRead(commerce), {
    itemKey: commerce.names.variant, locationKey: config.input.locationKey,
    amount: commerce.stockAmount, unitId: config.input.unitRef.resourceId,
  }, 'stock-readback', ['amount']);
  pass('stock-readback');
  const context = await proveCustomers(config, client, commerce);
  pass('customer-replay');
  for (const customer of context.customers) {
    await verify(wiring.addressRead(context, customer), {
      profileId: customer.profileId, label: context.address.label,
      ...context.address.postalAddress, purposes: context.address.purposes,
    }, 'address-readback');
  }
  pass('address-readback');
  const groupBody = { customerGroups: [{
    businessCode: context.names.group, code: context.names.group, name: context.names.group,
    description: `${context.names.prefix} acceptance group`, meaningKey: `${context.names.prefix}.customers`,
    membershipCriteria: 'Explicit ERP assignment of scoped acceptance customers',
    purpose: 'Scoped Symmy HTTP acceptance group',
  }] };
  const groupExpected = { effectsAtLeast: 1, itemsAtLeast: 1, owners: { 'commerce.customer-context': 1 } };
  const groupKey = `${context.names.prefix}.group`;
  const group = await client.settle(await client.write(
    `${PREFIX}/customer-groups/batch`, groupBody, groupKey, 'group-import',
  ), groupExpected, 'group-import');
  const groupReplay = await client.settle(await client.write(
    `${PREFIX}/customer-groups/batch`, groupBody, groupKey, 'group-replay',
  ), groupExpected, 'group-replay');
  assertReplayIdentity(group, groupReplay, 'group-replay');
  // Public worker contract: group-customers-batch-request-contract.ts, ERP IDs only, never profile refs.
  const assignmentPath = `${PREFIX}/customer-groups/${encodeURIComponent(context.names.group)}/customers/batch`;
  const assignmentBody = { customers: context.customers.map(({ customerId }) => ({ customerId })) };
  const assignmentExpected = { effectsAtLeast: 2, itemsAtLeast: 2, owners: { 'commerce.customer-context': 2 } };
  const assignmentKey = `${context.names.prefix}.assignment`;
  const assignment = await client.settle(await client.write(
    assignmentPath, assignmentBody, assignmentKey, 'group-assignment',
  ), assignmentExpected, 'group-assignment');
  const readMemberships = async () => {
    for (const customer of context.customers) {
      await verify(wiring.membershipRead(context, customer), {
        profileId: customer.profileId, groupCode: context.names.group,
      }, 'group-readback');
    }
  };
  await readMemberships();
  const assignmentReplay = await client.settle(await client.write(
    assignmentPath, assignmentBody, assignmentKey, 'group-replay',
  ), assignmentExpected, 'group-replay');
  assertReplayIdentity(assignment, assignmentReplay, 'group-replay');
  // A fresh request key with the SAME ERP customer IDs must not create duplicate memberships.
  await client.settle(await client.write(
    assignmentPath, assignmentBody, `${assignmentKey}.source-replay`, 'group-replay',
  ), assignmentExpected, 'group-replay');
  await readMemberships();
  pass('group-replay');
  for (const kind of ['category', 'image'] satisfies readonly ('category' | 'image')[]) {
    const plan = wiring[kind].plan(context);
    const boundary = kind === 'category' ? 'category-import' : 'image-import';
    ensure(
      JSON.stringify(plan.body)?.includes(context.names.prefix) &&
      !/\/(?:orders?|invoices?|emails?|mail|checkout)(?:\/|$)/iu.test(plan.path) &&
      plan.expected.effectsAtLeast > 0 && Object.keys(plan.expected.owners).length > 0,
      boundary, 'input-contract',
    );
    await client.settle(await client.write(
      plan.path, plan.body, `${context.names.prefix}.${kind}`, boundary,
    ), plan.expected, boundary);
  }
  await verify(wiring.category.read(context), {
    productId: context.productRef.resourceId, categoryName: context.names.category,
  }, 'category-readback');
  pass('category-readback');
  await verify(wiring.image.read(context), {
    productId: context.productRef.resourceId, imageName: context.names.image, sourceUrl: wiring.image.sourceUrl,
  }, 'image-readback');
  pass('image-readback');
  await proveSymmyOrderExport(client, wiring.orders);
  pass('order-export');
  pass('full-proof');
}
type HttpResult = { readonly status: number; readonly body: unknown };
export interface SymmyProofClient {
  read(path: string, boundary: ProofBoundary): Promise<unknown>;
  write(path: string, body: unknown, key: string, boundary: ProofBoundary): Promise<HttpResult>;
  settle(result: HttpResult, expected: EffectExpectation, boundary: ProofBoundary): Promise<Items>;
}
function checkedOrigin(origin: string): URL {
  try {
    const url = new URL(origin);
    ensure(
      url.protocol === 'https:' && url.username === '' && url.password === '' &&
      url.pathname === '/' && url.search === '' && url.hash === '',
      'configuration', 'input-contract',
    );
    return url;
  } catch {
    throw new SymmyProofFailure('configuration', 'input-contract');
  }
}
function checkedPath(path: string, origin: URL, boundary: ProofBoundary): URL {
  try {
    const url = new URL(path, origin);
    ensure(
      path.startsWith(`${PREFIX}/`) && url.origin === origin.origin && url.hash === '' &&
      url.pathname.startsWith(`${PREFIX}/`) && !url.pathname.includes('//'),
      boundary, 'unsafe-path',
    );
    return url;
  } catch {
    throw new SymmyProofFailure(boundary, 'unsafe-path');
  }
}
export function createSymmyProofClient(config: SymmyProofConfig): SymmyProofClient {
  const origin = checkedOrigin(config.origin);
  const budget = config.timeoutMs ?? 600_000;
  const pollMs = config.pollMs ?? 1000;
  ensure(
    Number.isInteger(budget) && budget >= 1000 && budget <= 900_000 &&
    Number.isInteger(pollMs) && pollMs >= 10 && pollMs <= 10_000 &&
    Redacted.isRedacted(config.apiKey) && Redacted.value(config.apiKey).trim().length > 0,
    'configuration', 'input-contract',
  );
  const deadline = Date.now() + budget;
  const remaining = (boundary: ProofBoundary) => {
    const ms = deadline - Date.now();
    ensure(ms > 0, boundary, 'timeout');
    return ms;
  };
  const request = async (
    path: string, method: 'GET' | 'POST', body: unknown, key: string | undefined, boundary: ProofBoundary,
  ): Promise<HttpResult> => {
    const url = checkedPath(path, origin, boundary);
    try {
      const response = await fetch(url, {
        body: method === 'POST' ? JSON.stringify(body) : undefined,
        headers: {
          accept: 'application/json',
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
          ...(key === undefined ? {} : { 'idempotency-key': key }),
          'x-api-key': Redacted.value(config.apiKey),
        },
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(20_000, remaining(boundary))),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new SymmyProofFailure(boundary, 'redirect');
      }
      if (![200, 202].includes(response.status)) {
        await response.body?.cancel();
        throw new SymmyProofFailure(boundary, 'http-status', response.status);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      ensure(response.body !== null, boundary, 'schema');
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        ensure(size <= MAX_RESPONSE_BYTES, boundary, 'response-too-large');
        chunks.push(chunk);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new SymmyProofFailure(boundary, 'schema');
      }
      return { status: response.status, body: parsed };
    } catch (error) {
      if (error instanceof SymmyProofFailure) throw error;
      throw new SymmyProofFailure(
        boundary,
        Date.now() >= deadline || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
          ? 'timeout' : 'network',
      );
    }
  };
  const client: SymmyProofClient = {
    async read(path, boundary) {
      const result = await request(path, 'GET', undefined, undefined, boundary);
      ensure(result.status === 200, boundary, 'http-status');
      return result.body;
    },
    write: (path, body, key, boundary) => {
      ensure(/^[A-Za-z0-9._-]{1,200}$/u.test(key), boundary, 'input-contract');
      return request(path, 'POST', body, key, boundary);
    },
    async settle(result, expected, boundary) {
      if (result.status === 200) return assertAcceptedEffects(result.body, expected, boundary);
      const admission = decode(AdmissionSchema, result.body, boundary);
      while (true) {
        remaining(boundary);
        const job = decode(JobSchema, await client.read(`${PREFIX}/jobs/${admission.jobId}`, boundary), boundary);
        ensure(job.jobId === admission.jobId, boundary, 'job-identity');
        if (job.status === 'completed_all') return assertAcceptedEffects(job, expected, boundary);
        ensure(job.status !== 'completed_partial' && job.status !== 'completed_none', boundary, 'job-terminal');
        await sleep(Math.min(pollMs, remaining(boundary)));
      }
    },
  };
  return client;
}
const PRODUCT_EFFECTS = {
  effectsAtLeast: 3, itemsAtLeast: 3, owners: { 'commerce.catalog': 2, 'commerce.pricing': 1 },
} satisfies EffectExpectation;
export async function proveSymmyProduct(
  config: SymmyProofConfig,
  client: SymmyProofClient = createSymmyProofClient(config),
): Promise<SymmyProductProof> {
  const names = makeSymmyProofNames();
  const input = decode(SymmyProofInputSchema, config.input, 'configuration');
  const path = `${PREFIX}/admin/products?q=${encodeURIComponent(names.prefix)}&limit=100`;
  const before = decode(ProductPageSchema, await client.read(path, 'product-unseen'), 'product-unseen');
  ensure(before.count === 0 && before.products.length === 0, 'product-unseen', 'not-unseen');
  const effectiveFrom = new Date(Date.now() + 120_000).toISOString();
  const baseAmount = '123.45';
  const body = {
    products: [{
      identifier: { type: 'erpId', value: names.product },
      lifecycle: 'ACTIVE',
      name: names.product,
      variants: [{
        identifier: { type: 'variantId', value: names.variant },
        sku: names.variant,
        prices: [{ amount: baseAmount, currencyCode: input.currencyCode, effectiveFrom }],
      }],
    }],
  };
  const key = `${names.prefix}.product`;
  const original = await client.settle(
    await client.write(`${PREFIX}/products/batch`, body, key, 'product-import'),
    PRODUCT_EFFECTS, 'product-import',
  );
  const page = decode(ProductPageSchema, await client.read(path, 'product-readback'), 'product-readback');
  ensure(page.count === 1 && page.products.length === 1, 'product-readback', 'readback');
  const [product] = page.products;
  ensure(product !== undefined, 'product-readback', 'readback');
  ensure(
    product.sourceRecordId === `product:erpId:${names.product}` && product.product.name === names.product,
    'product-readback', 'readback',
  );
  const [source] = product.variantSources;
  ensure(
    product.variantSources.length === 1 && source?.sourceRecordId === `variant:variantId:${names.variant}`,
    'product-readback', 'readback',
  );
  const variant = product.product.variants.find((item) => item.variantId === source.variantId);
  ensure(variant !== undefined && product.product.variants.length === 1, 'product-readback', 'readback');
  const replay = await client.settle(
    await client.write(`${PREFIX}/products/batch`, body, key, 'product-replay'),
    PRODUCT_EFFECTS, 'product-replay',
  );
  assertReplayIdentity(original, replay, 'product-replay');
  const afterReplay = decode(ProductPageSchema, await client.read(path, 'product-replay'), 'product-replay');
  ensure(isDeepStrictEqual(page, afterReplay), 'product-replay', 'readback');
  return {
    baseAmount, effectiveFrom, names, productRef: product.product.productRef,
    variantRef: variant.variantRef, stockAmount: '17', listAmount: '98.76',
  };
}

/** Environment values are consumed once; callers must not print config, fixtures, responses, or thrown causes. */
export function readSymmyProofConfig(env: NodeJS.ProcessEnv): SymmyProofConfig {
  try {
    const key = env.SYMMY_API_KEY;
    const origin = env.SYMMY_PROOF_ORIGIN ?? 'https://ontos-stage-n1.web-revolution.cz';
    const input: unknown = env.SYMMY_PROOF_INPUT_JSON === undefined
      ? AKROS_STAGE_PROOF_INPUT : JSON.parse(env.SYMMY_PROOF_INPUT_JSON);
    ensure(key !== undefined && key.trim().length > 0 && origin !== undefined, 'configuration', 'input-contract');
    checkedOrigin(origin);
    return { apiKey: Redacted.make(key), input: decode(SymmyProofInputSchema, input, 'configuration'), origin };
  } catch {
    throw new SymmyProofFailure('configuration', 'input-contract');
  }
}

/** The secret file is read only when the parent explicitly executes this loader/CLI. Never at module import. */
export async function loadSymmyProofConfig(env: NodeJS.ProcessEnv): Promise<SymmyProofConfig> {
  ensure(!(env.SYMMY_API_KEY && env.SYMMY_API_KEY_FILE), 'configuration', 'input-contract');
  if (env.SYMMY_API_KEY_FILE === undefined) return readSymmyProofConfig(env);
  try {
    const key = (await readFile(env.SYMMY_API_KEY_FILE, 'utf8')).trim();
    return readSymmyProofConfig({ ...env, SYMMY_API_KEY: key });
  } catch {
    throw new SymmyProofFailure('configuration', 'input-contract');
  }
}

export function symmyProofFailureLine(error: unknown): string {
  return error instanceof SymmyProofFailure ? error.message : 'FAIL full-proof:unexpected';
}

// Explicit opt-in: `SYMMY_API_KEY_FILE=... node <this file> --commerce`.
// This first-stage helper proves owner effects and list readback, NOT the later full-function boundary set.
if (import.meta.main) {
  try {
    ensure(process.argv.length === 3 && process.argv[2] === '--commerce', 'configuration', 'input-contract');
    await proveSymmyProductStockList(await loadSymmyProofConfig(process.env));
    process.stdout.write('PASS product-stock-list:effects-and-list-readback\n');
  } catch (error) {
    process.stderr.write(`${symmyProofFailureLine(error)}\n`);
    process.exitCode = 1;
  }
}
