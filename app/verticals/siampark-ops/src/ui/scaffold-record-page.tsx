// @effect-diagnostics asyncFunction:off
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
import { DateTime } from 'effect';
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { OpsCommand } from '../../shared/agendas.ts';
import type { AgendaId, AuditFields, PropertyRef } from '../../shared/domain/common.ts';
import { AgendaGate } from './agenda-frame.tsx';
import { usePropertyOptions } from './property-options.ts';
import { useAgendaRecords } from './use-agenda.ts';
import type { FailureReason } from './use-agenda.ts';

export interface ScaffoldField {
  readonly name: string;
  readonly label: string;
  readonly kind: 'text' | 'date' | 'select';
  readonly required?: boolean;
  readonly options?: readonly { readonly label: string; readonly value: string }[];
  readonly maxLength?: number;
}

export interface ScaffoldColumn<Row> {
  readonly id: string;
  readonly header: string;
  readonly cell: (row: Row) => ReactNode;
}

export interface ScaffoldRecordPageProps<Row extends AuditFields & { readonly id: string }> {
  readonly agenda: AgendaId;
  /** Picks the record list out of the loaded agenda state. */
  readonly rows: (state: unknown) => readonly Row[];
  readonly columns: readonly ScaffoldColumn<Row>[];
  readonly fields: readonly ScaffoldField[];
  /** Builds the create command from trimmed form values (empty optional values are omitted). */
  readonly toCommand: (values: Readonly<Record<string, string>>, location: PropertyRef | undefined) => OpsCommand;
  readonly rowLabel: (row: Row) => string;
}

export const locationLabel = (location: PropertyRef | undefined, fallback: string) => location?.label ?? fallback;

/** Display-snapshot location typed by the user (until a lane wires the siampark-property picker). */
const typedLocation = (value: string): PropertyRef | undefined => {
  const label = value.trim();
  return label === '' ? undefined : { id: `label:${label.toLowerCase()}`, kind: 'property', label };
};

export const ScaffoldRecordView = <Row extends AuditFields & { readonly id: string }>(props: ScaffoldRecordPageProps<Row>) => {
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
  const NONE = 'none';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureReason | 'required' | undefined>(undefined);
  const k = `siampark-ops.${props.agenda}`;

  const reset = () => {
    setValues({});
    setLocation('');
    setError(undefined);
  };
  const submit = async () => {
    const trimmed = Object.fromEntries(
      Object.entries(values)
        .map(([name, value]) => [name, value.trim()] as const)
        .filter(([, value]) => value !== ''),
    );
    if (props.fields.some((field) => field.required === true && trimmed[field.name] === undefined)) {
      setError('required');
      return;
    }
    setBusy(true);
    const picked =
      properties.status === 'ready' ? properties.options.find((option) => option.value === location)?.ref : undefined;
    const outcome = await ops.run(
      props.toCommand(trimmed, properties.status === 'ready' ? picked : typedLocation(location)),
    );
    setBusy(false);
    if (outcome.ok) {
      toast.create({ title: t(`${k}.created`), type: 'success' });
      reset();
      setOpen(false);
    } else {
      setError(outcome.reason);
    }
  };

  const columns: ColumnDef<Row>[] = [
    ...props.columns.map(
      (column): ColumnDef<Row> => ({
        cell: ({ row }) => column.cell(row.original),
        header: column.header,
        id: column.id,
      }),
    ),
    {
      cell: ({ row }) => formatDateTime(DateTime.formatIso(row.original.updatedAt)),
      header: t('siampark-ops.common.updatedAt'),
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
      <AgendaGate onRetry={() => void ops.reload()} readable={envelope !== undefined} status={ops.status}>
        <StatRow>
          <StatCard label={t(`${k}.stats.count`)} value={String(rows.length)} />
          <StatCard
            label={t('siampark-ops.common.updatedAt')}
            value={
              envelope === undefined || envelope.revision === 0
                ? t('siampark-ops.common.noData')
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
            emptyDescription: t('siampark-ops.common.states.emptyDescription'),
            emptyTitle: t('siampark-ops.common.states.emptyTitle'),
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
              {t('siampark-ops.common.cancel')}
            </Button>
            <Button
              isLoading={busy}
              loadingText={t('siampark-ops.common.saving')}
              onClick={() => void submit()}
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
        resizeLabel={t('siampark-ops.common.close')}
        size="md"
        title={t(`${k}.create.title`)}
      >
        <div className="flex flex-col gap-200 py-200">
          {error !== undefined && (
            <StatusText showIcon status="error">
              {error === 'required' ? t('siampark-ops.common.required') : t(`siampark-ops.common.errors.${error}`)}
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
                { displayValue: t('siampark-ops.property.none'), label: t('siampark-ops.property.none'), value: NONE },
                ...properties.options.map((option) => ({
                  displayValue: option.ref.label,
                  label: option.ref.label,
                  value: option.value,
                })),
              ]}
              label={t('siampark-ops.common.location')}
              name="location"
              onValueChange={({ value }) => setLocation(value[0] === undefined || value[0] === NONE ? '' : value[0])}
              size="md"
              value={[location === '' ? NONE : location]}
            />
          ) : (
            <FormInput
              autoComplete="off"
              helpText={
                properties.status === 'failed'
                  ? t('siampark-ops.property.loadFailed')
                  : t('siampark-ops.common.locationPlaceholder')
              }
              id={`ops-${props.agenda}-location`}
              label={t('siampark-ops.common.location')}
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
