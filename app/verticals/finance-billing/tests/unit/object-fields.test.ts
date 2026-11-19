// @rstest-environment happy-dom
import { acted, unmountAll } from '@app/admin-ui/testing/module-ui';
import { Effect, Option } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';
import { createElement } from 'react';

import csResource from '../../locales/cs/finance-billing.json';
import enResource from '../../locales/en/finance-billing.json';
import { ObjectFields } from '../../src/routes/[lang]/finance/object-fields.tsx';
import type { ObjectSelection } from '../../src/routes/[lang]/finance/object-fields.tsx';
import type { RentalObjects } from '../../src/routes/[lang]/finance/use-rental-objects.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const resources = {
  cs: { 'finance-billing': csResource },
  en: { 'finance-billing': enResource },
};
const czech = moduleText('cs', resources);

const unavailableName = (): undefined => {
  // Optional label reads have not supplied an answer.
};
const objects: RentalObjects = {
  available: false,
  contractName: unavailableName,
  contracts: [],
  properties: [],
  propertyName: unavailableName,
  unitName: unavailableName,
  units: [],
};
const selection: ObjectSelection = {
  contractId: 'existing-contract',
  costCenter: '',
  propertyId: 'existing-property',
  unitId: 'existing-unit',
};

const picker = (field: string) => {
  const found = document.querySelector<HTMLSelectElement>(`select[name="edit-${field}"]`);
  expect(found).not.toBeNull();
  return Option.getOrThrow(Option.fromNullOr(found));
};

const renderFields = () =>
  Effect.gen(function* render() {
    const changes: ObjectSelection[] = [];
    yield* mountInRoute(
      createElement(ObjectFields, {
        idPrefix: 'edit',
        objects,
        onChange: (next) => {
          changes.push(next);
        },
        showContract: true,
        value: selection,
      }),
      { path: 'finance', resources, url: '/cs/finance' },
    );
    return changes;
  });

const clear = (field: string) =>
  acted(() => {
    const select = picker(field);
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, 'NONE');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });

afterEach(unmountAll);

it.live('renders existing unavailable references as selected generic localized options without clearing them', () =>
  Effect.gen(function* existingReferences() {
    const changes = yield* renderFields();
    for (const { field, label, value } of [
      { field: 'property', label: czech('finance-billing.financeUi.objects.property'), value: selection.propertyId },
      { field: 'unit', label: czech('finance-billing.financeUi.priceList.unit'), value: selection.unitId },
      { field: 'contract', label: czech('finance-billing.financeUi.objects.contract'), value: selection.contractId },
    ]) {
      const select = picker(field);
      expect([...select.selectedOptions].map((option) => option.value)).toEqual([value]);
      expect(
        [...select.options].map((option) => ({
          displayValue: option.textContent,
          value: option.value,
        })),
      ).toContainEqual({ displayValue: label, value });
      const trigger = select.nextElementSibling?.querySelector<HTMLButtonElement>('[data-part="trigger"]');
      expect(trigger).toBeDefined();
      expect(trigger).not.toBeNull();
      const button = Option.getOrThrow(Option.fromNullishOr(trigger));
      expect(button.textContent?.trim()).toBe(label);
      yield* acted(() => button.click());
      const item = document.querySelector(`[role="option"][data-value="${value}"]`);
      expect(item?.textContent?.trim()).toBe(label);
      yield* acted(() => button.click());
    }
    expect(picker('unit').disabled).toBe(false);
    expect(changes).toEqual([]);
  }),
);

it.live('lets explicit property removal clear both property and unit without clearing the contract', () =>
  Effect.gen(function* clearProperty() {
    const changes = yield* renderFields();
    yield* clear('property');
    expect(changes).toContainEqual({ ...selection, propertyId: '', unitId: '' });
  }),
);

it.live('lets an editor clear just the unavailable unit', () =>
  Effect.gen(function* clearUnit() {
    const changes = yield* renderFields();
    yield* clear('unit');
    expect(changes).toContainEqual({ ...selection, unitId: '' });
  }),
);

it.live('lets an editor explicitly unlink the unavailable agreement', () =>
  Effect.gen(function* clearContract() {
    const changes = yield* renderFields();
    yield* clear('contract');
    expect(changes).toContainEqual({ ...selection, contractId: '' });
  }),
);
