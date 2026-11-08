import { readFileSync } from 'node:fs';
import { parseSync, Visitor } from 'oxc-parser';
import type { CallExpression } from 'oxc-parser';
import { DateTime, Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { demoId, uuidV5 } from '../demo/fixture-ids.mts';
import { salesDemoCustomers } from '../demo/data/sales-customers.mts';
import { makeSalesDemoCustomerFixture } from '../demo/sales-customer-fixture.mts';
import {
  catalog,
  invoices,
  openingReceiptQuantity,
  orders,
  productByKey,
  snapshotPriceMinor,
} from '../demo/sales-plan.mts';

it('retains the UUIDv5 fixture identities across cold resets', () => {
  expect(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe(
    '2ed6657d-e927-568b-95e1-2665a8aea6a2',
  );
  expect(demoId('product', 'p01')).toBe('58565ec1-b1b4-5fbf-a5af-94857d71f8c8');
  expect(demoId('opportunity', 'o01')).toBe('2d22ae01-ac63-59a5-81b8-f6fa502d715b');
  expect(demoId('customer', 'c01')).toBe('fbdd110f-e514-53e9-9832-20f6e4cb1f9d');
});

it.effect('preserves all forty customer identities, order and original segment assignments', () =>
  Effect.gen(function* exactCustomerFixture() {
    const icos = [
      '25741136',
      '44474504',
      '63207877',
      '81941242',
      '00674613',
      '19407980',
      '38141353',
      '56874723',
      '75608090',
      '94341460',
      '13074831',
      '31808204',
      '50541579',
      '69274941',
      '88008312',
      '06741681',
      '25475053',
      '44208421',
      '62941798',
      '81675160',
      '00408531',
      '19141904',
      '37875272',
      '56608641',
      '75342014',
      '94075387',
      '12808750',
      '31542123',
      '50275496',
      '69008868',
      '87742233',
      '06475604',
      '25208977',
      '43942342',
      '62675711',
      '81409087',
      '00142450',
      '18875823',
      '37609190',
      '56342560',
    ];
    expect(salesDemoCustomers.map(({ ico }) => ico)).toEqual(icos);
    const input = yield* makeSalesDemoCustomerFixture(
      '00000000-0000-4000-8000-000000000010',
      DateTime.makeUnsafe('2026-11-07T12:00:00.000Z'),
    );
    expect(input.customers.map(({ ico }) => ico)).toEqual(icos);
    for (const [index, ico] of icos.entries()) {
      const expectedParty = uuidV5('5a1e5d3e-0000-5000-8000-0000000d3e70', `party.customer:ico-${ico}`);
      expect(demoId('customer', `c${String(index + 1).padStart(2, '0')}`)).toBe(expectedParty);
      expect(input.customers[index]?.partyId).toBe(expectedParty);
      expect(input.customers[index]?.counterpartyId).toBe(
        uuidV5('5a1e5d3e-0000-5000-8000-0000000d3e70', `party.counterparty:ico-${ico}`),
      );
    }
    expect(input.customers.map(({ segmentCode }) => segmentCode.replace('SALES_DEMO_', ''))).toEqual([
      'KEY_ACCOUNTS',
      'RETAIL',
      'B2B_STANDARD',
      'B2B_STANDARD',
      'KEY_ACCOUNTS',
      'PUBLIC_SECTOR',
      'RETAIL',
      'KEY_ACCOUNTS',
      'B2B_STANDARD',
      'KEY_ACCOUNTS',
      'B2B_STANDARD',
      'RETAIL',
      'PUBLIC_SECTOR',
      'B2B_STANDARD',
      'RETAIL',
      'PUBLIC_SECTOR',
      'B2B_STANDARD',
      'PUBLIC_SECTOR',
      'B2B_STANDARD',
      'RETAIL',
      'B2B_STANDARD',
      'B2B_STANDARD',
      'B2B_STANDARD',
      'KEY_ACCOUNTS',
      'RETAIL',
      'RETAIL',
      'B2B_STANDARD',
      'B2B_STANDARD',
      'PUBLIC_SECTOR',
      'B2B_STANDARD',
      'B2B_STANDARD',
      'RETAIL',
      'PUBLIC_SECTOR',
      'RETAIL',
      'B2B_STANDARD',
      'PUBLIC_SECTOR',
      'KEY_ACCOUNTS',
      'KEY_ACCOUNTS',
      'B2B_STANDARD',
      'PUBLIC_SECTOR',
    ]);
  }),
);

it.effect('resolves every planned line and preserves snapshot prices and opening stock', () =>
  Effect.gen(function* verifySalesPlan() {
    for (const line of [...orders, ...invoices].flatMap((document) => document.lines)) {
      const product = yield* productByKey(line.productKey);
      expect(snapshotPriceMinor(product, 15)).toBe(product.originalPriceMinor);
      expect(snapshotPriceMinor(product, 14)).toBe(product.currentPriceMinor);
    }
    for (const product of catalog) {
      const sold = orders
        .filter((order) => order.status !== 'CANCELLED')
        .flatMap((order) => order.lines)
        .filter((line) => line.productKey === product.key)
        .reduce((sum, line) => sum + line.quantity, 0);
      expect(openingReceiptQuantity(product)).toBe(product.openingStock + sold);
    }
    const missing = yield* productByKey('missing-product').pipe(Effect.flip);
    expect(Predicate.isTagged(missing, 'UnknownDemoProduct')).toBe(true);
    expect(missing.key).toBe('missing-product');
  }),
);

it('keeps Finance fixture customers and counterparty identities on the shared deterministic inputs', () => {
  const file = new URL('../../verticals/finance-billing/scripts/reset-demo.mts', import.meta.url);
  const source = readFileSync(file, 'utf-8');
  const parsed = parseSync(file.pathname, source);
  expect(parsed.errors).toEqual([]);
  const sourceImports = parsed.program.body.flatMap((node) =>
    node.type === 'ImportDeclaration'
      ? [{ names: node.specifiers.map(({ local }) => local.name), path: node.source.value }]
      : [],
  );
  expect(sourceImports).toContainEqual({
    names: ['salesDemoCustomers'],
    path: '../../../scripts/demo/data/sales-customers.mts',
  });
  expect(sourceImports.find(({ path }) => path === '../../../scripts/demo/fixture-ids.mts')?.names).toContain('demoId');
  expect(sourceImports.some(({ path }) => path.includes('/party-registry/scripts/'))).toBe(false);
  const counterpartyCalls: CallExpression[] = [];
  new Visitor({
    CallExpression(node) {
      if (
        node.callee.type === 'Identifier' &&
        node.callee.name === 'demoId' &&
        node.arguments[0]?.type === 'Literal' &&
        node.arguments[0].value === 'party.counterparty'
      ) {
        counterpartyCalls.push(node);
      }
    },
  }).visit(parsed.program);
  expect(counterpartyCalls).toHaveLength(1);
  expect(counterpartyCalls[0]?.arguments).toMatchObject([
    { type: 'Literal', value: 'party.counterparty' },
    {
      expressions: [{ name: 'ico', type: 'Identifier' }],
      quasis: [{ value: { cooked: 'ico-' } }, { value: { cooked: '' } }],
      type: 'TemplateLiteral',
    },
  ]);
});
