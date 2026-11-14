import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SymmyPriceListPricesBatchRequestSchema } from '../../api/symmy/price-lists-prices-batch-request-contract.ts';
import {
  commercialScope,
  priceGroupRef,
  priceRef,
  productRef,
  unitBasis,
  unitRef,
  variantRef,
} from './symmy-price-requests.fixtures.ts';
import type { Json } from './symmy-price-requests.fixtures.ts';

// The HTTP layer decodes with excess properties rejected; the schema must hold under the same options.
const accepts = (body: Json) =>
  Result.isSuccess(
    Schema.decodeUnknownResult(SymmyPriceListPricesBatchRequestSchema, { onExcessProperty: 'error' })(body),
  );
const define = {
  amount: '25.50',
  commercialScope,
  currencyCode: 'CZK',
  effectiveFrom: '2026-01-01T00:00:00Z',
  operation: 'DEFINE',
  productRef,
  unitBasis,
  variantRef,
};
const revise = {
  amount: '30',
  currencyCode: 'CZK',
  expectedRevision: { revision: 2, revisionId: '44444444-4444-4444-8444-444444444444' },
  operation: 'REVISE',
  priceRef,
};
const distinctDefine = (index: number) => ({
  ...define,
  commercialScope: { ...commercialScope, marketId: `market-${index}` },
});
const body = (prices: Json) => ({ priceGroupRef, prices });
const without = (item: Record<string, Json>, key: string) =>
  Object.fromEntries(Object.entries(item).filter(([name]) => name !== key));

