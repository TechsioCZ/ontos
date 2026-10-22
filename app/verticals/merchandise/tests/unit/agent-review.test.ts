import { expect, it } from 'effect-rstest';

import {
  blockedReasonOf,
  productDiff,
  productRevert,
  productStillInPlace,
  reviewProductProposal,
  targetProductId,
} from '../../src/api/agent-review.ts';
import type { MerchandiseRights } from '../../src/api/agent-review.ts';

const MISSING_BEFORE = 'Chybí původní hodnoty, změnu nelze automaticky vrátit.';
const allRights: MerchandiseRights = { canEditOrders: true, canManageCatalog: true, canWrite: true };

const review = (
  request: Partial<Parameters<typeof reviewProductProposal>[0]['request']> & { command: Record<string, unknown> },
  product?: Record<string, unknown>,
  /** `null`: the records read failed. */
  rights: MerchandiseRights | null = allRights,
) =>
  reviewProductProposal({
    product,
    request: { actionSlug: 'apply-command', key: 'k', stage: 'proposed', ...request },
    rights: rights ?? undefined,
  });

it('a price change shows the live price before and the new price after, in Czech crowns', () => {
  expect(productDiff({ _tag: 'ChangePrice', id: 'p', priceMinor: 366_000 }, { currentPriceMinor: 349_000 })).toEqual([
    { after: '3\u00a0660,00\u00a0Kč', before: '3\u00a0490,00\u00a0Kč', field: 'priceMinor', label: 'Cena bez DPH' },
  ]);
  expect(
    productDiff(
      { _tag: 'ChangePrice', id: 'p', priceMinor: 3000, variantId: 'V2' },
      { variants: [{ id: 'V2', priceMinor: 2000 }] },
    ),
  ).toEqual([{ after: '30,00\u00a0Kč', before: '20,00\u00a0Kč', field: 'priceMinor', label: 'Cena varianty bez DPH' }]);
  expect(productDiff({ _tag: 'RecordStockMovement', delta: 1 }, undefined)).toBeUndefined();
});

it('a product edit and a new product list their fields with Czech labels', () => {
  expect(productDiff({ _tag: 'UpdateProduct', id: 'p', patch: { active: false, name: 'Nový' } }, { active: true, name: 'Starý' }))
    .toEqual([
      { after: 'Ne', before: 'Ano', field: 'active', label: 'Aktivní v nabídce' },
      { after: 'Nový', before: 'Starý', field: 'name', label: 'Název' },
    ]);
  expect(productDiff({ _tag: 'CreateProduct', id: 'x', name: 'Mýdlo', priceMinor: 12_900 }, undefined)).toEqual([
    { after: 'Mýdlo', field: 'name', label: 'Název' },
    { after: '129,00\u00a0Kč', field: 'priceMinor', label: 'Cena bez DPH' },
  ]);
});

it('detects a price a person changed after the approval', () => {
  const command = { _tag: 'ChangePrice', id: 'p', priceMinor: 360_000 };
  expect(productStillInPlace(command, { currentPriceMinor: 360_000 })).toBe(true);
  expect(productStillInPlace(command, { currentPriceMinor: 365_000 })).toBe(false);
  expect(productStillInPlace(command, undefined)).toBe(false);
  const variant = { _tag: 'ChangePrice', id: 'p', priceMinor: 10, variantId: 'V1' };
  expect(productStillInPlace(variant, { variants: [{ id: 'V1', priceMinor: 10 }] })).toBe(true);
  expect(productStillInPlace(variant, { variants: [] })).toBe(false);
  expect(productStillInPlace({ _tag: 'UpdateProduct', id: 'p', patch: { name: 'A' } }, { name: 'A', sku: 'X' })).toBe(true);
  expect(productStillInPlace({ _tag: 'CreateProduct', name: 'X' }, undefined)).toBeUndefined();
});

it('ChangePrice without variant restores currentPriceMinor', () => {
  expect(productRevert({ _tag: 'ChangePrice', id: 'P1', priceMinor: 14900 }, { currentPriceMinor: 12900 })).toEqual({
    commands: [{ _tag: 'ChangePrice', id: 'P1', priceMinor: 12900 }],
    kind: 'commands',
  });
  expect(productRevert({ _tag: 'ChangePrice', id: 'P1', priceMinor: 14900 }, undefined)).toEqual({
    kind: 'none',
    reason: MISSING_BEFORE,
  });
});

it('ChangePrice with variantId restores that variant priceMinor', () => {
  const plan = productRevert(
    { _tag: 'ChangePrice', id: 'P1', priceMinor: 3000, variantId: 'V2' },
    {
      currentPriceMinor: 1000,
      variants: [
        { id: 'V1', priceMinor: 1000 },
        { id: 'V2', priceMinor: 2000 },
      ],
    },
  );
  expect(plan).toEqual({
    commands: [{ _tag: 'ChangePrice', id: 'P1', priceMinor: 2000, variantId: 'V2' }],
    kind: 'commands',
  });
});

