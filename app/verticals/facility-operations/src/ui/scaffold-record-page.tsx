// Minimal list + create page used by every agenda until its lane replaces its own page.tsx.
// Lanes may keep using it, extend it, or drop it for a custom page. Owned by ops-scaffold.
import { PageHeader, SidePanel, StatCard, StatRow, formatDateTime } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { DateTime, Effect } from 'effect';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { OpsCommand } from '../../shared/agendas.ts';
import type { AgendaId, AuditFields, PropertyRef } from '../../shared/domain/common.ts';
import { AgendaGate } from './agenda-frame.tsx';
import { usePropertyOptions } from './property-options.ts';
import { useAgendaRecords } from './use-agenda.ts';
import type { CommandOutcome, FailureReason } from './use-agenda.ts';

export interface ScaffoldField {
  readonly kind: 'text' | 'date' | 'select';
  readonly label: string;
  readonly maxLength?: number;
  readonly name: string;
  readonly options?: readonly { readonly label: string; readonly value: string }[];
  readonly required?: boolean;
}

export interface ScaffoldColumn<Row> {
  readonly cell: (row: Row) => ReactNode;
  readonly header: string;
  readonly id: string;
}

type ScaffoldAgendaState = NonNullable<
  NonNullable<ReturnType<typeof useAgendaRecords>['data']>['agendas'][AgendaId]
>['state'];

export interface ScaffoldRecordPageProps<Row extends AuditFields & { readonly id: string }> {
  readonly agenda: AgendaId;
  readonly columns: readonly ScaffoldColumn<Row>[];
  readonly fields: readonly ScaffoldField[];
  readonly rowLabel: (row: Row) => string;
  /** Picks the record list out of the loaded agenda state. */
  readonly rows: (state: ScaffoldAgendaState) => readonly Row[];
  /** Builds the create command from trimmed form values (empty optional values are omitted). */
  readonly toCommand: (values: Readonly<Record<string, string>>, location: PropertyRef | undefined) => OpsCommand;
}

const NO_LOCATION = 'none';

export const locationLabel = (location: PropertyRef | undefined, fallback: string) => location?.label ?? fallback;

/** Display-snapshot location typed by the user (until a lane wires the property-portfolio picker). */
const typedLocation = (value: string): PropertyRef | undefined => {
  const label = value.trim();
  return label === '' ? undefined : { id: `label:${label.toLowerCase()}`, kind: 'property', label };
};

