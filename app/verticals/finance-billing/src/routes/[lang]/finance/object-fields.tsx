import { SelectTemplateField } from '@app/core-runtime/ui/form';
import type { FormReact } from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Schema } from 'effect';
import { createElement } from 'react';
import { fieldPart } from './field-lens.ts';
import { COST_CENTERS } from './use-rental-objects.ts';
import type { ContractRef, PropertyRef, RentalObjects, UnitRef } from './use-rental-objects.ts';

const NONE = 'NONE';
const labelProps = { className: 'font-label text-label-md' } as const;

/** Object a document, budget line or plan item belongs to, as a form field holds it; every part is optional. */
export const ObjectSelectionSchema = Schema.Struct({
  contractId: Schema.String.pipe(Schema.brand('FinanceObjectContractId')),
  costCenter: Schema.String,
  propertyId: Schema.String.pipe(Schema.brand('FinanceObjectPropertyId')),
  unitId: Schema.String.pipe(Schema.brand('FinanceObjectUnitId')),
});
/** The selection as the form holds it: each id as its text, `''` for none. */
export type ObjectSelection = typeof ObjectSelectionSchema.Encoded;

export const emptyObjectSelection: ObjectSelection = { contractId: '', costCenter: '', propertyId: '', unitId: '' };

/** Selection → command anchors, preserving typed existing links independently from optional labels. */
export interface InvoiceObjectAnchors {
  contractRef?: ContractRef;
  costCenter?: string;
  propertyRef?: PropertyRef;
  unitRef?: UnitRef;
}
const selectedRef = <Ref extends { readonly resourceId: string }>(
  id: string,
  existing: Ref | undefined,
  options: readonly { readonly ref: Ref }[],
): Ref | undefined =>
  id === existing?.resourceId ? existing : options.find((entry) => entry.ref.resourceId === id)?.ref;

export const objectAnchors = (
  objects: RentalObjects,
  selection: ObjectSelection,
  existing?: Readonly<InvoiceObjectAnchors>,
): InvoiceObjectAnchors => {
  const propertyRef = selectedRef(selection.propertyId, existing?.propertyRef, objects.properties);
  const unitRef = selectedRef(
    selection.unitId,
    selection.propertyId === existing?.propertyRef?.resourceId ? existing.unitRef : undefined,
    objects.units.filter((entry) => entry.propertyId === selection.propertyId),
  );
  const contractRef = selectedRef(selection.contractId, existing?.contractRef, objects.contracts);
  const anchors: InvoiceObjectAnchors = {};
  if (selection.contractId !== '' && contractRef !== undefined) {
    anchors.contractRef = contractRef;
  }
  if (selection.costCenter !== '') {
    anchors.costCenter = selection.costCenter;
  }
  if (selection.propertyId !== '' && propertyRef !== undefined) {
    anchors.propertyRef = propertyRef;
    if (selection.unitId !== '' && unitRef !== undefined) {
      anchors.unitRef = unitRef;
    }
  }
  return anchors;
};

