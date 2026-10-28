import { afterEach, expect, it, rstest } from 'effect-rstest';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ObjectFields } from '../../src/routes/[lang]/finance/object-fields.tsx';
import type { ObjectSelection } from '../../src/routes/[lang]/finance/object-fields.tsx';
import type { RentalObjects } from '../../src/routes/[lang]/finance/use-rental-objects.ts';

interface Picker {
  readonly disabled?: boolean;
  readonly items: readonly { readonly displayValue: string; readonly label: string; readonly value: string }[];
  readonly name: string;
  readonly onValueChange: (details: { readonly value: string[] }) => void;
  readonly value: readonly string[];
}

const { pickers } = rstest.hoisted(() => {
  const captured: Picker[] = [];
  return { pickers: captured };
});
rstest.mock('@techsio/ui-kit/templates/select', () => ({
  SelectTemplate: (props: Picker) => {
    pickers.push(props);
    return null;
  },
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    t: (key: string) => {
      const labels = new Map([
        ['finance-billing.financeUi.objects.contract', 'Agreement'],
        ['finance-billing.financeUi.objects.property', 'Property'],
        ['finance-billing.financeUi.priceList.unit', 'Unit'],
      ]);
      return labels.get(key) ?? key;
    },
  }),
}));

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

const renderFields = () => {
  // This owner's Node test config uses the classic React JSX runtime for imported TSX.
  rstest.stubGlobal('React', React);
  pickers.length = 0;
  const onChange = rstest.fn<(next: ObjectSelection) => void>();
  renderToStaticMarkup(
    createElement(ObjectFields, { idPrefix: 'edit', objects, onChange, showContract: true, value: selection }),
  );
  const picker = (field: string) => {
    const found = pickers.find(({ name }) => name === `edit-${field}`);
    expect(found).toBeDefined();
    if (found === undefined) {
      throw new Error(`Missing fixture picker: ${field}`);
    }
    return found;
  };
  return { onChange, picker };
};
afterEach(() => {
  rstest.unstubAllGlobals();
});

it('renders existing unavailable references as selected generic localized options without clearing them', () => {
  const { onChange, picker } = renderFields();
  for (const { field, label, value } of [
    { field: 'property', label: 'Property', value: selection.propertyId },
    { field: 'unit', label: 'Unit', value: selection.unitId },
    { field: 'contract', label: 'Agreement', value: selection.contractId },
  ]) {
    expect(picker(field).value).toEqual([value]);
    expect(picker(field).items).toContainEqual({ displayValue: label, label, value });
  }
  expect(picker('unit').disabled).toBe(false);
  expect(onChange).not.toHaveBeenCalled();
});

it('lets explicit property removal clear both property and unit without clearing the contract', () => {
  const { onChange, picker } = renderFields();
  picker('property').onValueChange({ value: ['NONE'] });
  expect(onChange).toHaveBeenCalledWith({ ...selection, propertyId: '', unitId: '' });
});

it('lets an editor clear just the unavailable unit', () => {
  const { onChange, picker } = renderFields();
  picker('unit').onValueChange({ value: ['NONE'] });
  expect(onChange).toHaveBeenCalledWith({ ...selection, unitId: '' });
});

it('lets an editor explicitly unlink the unavailable agreement', () => {
  const { onChange, picker } = renderFields();
  picker('contract').onValueChange({ value: ['NONE'] });
  expect(onChange).toHaveBeenCalledWith({ ...selection, contractId: '' });
});
