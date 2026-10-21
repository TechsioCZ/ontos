import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { COST_CENTERS } from './use-siampark-objects.ts';
import type { ContractRef, PropertyRef, SiamparkObjects, UnitRef } from './use-siampark-objects.ts';

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

/** Selection → command anchors, without empty keys. Unknown ids (stale lists) are dropped. */
export const objectAnchors = (
  objects: SiamparkObjects,
  selection: ObjectSelection,
): {
  readonly contractRef?: ContractRef;
  readonly costCenter?: string;
  readonly propertyRef?: PropertyRef;
  readonly unitRef?: UnitRef;
} => {
  const property = objects.properties.find((entry) => entry.ref.resourceId === selection.propertyId);
  const unit = objects.units.find(
    (entry) => entry.ref.resourceId === selection.unitId && entry.propertyId === selection.propertyId,
  );
  const contract = objects.contracts.find((entry) => entry.ref.resourceId === selection.contractId);
  return {
    ...(contract === undefined ? {} : { contractRef: contract.ref }),
    ...(selection.costCenter === '' ? {} : { costCenter: selection.costCenter }),
    ...(property === undefined ? {} : { propertyRef: property.ref }),
    ...(property === undefined || unit === undefined ? {} : { unitRef: unit.ref }),
  };
};

/** Readable "Hala B (HB) · B-101 – Kancelář · Správa areálu" for an assigned object. */
export const objectSummary = (
  objects: SiamparkObjects,
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
  readonly objects: SiamparkObjects;
  readonly onChange: (next: ObjectSelection) => void;
  readonly showContract?: boolean;
  readonly showCostCenter?: boolean;
  readonly value: ObjectSelection;
}

/** Property → unit (filtered by property), optional contract and středisko pickers. */
export const ObjectFields = ({
  idPrefix,
  objects,
  onChange,
  showContract = false,
  showCostCenter = true,
  value,
}: ObjectFieldsProps) => {
  const units = objects.units.filter((entry) => entry.propertyId === value.propertyId);
  return (
    <div className="grid grid-cols-1 gap-200 md:grid-cols-2" data-finance-object-fields={idPrefix}>
      {objects.available && (
        <>
          <SelectTemplate
            items={[
              { displayValue: 'Bez vazby na objekt', label: 'Bez vazby na objekt', value: NONE },
              ...objects.properties.map((entry) => ({
                displayValue: entry.label,
                label: entry.label,
                value: entry.ref.resourceId,
              })),
            ]}
            label="Nemovitost"
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
            disabled={value.propertyId === '' || units.length === 0}
            items={[
              { displayValue: 'Celá nemovitost', label: 'Celá nemovitost', value: NONE },
              ...units.map((entry) => ({ displayValue: entry.label, label: entry.label, value: entry.ref.resourceId })),
            ]}
            label="Jednotka"
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
      {showContract && objects.contracts.length > 0 && (
        <SelectTemplate
          items={[
            { displayValue: 'Bez smlouvy', label: 'Bez smlouvy', value: NONE },
            ...objects.contracts.map((entry) => ({
              displayValue: entry.label,
              label: entry.label,
              value: entry.ref.resourceId,
            })),
          ]}
          label="Smlouva"
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
          label="Středisko"
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