/** Readable "Hala B (HB) · B-101 – Kancelář · Správa areálu" for an assigned object. */
export const objectSummary = (
  objects: RentalObjects,
  record: {
    readonly costCenter?: string | undefined;
    readonly propertyRef?: { readonly resourceId: string } | undefined;
    readonly unitRef?: { readonly resourceId: string } | undefined;
  },
): string | undefined => {
  const parts = [
    record.propertyRef === undefined
      ? undefined
      : (objects.propertyName(record.propertyRef.resourceId) ?? 'Nemovitost (bez přístupu k názvu)'),
    record.unitRef === undefined ? undefined : (objects.unitName(record.unitRef.resourceId) ?? 'Jednotka'),
    record.costCenter === undefined ? undefined : `středisko ${record.costCenter}`,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(' · ');
};

interface ObjectFieldsProps {
  readonly idPrefix: string;
  readonly objects: RentalObjects;
  readonly showContract?: boolean;
  readonly showCostCenter?: boolean;
}

const unlistedSelection = (id: string, listed: boolean, label: string) =>
  id !== '' && !listed ? [{ displayValue: label, label, value: id }] : [];

/** The id a picker shows for a part: none is the `NONE` item. */
const shownId = (id: string) => (id === '' ? NONE : id);
const pickedId = (id: string) => (id === NONE ? '' : id);

/** Property → unit (filtered by property), optional contract and středisko pickers, over one selection field. */
export const ObjectSelectionField: FormReact.FieldComponent<ObjectSelection, ObjectFieldsProps> = ({
  field,
  props,
}) => {
  const { idPrefix, objects, showContract = false, showCostCenter = true } = props;
  const { onChange, value } = field;
  const { t } = useModernI18n();
  const units = objects.units.filter((entry) => entry.propertyId === value.propertyId);
  return (
    <div className="grid grid-cols-1 gap-200 md:grid-cols-2" data-finance-object-fields={idPrefix}>
      {(objects.available || value.propertyId !== '') && (
        <>
          {createElement(SelectTemplateField, {
            field: fieldPart(field, 'propertyId', shownId(value.propertyId), (id) =>
              onChange({ ...value, propertyId: pickedId(id), unitId: '' }),
            ),
            props: {
              items: [
                { displayValue: 'Bez vazby na objekt', label: 'Bez vazby na objekt', value: NONE },
                ...unlistedSelection(
                  value.propertyId,
                  objects.propertyName(value.propertyId) !== undefined,
                  t('finance-billing.financeUi.objects.property'),
                ),
                ...objects.properties.map((entry) => ({
                  displayValue: entry.label,
                  label: entry.label,
                  value: entry.ref.resourceId,
                })),
              ],
              label: t('finance-billing.financeUi.objects.property'),
              labelProps,
              name: `${idPrefix}-property`,
              size: 'sm',
            },
          })}
          {createElement(SelectTemplateField, {
            field: fieldPart(field, 'unitId', shownId(value.unitId), (id) =>
              onChange({ ...value, unitId: pickedId(id) }),
            ),
            props: {
              disabled: value.propertyId === '' || (units.length === 0 && value.unitId === ''),
              items: [
                { displayValue: 'Celá nemovitost', label: 'Celá nemovitost', value: NONE },
                ...unlistedSelection(
                  value.unitId,
                  units.some((entry) => entry.ref.resourceId === value.unitId),
                  t('finance-billing.financeUi.priceList.unit'),
                ),
                ...units.map((entry) => ({
                  displayValue: entry.label,
                  label: entry.label,
                  value: entry.ref.resourceId,
                })),
              ],
              label: t('finance-billing.financeUi.priceList.unit'),
              labelProps,
              name: `${idPrefix}-unit`,
              size: 'sm',
            },
          })}
        </>
      )}
      {showContract &&
        (objects.contracts.length > 0 || value.contractId !== '') &&
        createElement(SelectTemplateField, {
          field: fieldPart(field, 'contractId', shownId(value.contractId), (id) =>
            onChange({ ...value, contractId: pickedId(id) }),
          ),
          props: {
            items: [
              { displayValue: 'Bez smlouvy', label: 'Bez smlouvy', value: NONE },
              ...unlistedSelection(
                value.contractId,
                objects.contractName(value.contractId) !== undefined,
                t('finance-billing.financeUi.objects.contract'),
              ),
              ...objects.contracts.map((entry) => ({
                displayValue: entry.label,
                label: entry.label,
                value: entry.ref.resourceId,
              })),
            ],
            label: t('finance-billing.financeUi.objects.contract'),
            labelProps,
            name: `${idPrefix}-contract`,
            size: 'sm',
          },
        })}
      {showCostCenter &&
        createElement(SelectTemplateField, {
          field: fieldPart(field, 'costCenter', shownId(value.costCenter), (id) =>
            onChange({ ...value, costCenter: pickedId(id) }),
          ),
          props: {
            items: [
              { displayValue: 'Bez střediska', label: 'Bez střediska', value: NONE },
              ...COST_CENTERS.map((entry) => ({ displayValue: entry, label: entry, value: entry })),
            ],
            label: t('finance-billing.financeUi.objects.costCenter'),
            labelProps,
            name: `${idPrefix}-cost-center`,
            size: 'sm',
          },
        })}
    </div>
  );
};