export const ScaffoldRecordView = <Row extends AuditFields & { readonly id: string }>(
  props: ScaffoldRecordPageProps<Row>,
) => {
  const { t } = useModernI18n();
  const toast = useToast();
  const ops = useAgendaRecords([props.agenda]);
  const envelope = ops.data?.agendas[props.agenda];
  const rows = envelope === undefined ? [] : props.rows(envelope.state);
  const canWrite = envelope?.canWrite === true;
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [location, setLocation] = useState('');
  const properties = usePropertyOptions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureReason | 'required' | undefined>();
  const k = `facility-operations.${props.agenda}`;

  const reset = () => {
    setValues({});
    setLocation('');
    setError(undefined);
  };
  const finishSubmit = (outcome: CommandOutcome) =>
    Effect.sync(() => {
      setBusy(false);
      if (outcome.ok) {
        toast.create({ title: t(`${k}.created`), type: 'success' });
        reset();
        setOpen(false);
      } else {
        setError(outcome.reason);
      }
    });
  const submit = (): Effect.Effect<void> =>
    Effect.suspend(() => {
      const trimmed = Object.fromEntries(
        Object.entries(values).flatMap(([name, value]) => {
          const text = value.trim();
          return text === '' ? [] : [[name, text] as const];
        }),
      );
      if (props.fields.some((field) => field.required === true && trimmed[field.name] === undefined)) {
        return Effect.sync(() => setError('required'));
      }
      setBusy(true);
      const picked =
        properties.status === 'ready' ? properties.options.find((option) => option.value === location)?.ref : undefined;
      return ops
        .run(props.toCommand(trimmed, properties.status === 'ready' ? picked : typedLocation(location)))
        .pipe(Effect.tap(finishSubmit), Effect.asVoid);
    });

  const columns: ColumnDef<Row>[] = [
    ...props.columns.map((column): ColumnDef<Row> => ({
      cell: ({ row }): ReactNode => column.cell(row.original),
      header: column.header,
      id: column.id,
    })),
    {
      cell: ({ row }) => formatDateTime(DateTime.formatIso(row.original.updatedAt)),
      header: t('facility-operations.common.updatedAt'),
      id: 'updatedAt',
    },
  ];

  return (
    <>
      <PageHeader
        actions={
          canWrite ? (
            <Button onClick={() => setOpen(true)} size="sm" variant="primary">
              {t(`${k}.create.title`)}
            </Button>
          ) : undefined
        }
        description={t(`${k}.description`)}
        title={t(`${k}.title`)}
      />
      <AgendaGate
        onRetry={() => {
          browserRuntime.runFork(ops.reload());
        }}
        readable={envelope !== undefined}
        status={ops.status}
      >
        <StatRow>
          <StatCard label={t(`${k}.stats.count`)} value={String(rows.length)} />
          <StatCard
            label={t('facility-operations.common.updatedAt')}
            value={
              envelope === undefined || envelope.revision === 0
                ? t('facility-operations.common.noData')
                : formatDateTime(DateTime.formatIso(envelope.updatedAt))
            }
          />
        </StatRow>
        <DataTable
          columns={columns}
          data={[...rows]}
          getRowId={(row) => row.id}
          getRowLabel={(row) => props.rowLabel(row.original)}
          loading={false}
          translations={{
            emptyDescription: t('facility-operations.common.states.emptyDescription'),
            emptyTitle: t('facility-operations.common.states.emptyTitle'),
          }}
        />
      </AgendaGate>
      <SidePanel
        actions={
          <>
            <Button
              onClick={() => {
                reset();
                setOpen(false);
              }}
              theme="outlined"
              variant="secondary"
            >
              {t('facility-operations.common.cancel')}
            </Button>
            <Button
              isLoading={busy}
              loadingText={t('facility-operations.common.saving')}
              onClick={() => {
                browserRuntime.runFork(submit());
              }}
              variant="primary"
            >
              {t(`${k}.create.submit`)}
            </Button>
          </>
        }
        closeOnInteractOutside={false}
        onOpenChange={(next) => {
          if (!next) {
            setOpen(false);
          }
        }}
        open={open}
        resizeLabel={t('facility-operations.common.close')}
        size="md"
        title={t(`${k}.create.title`)}
      >
        <div className="flex flex-col gap-200 py-200">
          {error !== undefined && (
            <StatusText showIcon status="error">
              {error === 'required'
                ? t('facility-operations.common.required')
                : t(`facility-operations.common.errors.${error}`)}
            </StatusText>
          )}
          {props.fields.map((field) =>
            field.kind === 'select' ? (
              <Select
                items={(field.options ?? []).map((option) => ({
                  displayValue: option.label,
                  label: option.label,
                  value: option.value,
                }))}
                key={field.name}
                label={field.label}
                name={field.name}
                onValueChange={({ value }) => setValues((current) => ({ ...current, [field.name]: value[0] ?? '' }))}
                size="md"
                value={values[field.name] === undefined ? [] : [values[field.name] ?? '']}
              />
            ) : (
              <FormInput
                autoComplete="off"
                id={`ops-${props.agenda}-${field.name}`}
                key={field.name}
                label={field.label}
                maxLength={field.maxLength ?? 200}
                onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
                required={field.required === true}
                type={field.kind === 'date' ? 'date' : 'text'}
                value={values[field.name] ?? ''}
              />
            ),
          )}
          {properties.status === 'ready' ? (
            <Select
              items={[
                {
                  displayValue: t('facility-operations.property.none'),
                  label: t('facility-operations.property.none'),
                  value: NO_LOCATION,
                },
                ...properties.options.map((option) => ({
                  displayValue: option.ref.label,
                  label: option.ref.label,
                  value: option.value,
                })),
              ]}
              label={t('facility-operations.common.location')}
              name="location"
              onValueChange={({ value }) =>
                setLocation(value[0] === undefined || value[0] === NO_LOCATION ? '' : value[0])
              }
              size="md"
              value={[location === '' ? NO_LOCATION : location]}
            />
          ) : (
            <FormInput
              autoComplete="off"
              helpText={
                properties.status === 'failed'
                  ? t('facility-operations.property.loadFailed')
                  : t('facility-operations.common.locationPlaceholder')
              }
              id={`ops-${props.agenda}-location`}
              label={t('facility-operations.common.location')}
              maxLength={300}
              onChange={(event) => setLocation(event.target.value)}
              value={location}
            />
          )}
        </div>
      </SidePanel>
    </>
  );
};