it('UpdateProduct with a patch key missing from before is not revertible', () => {
  expect(productRevert({ _tag: 'UpdateProduct', id: 'P1', patch: { name: 'B', price: 5 } }, { name: 'A' })).toEqual({
    kind: 'none',
    reason: MISSING_BEFORE,
  });
  expect(productRevert({ _tag: 'UpdateProduct', id: 'P1', patch: { name: 'B' } }, { name: 'A' })).toEqual({
    commands: [{ _tag: 'UpdateProduct', id: 'P1', patch: { name: 'A' } }],
    kind: 'commands',
  });
});

it('CreateProduct is undone by deactivating the created product', () => {
  expect(productRevert({ _tag: 'CreateProduct', name: 'X' }, undefined)).toEqual({
    commands: [{ _tag: 'UpdateProduct', id: '$createdId', patch: { active: false } }],
    createdIdPath: 'entityIds.0',
    kind: 'commands',
  });
  expect(productRevert({ _tag: 'EditOrder', id: 'o' }, undefined)).toEqual({
    kind: 'none',
    reason: 'Tuto změnu nelze automaticky vrátit.',
  });
});

it('price changes and product edits read the product they change', () => {
  expect(targetProductId({ _tag: 'ChangePrice', id: 'p1', priceMinor: 100 })).toBe('p1');
  expect(targetProductId({ _tag: 'UpdateProduct', id: 'p1', patch: {} })).toBe('p1');
  expect(targetProductId({ _tag: 'CreateProduct', id: 'p1' })).toBeUndefined();
  expect(targetProductId({ _tag: 'EditOrder', id: 'o1' })).toBeUndefined();
});

it('a catalog change needs catalog management, any change needs module write', () => {
  const changePrice = { _tag: 'ChangePrice', id: 'p', priceMinor: 100 };
  expect(blockedReasonOf(changePrice, { canManageCatalog: false, canWrite: true })).toBe(
    'Změny katalogu a cen schvaluje jen člověk se správou katalogu.',
  );
  expect(blockedReasonOf(changePrice, { canManageCatalog: true, canWrite: true })).toBeUndefined();
  expect(blockedReasonOf({ _tag: 'CreateOrder' }, { canWrite: false })).toBe('V tomto modulu nemáte oprávnění k zápisu.');
  expect(blockedReasonOf({ _tag: 'EditOrder', id: 'o' }, { canEditOrders: false, canWrite: true })).toBe(
    'Úpravy objednávek schvaluje jen člověk s oprávněním k úpravám objednávek.',
  );
  expect(blockedReasonOf({ _tag: 'EditOrder', id: 'o' }, undefined)).toBeUndefined();
});

it('a pending price change shows the live product, its name and its undo plan', () => {
  const item = review(
    { command: { _tag: 'ChangePrice', id: 'p', priceMinor: 200 } },
    { currentPriceMinor: 100, id: 'p', name: 'Mýdlo' },
  );
  expect(item).toEqual({
    diff: [{ after: '2,00\u00a0Kč', before: '1,00\u00a0Kč', field: 'priceMinor', label: 'Cena bez DPH' }],
    key: 'k',
    revert: { commands: [{ _tag: 'ChangePrice', id: 'p', priceMinor: 100 }], kind: 'commands' },
    targetName: 'Mýdlo',
    visible: true,
  });
});

it('a proposal about a product that is gone for the reader is hidden; an unread product stays open', () => {
  const command = { _tag: 'UpdateProduct', id: 'p', patch: { name: 'Y' } };
  expect(review({ command }).visible).toBe(false);
  const unknown = review({ command }, undefined, null);
  expect(unknown).toEqual({
    diff: [{ after: 'Y', field: 'name', label: 'Název' }],
    key: 'k',
    revert: { kind: 'none', reason: MISSING_BEFORE },
    visible: true,
  });
});

it('pending proposals report undo support from the command alone', () => {
  expect(review({ command: { _tag: 'CreateProduct', name: 'X' } }).revertUnavailableReason).toBeUndefined();
  expect(review({ command: { _tag: 'EditOrder', id: 'o' } }).revertUnavailableReason).toBe(
    'Tuto změnu nelze automaticky vrátit.',
  );
});

it('undo leaves a change alone when the product was edited since or cannot be read', () => {
  const command = { _tag: 'ChangePrice', id: 'p', priceMinor: 200 };
  expect(review({ command, stage: 'undo' }, { currentPriceMinor: 200 })).toEqual({
    key: 'k',
    stillInPlace: true,
    visible: true,
  });
  expect(review({ command, stage: 'undo' }, { currentPriceMinor: 300 }).stillInPlace).toBe(false);
  expect(review({ command, stage: 'undo' }).visible).toBe(false);
  expect(review({ command: { _tag: 'CreateProduct', name: 'X' }, stage: 'undo' })).toEqual({ key: 'k', visible: true });
});

it('history shows the command lines without a live before', () => {
  expect(review({ command: { _tag: 'ChangePrice', id: 'p', priceMinor: 200 }, stage: 'history' })).toEqual({
    diff: [{ after: '2,00\u00a0Kč', field: 'priceMinor', label: 'Cena bez DPH' }],
    key: 'k',
    visible: true,
  });
});
