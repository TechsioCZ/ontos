import { executeRecords as propertyRecords } from '@app/property-portfolio/clients/records';
import { executeRecords as agreementRecords } from '@app/legal-agreements/clients/records';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Effect, Random, Schedule } from 'effect';
import { useEffect, useState } from 'react';
import type { ContextRef, LookupAccess } from '../../../../shared/apis/records.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';

const key = 'work-tasks.pages.records';
const NONE = 'none';
interface ContextOption {
  readonly ref: ContextRef;
  readonly label: string;
  readonly propertyId?: string;
}

/** Only the owning modules supply options; no cross-company directory or hard-coded fixture IDs. */
export const TaskContextPickers = ({
  lookupAccess,
  refs,
  disabled,
  onChange,
}: {
  readonly lookupAccess: LookupAccess | undefined;
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
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setPropertyState('loading');
    setContractState('loading');
    const correlation = Random.nextInt.pipe(Effect.map((id) => `work-context:${id}`));
    const propertyFiber =
      lookupAccess?.properties === 'allowed'
        ? browserRuntime.runFork(
            correlation.pipe(
              Effect.flatMap((id) => propertyRecords({}, id)),
              // The first open of a panel often races the gateway warming up; a short retry hides that blip.
              Effect.retry({ schedule: Schedule.spaced('800 millis'), times: 3 }),
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
          )
        : undefined;
    const contractFiber =
      lookupAccess?.contracts === 'allowed'
        ? browserRuntime.runFork(
            correlation.pipe(
              Effect.flatMap((id) => agreementRecords({}, id)),
              Effect.retry({ schedule: Schedule.spaced('800 millis'), times: 3 }),
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
          )
        : undefined;
    return () => {
      propertyFiber?.interruptUnsafe();
      contractFiber?.interruptUnsafe();
    };
  }, [lookupAccess?.properties, lookupAccess?.contracts, attempt]);
  const propertyId = refs.find((ref) => ref.resourceType === 'property.portfolio.property')?.resourceId;
  const fields = [
    {
      access: lookupAccess?.properties,
      type: 'property.portfolio.property',
      id: 'task-property',
      label: t(`${key}.property`),
      items: properties,
      state: propertyState,
    },
    {
      access: lookupAccess?.properties,
      type: 'property.portfolio.unit',
      id: 'task-unit',
      label: t(`${key}.unit`),
      items: units.filter((item) => propertyId === undefined || item.propertyId === propertyId),
      state: propertyState,
    },
    {
      access: lookupAccess?.contracts,
      type: 'legal.agreements.contract',
      id: 'task-contract',
      label: t(`${key}.contract`),
      items: contracts,
      state: contractState,
    },
  ];
  if (!fields.some((field) => field.access === 'allowed')) return null;
  return (
    <section className="flex flex-col gap-150 border-t border-border-primary pt-200">
      <h3 className="font-semibold">{t(`${key}.relatedRecords`)}</h3>
      {fields
        .filter((field) => field.access === 'allowed')
        .map((field) => {
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
                if (field.type === 'property.portfolio.property') {
                  updated = updated.filter((ref) => ref.resourceType !== 'property.portfolio.unit');
                }
                if (item !== undefined) updated = [...updated, item.ref];
                // A unit always carries its owning property as well.
                if (field.type === 'property.portfolio.unit' && item?.propertyId !== undefined) {
                  const parent = properties.find((candidate) => candidate.ref.resourceId === item.propertyId);
                  if (parent !== undefined)
                    updated = [
                      ...updated.filter((ref) => ref.resourceType !== 'property.portfolio.property'),
                      parent.ref,
                    ];
                }
                onChange(updated);
              }}
            />
          );
        })}
      {(propertyState === 'failed' || contractState === 'failed') && (
        <div className="flex flex-wrap items-center gap-150">
          <StatusText status="warning">{t(`${key}.contextUnavailable`)}</StatusText>
          <Button onClick={() => setAttempt((value) => value + 1)} size="sm" theme="outlined" variant="secondary">
            {t(`${key}.contextRetry`)}
          </Button>
        </div>
      )}
    </section>
  );
};
