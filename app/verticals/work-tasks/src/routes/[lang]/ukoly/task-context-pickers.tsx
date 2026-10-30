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
const propertyResourceType = 'property.portfolio.property';
const unitResourceType = 'property.portfolio.unit';
interface ContextOption {
  readonly label: string;
  readonly propertyId?: string;
  readonly ref: ContextRef;
}

interface ContextPickerProps {
  readonly disabled: boolean;
  readonly lookupAccess: LookupAccess | undefined;
  readonly onChange: (refs: readonly ContextRef[]) => void;
  readonly refs: readonly ContextRef[];
}

const propertyContextOptions = (records: Effect.Success<ReturnType<typeof propertyRecords>>) => ({
  properties: records.properties.map((item) => ({ label: `${item.code} · ${item.name}`, ref: item.propertyRef })),
  units: records.units.map((item) => ({
    label: `${item.code} · ${item.name}`,
    propertyId: item.propertyRef.resourceId,
    ref: item.unitRef,
  })),
});

const contractContextOptions = (
  records: Effect.Success<ReturnType<typeof agreementRecords>>,
  t: ReturnType<typeof useModernI18n>['t'],
) =>
  records.contracts.map((item) => {
    const kindLabel = item.kind === 'LEASE' ? t(`${key}.leaseContract`) : t(`${key}.otherContract`);
    return { label: `${item.subject ?? kindLabel} · ${item.startDate}`, ref: item.contractRef };
  });

/** Only the owning modules supply options; no cross-company directory or hard-coded fixture IDs. */
const ContextPickerRequest = ({
  disabled,
  lookupAccess,
  onChange,
  onRetry,
  refs,
}: ContextPickerProps & { readonly onRetry: () => void }) => {
  const { t } = useModernI18n();
  const [properties, setProperties] = useState<readonly ContextOption[]>([]);
  const [units, setUnits] = useState<readonly ContextOption[]>([]);
  const [contracts, setContracts] = useState<readonly ContextOption[]>([]);
  const [propertyState, setPropertyState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [contractState, setContractState] = useState<'loading' | 'ready' | 'failed'>('loading');
  useEffect(() => {
    const correlation = Random.nextInt.pipe(Effect.map((id) => `work-context:${id}`));
    const propertyFiber =
      lookupAccess?.properties === 'allowed'
        ? browserRuntime.runFork(
            correlation.pipe(
              Effect.flatMap((id) => propertyRecords({}, id)),
              // The first open of a panel often races the gateway warming up; a short retry hides that blip.
              Effect.retry({ schedule: Schedule.spaced('800 millis'), times: 3 }),
              Effect.matchEffect({
                onFailure: (error) =>
                  Effect.logWarning('Task property contexts are unavailable.', error).pipe(
                    Effect.andThen(Effect.sync(() => setPropertyState('failed'))),
                  ),
                onSuccess: (records) =>
                  Effect.sync(() => {
                    const options = propertyContextOptions(records);
                    setProperties(options.properties);
                    setUnits(options.units);
                    setPropertyState('ready');
                  }),
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
              Effect.matchEffect({
                onFailure: (error) =>
                  Effect.logWarning('Task agreement contexts are unavailable.', error).pipe(
                    Effect.andThen(Effect.sync(() => setContractState('failed'))),
                  ),
                onSuccess: (records) =>
                  Effect.sync(() => {
                    setContracts(contractContextOptions(records, t));
                    setContractState('ready');
                  }),
              }),
            ),
          )
        : undefined;
    return () => {
      propertyFiber?.interruptUnsafe();
      contractFiber?.interruptUnsafe();
    };
  }, [lookupAccess?.properties, lookupAccess?.contracts, t]);
  const propertyId = refs.find((ref) => ref.resourceType === propertyResourceType)?.resourceId;
  const fields = [
    {
      access: lookupAccess?.properties,
      id: 'task-property',
      items: properties,
      label: t(`${key}.property`),
      state: propertyState,
      type: propertyResourceType,
    },
    {
      access: lookupAccess?.properties,
      id: 'task-unit',
      items: units.filter((item) => propertyId === undefined || item.propertyId === propertyId),
      label: t(`${key}.unit`),
      state: propertyState,
      type: unitResourceType,
    },
    {
      access: lookupAccess?.contracts,
      id: 'task-contract',
      items: contracts,
      label: t(`${key}.contract`),
      state: contractState,
      type: 'legal.agreements.contract',
    },
  ];
  if (!fields.some((field) => field.access === 'allowed')) {
    return null;
  }
  return (
    <section className="flex flex-col gap-150 border-t border-border-primary pt-200">
      <h3 className="font-semibold">{t(`${key}.relatedRecords`)}</h3>
      {fields
        .filter((field) => field.access === 'allowed')
        .map((field) => {
          const selected = refs.find((ref) => ref.resourceType === field.type);
          const options = field.items.map((item) => ({
            displayValue: item.label,
            label: item.label,
            value: item.ref.resourceId,
          }));
          if (selected !== undefined && !options.some((item) => item.value === selected.resourceId)) {
            options.push({
              displayValue: t(`${key}.savedContext`),
              label: t(`${key}.savedContext`),
              value: selected.resourceId,
            });
          }
          return (
            <SelectTemplate
              disabled={disabled || field.state !== 'ready'}
              id={field.id}
              items={[{ displayValue: t(`${key}.noContext`), label: t(`${key}.noContext`), value: NONE }, ...options]}
              key={field.id}
              label={field.label}
              labelProps={{ className: 'font-label text-label-md' }}
              onValueChange={({ value }) => {
                const item = field.items.find((candidate) => candidate.ref.resourceId === value[0]);
                let updated = refs.filter((ref) => ref.resourceType !== field.type);
                if (field.type === propertyResourceType) {
                  updated = updated.filter((ref) => ref.resourceType !== unitResourceType);
                }
                if (item !== undefined) {
                  updated = [...updated, item.ref];
                }
                // A unit always carries its owning property as well.
                if (field.type === unitResourceType && item?.propertyId !== undefined) {
                  const parent = properties.find((candidate) => candidate.ref.resourceId === item.propertyId);
                  if (parent !== undefined) {
                    updated = [...updated.filter((ref) => ref.resourceType !== propertyResourceType), parent.ref];
                  }
                }
                onChange(updated);
              }}
              value={[selected?.resourceId ?? NONE]}
            />
          );
        })}
      {(propertyState === 'failed' || contractState === 'failed') && (
        <div className="flex flex-wrap items-center gap-150">
          <StatusText status="warning">{t(`${key}.contextUnavailable`)}</StatusText>
          <Button onClick={onRetry} size="sm" theme="outlined" variant="secondary">
            {t(`${key}.contextRetry`)}
          </Button>
        </div>
      )}
    </section>
  );
};

/** Retry and access changes start a fresh loading view; selected references stay with the parent form. */
export const TaskContextPickers = (props: ContextPickerProps) => {
  const [attempt, setAttempt] = useState(0);
  return (
    <ContextPickerRequest
      {...props}
      key={`${attempt}:${props.lookupAccess?.properties}:${props.lookupAccess?.contracts}`}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  );
};
