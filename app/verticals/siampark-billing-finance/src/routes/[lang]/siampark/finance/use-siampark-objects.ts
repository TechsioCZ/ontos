import { executeRecords as readAgreements } from '@app/siampark-agreements/clients/records';
import { executeRecords as readProperty } from '@app/siampark-property/clients/records';
import { Effect } from 'effect';
import { useEffect, useState } from 'react';
import type { Invoice } from '../../../../../shared/apis/records.ts';
import { financeBrowserRuntime } from '../../../../runtime/browser.ts';
import { financeObjectAccess } from './sales-pipeline-readable.ts';

export type PropertyRef = NonNullable<Invoice['propertyRef']>;
export type UnitRef = NonNullable<Invoice['unitRef']>;
export type ContractRef = NonNullable<Invoice['contractRef']>;

export interface PropertyOption {
  readonly code: string;
  readonly label: string;
  readonly ref: PropertyRef;
}
export interface UnitOption {
  readonly code: string;
  readonly label: string;
  readonly propertyId: string;
  readonly ref: UnitRef;
}
export interface ContractOption {
  readonly label: string;
  readonly ref: ContractRef;
}

/** Střediska (cost centres) of the demo companies; budgets and the accounting handover use the same labels. */
export const COST_CENTERS = [
  'Správa areálu',
  'Pronájem prostor',
  'Ubytování',
  'Provoz a údržba',
  'Obchod a marketing',
  'Vedení a administrativa',
] as const;

/**
 * Active properties, units and contracts of the selected company, for the object pickers on invoices, budgets and
 * plan items. A company without the Siampark modules (or a role without access) simply gets no picker.
 */
export const useSiamparkObjects = () => {
  const [properties, setProperties] = useState<readonly PropertyOption[]>([]);
  const [units, setUnits] = useState<readonly UnitOption[]>([]);
  const [contracts, setContracts] = useState<readonly ContractOption[]>([]);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let active = true;
    const loadProperties = readProperty({}, 'siampark-finance.objects').pipe(
      Effect.match({
        onFailure: () => undefined,
        onSuccess: (response) => {
          if (!active) {
            return;
          }
          const activeProperties = response.properties.filter((record) => record.lifecycleState === 'ACTIVE');
          const propertyIds = new Set(activeProperties.map((record) => record.propertyRef.resourceId));
          setProperties(
            activeProperties
              .map((record) => ({ code: record.code, label: `${record.name} (${record.code})`, ref: record.propertyRef }))
              .sort((left, right) => left.label.localeCompare(right.label, 'cs')),
          );
          setUnits(
            response.units
              .filter((record) => record.lifecycleState === 'ACTIVE' && propertyIds.has(record.propertyRef.resourceId))
              .map((record) => ({
                code: record.code,
                label: `${record.code} – ${record.name}`,
                propertyId: record.propertyRef.resourceId,
                ref: record.unitRef,
              }))
              .sort((left, right) => left.label.localeCompare(right.label, 'cs')),
          );
          setAvailable(activeProperties.length > 0);
        },
      }),
    );
    const loadContracts = readAgreements({}, 'siampark-finance.contracts').pipe(
      Effect.match({
        onFailure: () => undefined,
        onSuccess: (response) => {
          if (active) {
            setContracts(
              response.contracts
                .filter((record) => record.lifecycleState === 'ACTIVE' || record.lifecycleState === 'DRAFT')
                .map((record) => ({
                  label: `${record.subject ?? (record.kind === 'LEASE' ? 'Nájemní smlouva' : 'Smlouva')} · od ${record.startDate.split('-').reverse().map(Number).join('. ')}`,
                  ref: record.contractRef,
                }))
                .sort((left, right) => left.label.localeCompare(right.label, 'cs')),
            );
          }
        },
      }),
    );
    void financeBrowserRuntime.runPromise(
      financeObjectAccess.pipe(
        Effect.flatMap((access) =>
          Effect.all(
            [access.propertiesReadable ? loadProperties : Effect.void, access.contractsReadable ? loadContracts : Effect.void],
            { concurrency: 2 },
          ),
        ),
      ),
    );
    return () => {
      active = false;
    };
  }, []);

  const propertyName = (id: string | undefined) =>
    id === undefined ? undefined : properties.find((entry) => entry.ref.resourceId === id)?.label;
  const unitName = (id: string | undefined) =>
    id === undefined ? undefined : units.find((entry) => entry.ref.resourceId === id)?.label;
  const contractName = (id: string | undefined) =>
    id === undefined ? undefined : contracts.find((entry) => entry.ref.resourceId === id)?.label;
  return { available, contractName, contracts, properties, propertyName, unitName, units };
};

export type SiamparkObjects = ReturnType<typeof useSiamparkObjects>;