describe('Symmy price list prices batch request', () => {
  it('accepts DEFINE and REVISE items, mixed', () => {
    expect(accepts(body([define]))).toBe(true);
    expect(accepts(body([revise]))).toBe(true);
    expect(accepts(body([define, revise]))).toBe(true);
  });

  it('limits the request to one to sixteen items', () => {
    expect(accepts(body(Array.from({ length: 16 }, (_, index) => distinctDefine(index))))).toBe(true);
    expect(accepts(body(Array.from({ length: 17 }, (_, index) => distinctDefine(index))))).toBe(false);
    expect(accepts(body([]))).toBe(false);
    expect(accepts({ priceGroupRef })).toBe(false);
  });

  it('requires a price group ref of the right type', () => {
    expect(accepts({ prices: [define] })).toBe(false);
    expect(accepts({ priceGroupRef: priceRef, prices: [define] })).toBe(false);
    expect(accepts({ priceGroupRef: variantRef, prices: [define] })).toBe(false);
    expect(accepts({ priceGroupRef: 'group-1', prices: [define] })).toBe(false);
    expect(accepts({ priceGroupRef: { ...priceGroupRef, extra: 1 }, prices: [define] })).toBe(false);
    expect(accepts({ priceGroupRef: null, prices: [define] })).toBe(false);
  });

  it('requires an operation and refuses another value', () => {
    expect(accepts(body([without(define, 'operation')]))).toBe(false);
    expect(accepts(body([{ ...define, operation: 'UPSERT' }]))).toBe(false);
    expect(accepts(body([{ ...define, operation: 'define' }]))).toBe(false);
  });

  it('requires every DEFINE field', () => {
    for (const key of Object.keys(define).filter((name) => name !== 'operation')) {
      expect(accepts(body([without(define, key)])), key).toBe(false);
    }
  });

  it('refuses revise fields on DEFINE and define fields on REVISE', () => {
    expect(accepts(body([{ ...define, priceRef }]))).toBe(false);
    expect(accepts(body([{ ...define, expectedRevision: revise.expectedRevision }]))).toBe(false);
    const defineOnly = new Set(['productRef', 'variantRef', 'effectiveFrom', 'commercialScope', 'unitBasis']);
    for (const [key, value] of Object.entries(define).filter(([name]) => defineOnly.has(name))) {
      expect(accepts(body([{ ...revise, [key]: value }])), key).toBe(false);
    }
  });

  it('requires every REVISE field', () => {
    for (const key of ['priceRef', 'expectedRevision', 'amount', 'currencyCode']) {
      expect(accepts(body([without(revise, key)])), key).toBe(false);
    }
    expect(accepts(body([{ ...revise, expectedRevision: { revision: 2 } }]))).toBe(false);
    expect(accepts(body([{ ...revise, expectedRevision: { revisionId: revise.expectedRevision.revisionId } }]))).toBe(
      false,
    );
  });

  it('checks amounts, currencies, refs and revisions', () => {
    for (const extra of [
      { amount: -1 },
      { amount: 25 },
      { amount: '-25' },
      { amount: '1e3' },
      { amount: '01' },
      { amount: '1.1234567891' },
      { currencyCode: 'czk' },
      { currencyCode: 'QQQ' },
      { priceRef: priceGroupRef },
      { priceRef: 'price-1' },
      { expectedRevision: { revision: 0, revisionId: revise.expectedRevision.revisionId } },
      { expectedRevision: { revision: 1.5, revisionId: revise.expectedRevision.revisionId } },
      { expectedRevision: { revision: '2', revisionId: revise.expectedRevision.revisionId } },
      { expectedRevision: { revision: 2, revisionId: 'not-a-uuid' } },
    ]) {
      expect(accepts(body([{ ...revise, ...extra }])), JSON.stringify(extra)).toBe(false);
    }
    for (const extra of [
      { productRef: variantRef },
      { variantRef: productRef },
      { unitBasis: { quantity: '1', unitRef: productRef } },
      { unitBasis: { quantity: '0', unitRef } },
      { commercialScope: { channelId: 'B2B' } },
      { commercialScope: { channelId: 'B2C', marketId: '' } },
      { effectiveFrom: 'tomorrow' },
    ]) {
      expect(accepts(body([{ ...define, ...extra }])), JSON.stringify(extra)).toBe(false);
    }
  });

  it('refuses two items for the same price', () => {
    expect(accepts(body([define, define]))).toBe(false);
    expect(accepts(body([define, { ...define, unitBasis: { quantity: '1.0', unitRef } }]))).toBe(false);
    expect(accepts(body([revise, { ...revise, amount: '40' }]))).toBe(false);
    expect(accepts(body([define, { ...define, currencyCode: 'EUR' }]))).toBe(true);
    expect(accepts(body([define, { ...define, commercialScope: { channelId: 'B2C', marketId: 'cz-market' } }]))).toBe(
      true,
    );
    expect(accepts(body([define, { ...define, unitBasis: { quantity: '2', unitRef } }]))).toBe(true);
    expect(
      accepts(
        body([revise, { ...revise, priceRef: { ...priceRef, resourceId: '55555555-5555-4555-8555-555555555555' } }]),
      ),
    ).toBe(true);
  });

  it('refuses reason, source assertion, identity, intent, codes, minimum quantity, metadata and the contract version', () => {
    for (const extra of [
      { reason: 'x' },
      { sourceAssertion: {} },
      { identityKey: {} },
      { intent: {} },
      { code: 'c' },
      { priceListCode: 'c' },
      { priceGroupCode: 'c' },
      { minQuantity: '1' },
      { metadata: {} },
      { contractVersion: 'INTERNAL_C14' },
    ]) {
      expect(accepts(body([{ ...define, ...extra }])), JSON.stringify(extra)).toBe(false);
      expect(accepts(body([{ ...revise, ...extra }])), JSON.stringify(extra)).toBe(false);
      expect(accepts({ ...body([define]), ...extra }), JSON.stringify(extra)).toBe(false);
    }
    expect(accepts({ ...body([define]), selector: 'x' })).toBe(false);
    expect(accepts({ ...body([define]), fixtureId: 'x' })).toBe(false);
  });
});
