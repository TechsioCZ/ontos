import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { COST_CENTERS } from './use-rental-objects.ts';
import type { ContractRef, PropertyRef, RentalObjects, UnitRef } from './use-rental-objects.ts';

const NONE = 'NONE';
const labelProps = { className: 'font-label text-label-md' } as const;

/** Object a document, budget line or plan item belongs to; every part is optional. */
export interface ObjectSelection {
  readonly contractId: string;
  readonly costCenter: string;
  readonly propertyId: string;
  readonly unitId: string;
}

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
  readonly onChange: (next: ObjectSelection) => void;
  readonly showContract?: boolean;
  readonly showCostCenter?: boolean;
  readonly value: ObjectSelection;
}

const unlistedSelection = (id: string, listed: boolean, label: string) =>
  id !== '' && !listed ? [{ displayValue: label, label, value: id }] : [];

/** Property → unit (filtered by property), optional contract and středisko pickers. */
export const ObjectFields = ({
  idPrefix,
  objects,
  onChange,
  showContract = false,
  showCostCenter = true,
  value,
}: ObjectFieldsProps) => {
  const { t } = useModernI18n();
  const units = objects.units.filter((entry) => entry.propertyId === value.propertyId);
  return (
    <div className="grid grid-cols-1 gap-200 md:grid-cols-2" data-finance-object-fields={idPrefix}>
      {(objects.available || value.propertyId !== '') && (
        <>
          <SelectTemplate
            items={[
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
            ]}
            label={t('finance-billing.financeUi.objects.property')}
            labelProps={labelProps}
            name={`${idPrefix}-property`}
            onValueChange={({ value: next }) => {
              const [id] = next;
              onChange({ ...value, propertyId: id === undefined || id === NONE ? '' : id, unitId: '' });
            }}
            size="sm"
            value={[value.propertyId === '' ? NONE : value.propertyId]}
          />
          <SelectTemplate
            disabled={value.propertyId === '' || (units.length === 0 && value.unitId === '')}
            items={[
              { displayValue: 'Celá nemovitost', label: 'Celá nemovitost', value: NONE },
              ...unlistedSelection(
                value.unitId,
                units.some((entry) => entry.ref.resourceId === value.unitId),
                t('finance-billing.financeUi.priceList.unit'),
              ),
              ...units.map((entry) => ({ displayValue: entry.label, label: entry.label, value: entry.ref.resourceId })),
            ]}
            label={t('finance-billing.financeUi.priceList.unit')}
            labelProps={labelProps}
            name={`${idPrefix}-unit`}
            onValueChange={({ value: next }) => {
              const [id] = next;
              onChange({ ...value, unitId: id === undefined || id === NONE ? '' : id });
            }}
            size="sm"
            value={[value.unitId === '' ? NONE : value.unitId]}
          />
        </>
      )}
      {showContract && (objects.contracts.length > 0 || value.contractId !== '') && (
        <SelectTemplate
          items={[
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
          ]}
          label={t('finance-billing.financeUi.objects.contract')}
          labelProps={labelProps}
          name={`${idPrefix}-contract`}
          onValueChange={({ value: next }) => {
            const [id] = next;
            onChange({ ...value, contractId: id === undefined || id === NONE ? '' : id });
          }}
          size="sm"
          value={[value.contractId === '' ? NONE : value.contractId]}
        />
      )}
      {showCostCenter && (
        <SelectTemplate
          items={[
            { displayValue: 'Bez střediska', label: 'Bez střediska', value: NONE },
            ...COST_CENTERS.map((entry) => ({ displayValue: entry, label: entry, value: entry })),
          ]}
          label={t('finance-billing.financeUi.objects.costCenter')}
          labelProps={labelProps}
          name={`${idPrefix}-cost-center`}
          onValueChange={({ value: next }) => {
            const [id] = next;
            onChange({ ...value, costCenter: id === undefined || id === NONE ? '' : id });
          }}
          size="sm"
          value={[value.costCenter === '' ? NONE : value.costCenter]}
        />
      )}
    </div>
  );
};
