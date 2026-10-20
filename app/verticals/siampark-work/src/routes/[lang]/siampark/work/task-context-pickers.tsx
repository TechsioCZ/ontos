import { executeRecords as propertyRecords } from '@app/siampark-property/clients/records';
import { executeRecords as agreementRecords } from '@app/siampark-agreements/clients/records';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Random } from 'effect';
import { useEffect, useState } from 'react';
import type { ContextRef } from '../../../../../shared/apis/records.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';

const key = 'siampark-work.pages.records';
const NONE = 'none';
interface ContextOption {
  readonly ref: ContextRef;
  readonly label: string;
  readonly propertyId?: string;
}

/** Only the owning modules supply options; no cross-company directory or hard-coded fixture IDs. */
export const TaskContextPickers = ({
  refs,
  disabled,
  onChange,
}: {
  readonly refs: readonly ContextRef[];
  readonly disabled: boolean;
  readonly onChange: (refs: readonly ContextRef[]) => void;
}) => {
  const { t } = useModernI18n();
  const [properties, setProperties] = useState<readonly ContextOption[]>([]);
  const [units, setUnits] = useState<readonly ContextOption[]>([]);
  const [contracts, setContracts] = useState<readonly ContextOption[]>([]);
  const [propertyState, setPropertyState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [contractState, setContractState] = useState<'loading' | 'ready' | 'failed'>('loading');
  useEffect(() => {
    const correlation = Random.nextInt.pipe(Effect.map((id) => `work-context:${id}`));
    const propertyFiber = browserRuntime.runFork(
      correlation.pipe(
        Effect.flatMap((id) => propertyRecords({}, id)),
        Effect.match({
          onFailure: () => setPropertyState('failed'),
          onSuccess: (records) => {
            setProperties(
              records.properties.map((item) => ({ ref: item.propertyRef, label: `${item.code} · ${item.name}` })),
            );
            setUnits(
              records.units.map((item) => ({
                ref: item.unitRef,
                label: `${item.code} · ${item.name}`,
                propertyId: item.propertyRef.resourceId,
              })),
            );
            setPropertyState('ready');
          },
        }),
      ),
    );
    const contractFiber = browserRuntime.runFork(
      correlation.pipe(
        Effect.flatMap((id) => agreementRecords({}, id)),
        Effect.match({
          onFailure: () => setContractState('failed'),
          onSuccess: (records) => {
            setContracts(
              records.contracts.map((item) => ({
                ref: item.contractRef,
                label: `${item.subject ?? (item.kind === 'LEASE' ? t(`${key}.leaseContract`) : t(`${key}.otherContract`))} · ${item.startDate}`,
              })),
            );
            setContractState('ready');
          },
        }),
      ),
    );
    return () => {
      propertyFiber.interruptUnsafe();
      contractFiber.interruptUnsafe();
    };
  }, []);
  const propertyId = refs.find((ref) => ref.resourceType === 'siampark.property.property')?.resourceId;
  const fields = [
    {
      type: 'siampark.property.property',
      id: 'task-property',
      label: t(`${key}.property`),
      items: properties,
      state: propertyState,
    },
    {
      type: 'siampark.property.unit',
      id: 'task-unit',
      label: t(`${key}.unit`),
      items: units.filter((item) => propertyId === undefined || item.propertyId === propertyId),
      state: propertyState,
    },
    {
      type: 'siampark.agreements.contract',
      id: 'task-contract',
      label: t(`${key}.contract`),
      items: contracts,
      state: contractState,
    },
  ];
  return (
    <section className="flex flex-col gap-150 border-t border-border-primary pt-200">
      <h3 className="font-semibold">{t(`${key}.relatedRecords`)}</h3>
      {fields.map((field) => {
        const selected = refs.find((ref) => ref.resourceType === field.type);
        const options = field.items.map((item) => ({
          value: item.ref.resourceId,
          label: item.label,
          displayValue: item.label,
        }));
        if (selected !== undefined && !options.some((item) => item.value === selected.resourceId)) {
          options.push({
            value: selected.resourceId,
            label: t(`${key}.savedContext`),
            displayValue: t(`${key}.savedContext`),
          });
        }
        return (
          <SelectTemplate
            key={field.id}
            id={field.id}
            label={field.label}
            labelProps={{ className: 'font-label text-label-md' }}
            disabled={disabled || field.state !== 'ready'}
            items={[{ value: NONE, label: t(`${key}.noContext`), displayValue: t(`${key}.noContext`) }, ...options]}
            value={[selected?.resourceId ?? NONE]}
            onValueChange={({ value }) => {
              const item = field.items.find((candidate) => candidate.ref.resourceId === value[0]);
              let updated = refs.filter((ref) => ref.resourceType !== field.type);
              if (field.type === 'siampark.property.property') {
                updated = updated.filter((ref) => ref.resourceType !== 'siampark.property.unit');
              }
              if (item !== undefined) updated = [...updated, item.ref];
              // A unit always carries its owning property as well.
              if (field.type === 'siampark.property.unit' && item?.propertyId !== undefined) {
                const parent = properties.find((candidate) => candidate.ref.resourceId === item.propertyId);
                if (parent !== undefined)
                  updated = [...updated.filter((ref) => ref.resourceType !== 'siampark.property.property'), parent.ref];
              }
              onChange(updated);
            }}
          />
        );
      })}
      {(propertyState === 'failed' || contractState === 'failed') && (
        <StatusText status="warning">{t(`${key}.contextUnavailable`)}</StatusText>
      )}
    </section>
  );
};
