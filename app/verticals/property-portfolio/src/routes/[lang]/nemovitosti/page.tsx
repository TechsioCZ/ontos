import { PropertyEquipment, RecordDiscussion } from '@app/facility-operations/ui/record-discussion';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Table } from '@techsio/ui-kit/organisms/table';
import { Link } from '@techsio/ui-kit/atoms/link';
import { useNavigate, useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { pageDataPending } from '@app/shared-contracts/page-data';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { DateTime, Effect, Match, Option, Result, Schema } from 'effect';
import { useEffect, useEffectEvent, useId, useRef, useState, useSyncExternalStore } from 'react';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import {
  autosavePropertyEdit,
  currentEditDraft,
  editCommandOf,
  editUnchangedSince,
  propertyDraftErrors,
  responsibleSelection,
  sameEditDraft,
  usePropertyEditor,
  withLifecycle,
  withResponsibleEmployees,
  withTextField,
} from './use-property-editor.ts';
import type { PropertyDraft } from './use-property-editor.ts';
import { ResponsibleEmployeesField } from './responsible-employees-field.tsx';
import { AutosaveStatus, useAutosaveDraft } from '@app/admin-ui';
import type { RevisionedSaveResult } from '@app/admin-ui';
import type { PropertyCommand } from '../../../../shared/actions/apply-command.ts';
import { UnitStory, pragueToday } from './unit-story.tsx';
import type { LeaseBlock } from './unit-story.tsx';
import type { RecordsResponse } from '../../../../shared/apis/records';
import { browserRuntime } from '../../../runtime/browser-effect-runtime';
import { UltramodernRouteHead } from '../../ultramodern-route-head';
import csResource from '../../../../locales/cs/property-portfolio.json';
import enResource from '../../../../locales/en/property-portfolio.json';
import { projectPropertyRelatedRecords } from './property-relations.ts';
import {
  PropertySearchInputSchema,
  propertyRecordVisible,
  propertySelection,
  propertyTabs,
  readPropertySearch,
  selectedPropertyTab,
  selectPropertyResource,
} from './property-navigation.ts';
import type { PropertySearch, PropertyTab } from './property-navigation.ts';
import { PropertyWorkspace } from './property-workspace.tsx';
import csWorkspace from '../../../../locales/cs/property-workspace.json';
import enWorkspace from '../../../../locales/en/property-workspace.json';
import '../../index.css';
import {
  propertyRecords,
  recordsInput,
  usePropertySummary,
  usePrefetchPropertySummaries,
  renderedPropertySummaryRows,
} from './property-summary.ts';
import type { RecordsInput } from './property-summary.ts';

export { preloadPage } from './property-summary.ts';

const currencyFormatters = {
  cs: new Intl.NumberFormat('cs-CZ', { currency: 'CZK', style: 'currency' }),
  en: new Intl.NumberFormat('en-GB', { currency: 'CZK', style: 'currency' }),
};
const propertyPortfolioI18nResources = {
  cs: { 'property-portfolio': csResource, 'property-workspace': csWorkspace },
  en: { 'property-portfolio': enResource, 'property-workspace': enWorkspace },
} as const;

export { projectPropertyRelatedRecords } from './property-relations.ts';
const usePropertyRecords = (input: RecordsInput) => {
  const { language, t } = useModernI18n();
  const rawSearch: unknown = useRouterState().location.search;
  const search = readPropertySearch(Schema.is(PropertySearchInputSchema)(rawSearch) ? rawSearch : null);
  const { resourceId } = search;
  const key = 'property-portfolio.pages.records';
  const snapshot = useSyncExternalStore(
    (listener) => propertyRecords.subscribe(listener, input),
    () => propertyRecords.snapshot(input),
    () => pageDataPending,
  );
  const { scope } = input;
  const ensureRecords = useEffectEvent((currentScope: string) =>
    propertyRecords.ensure({ ...input, scope: currentScope }),
  );
  useEffect(() => {
    ensureRecords(scope);
  }, [scope]);
  const records = snapshot.state === 'ready' ? snapshot.value.records : undefined;
  const employees = snapshot.state === 'ready' ? Result.getOrUndefined(snapshot.value.employees) : undefined;
  const employeesMessage =
    snapshot.state === 'ready' && Result.isFailure(snapshot.value.employees)
      ? Match.value(snapshot.value.employees.failure).pipe(
          Match.tag('RecordsForbiddenProblem', () => t(`${key}.editor.employeesForbidden`)),
          Match.orElse(() => t(`${key}.editor.employeesUnavailable`)),
        )
      : '';
  const recordsLoading = snapshot.state === 'pending' || snapshot.refreshing;
  const message =
    snapshot.state === 'failed'
      ? Match.value(snapshot.error).pipe(
          Match.tag('RecordsForbiddenProblem', () => t(`${key}.forbidden`)),
          Match.orElse(() => t(`${key}.unavailable`)),
        )
      : '';
  const { assetId, propertyId, unitId } = propertySelection(records, resourceId);
  const navigate = useNavigate();
  const updateSearch = (next: PropertySearch) => {
    void navigate({ search: next, to: '.' });
  };
  const selectResource = (id: string | undefined) => {
    const next = selectPropertyResource(search, id);
    if (id !== undefined) {
      const target = propertySelection(records, id);
      if (target.propertyId === '') {
        delete next.tab;
      } else {
        next.tab = selectedPropertyTab(search, target.unitId !== '', target.assetId !== '');
      }
    }
    updateSearch(next);
  };
  const property = records?.properties.find((item) => item.propertyRef.resourceId === propertyId);
  const units = records?.units.filter((item) => item.propertyRef.resourceId === propertyId) ?? [];
  const assets = records?.assets.filter((item) => item.propertyRef.resourceId === propertyId) ?? [];
  const unit = units.find((item) => item.unitRef.resourceId === unitId);
  const asset = assets.find((item) => item.assetRef.resourceId === assetId);
  const { agreements, finance, loadSummary, occupancy, summaryFailures, summaryPending, work } = usePropertySummary({
    ...input,
    propertyId,
    revision: records?.revision ?? 0,
  });
  const summaryMessage = summaryFailures.map((failure) => t(`${key}.${failure}`)).join(' · ');
  const ownerHref = (owner: string, id: string) => `/${language ?? 'cs'}/${owner}?resourceId=${encodeURIComponent(id)}`;
  const refresh = () => {
    browserRuntime.runFork(propertyRecords.refresh(input));
    loadSummary();
  };
  const referenceDate = pragueToday();
  const availability = (id: string) => {
    const covering =
      occupancy?.occupancies.filter(
        (item) =>
          item.unitRef.resourceId === id &&
          item.unitRef.tenantId === property?.propertyRef.tenantId &&
          item.startDate <= referenceDate &&
          (item.endDate === null || referenceDate < item.endDate),
      ) ?? [];
    if (covering.some((item) => item.state === 'ACTIVE')) {
      return 'OCCUPIED';
    }
    return covering.some((item) => item.state === 'CONFIRMED') ? 'RESERVED' : 'AVAILABLE';
  };
  const money = (minor: number) =>
    (language === 'en' ? currencyFormatters.en : currencyFormatters.cs).format(minor / 100);
  const { activeOccupancies, propertyContracts, propertyDocuments, propertyTasks } = projectPropertyRelatedRecords({
    agreements,
    assets,
    occupancy,
    property,
    unit,
    units,
    work,
  });
  const unitName = (id: string | undefined) => units.find((item) => item.unitRef.resourceId === id)?.name ?? '—';
  const relatedSections = [
    {
      enabled: occupancy !== undefined,
      items: activeOccupancies.map((item) => ({
        href: ownerHref('najmy', item.occupancyRef.resourceId),
        label: [
          unitName(item.unitRef.resourceId),
          t(`${key}.occupancyRecord`, { end: item.endDate ?? '—', start: item.startDate }),
          t(`${key}.occupancyStates.${item.state}`),
        ].join(' · '),
      })),
      kind: 'leases' as const,
      title: t(`${key}.occupancies`),
    },
    {
      enabled: agreements !== undefined,
      items: propertyContracts.map((item) => ({
        href: ownerHref('smlouvy', item.contractRef.resourceId),
        label: [
          unitName(item.unitRef?.resourceId),
          t(`${key}.agreementRecord`, { end: item.endDate ?? '—', start: item.startDate }),
          t(`${key}.agreementStates.${item.lifecycleState}`),
        ].join(' · '),
      })),
      kind: 'agreements' as const,
      title: t(`${key}.agreements`),
    },
    {
      enabled: agreements !== undefined,
      items: propertyDocuments.map((item) => ({
        href: ownerHref('smlouvy', item.contractRef?.resourceId ?? ''),
        label: [item.title, item.fileName].filter(Boolean).join(' · '),
      })),
      kind: 'documents' as const,
      title: t(`${key}.documents`),
    },
    {
      enabled: work !== undefined,
      items: propertyTasks.map((item) => ({ href: ownerHref('ukoly', item.ref.resourceId), label: item.title })),
      kind: 'tasks' as const,
      title: t(`${key}.tasks`),
    },
  ];
  const tables = [
    {
      kind: 'units',
      rows: units.map((item) => ({
        archived: item.archive !== undefined || property?.archive !== undefined,
        code: item.code,
        id: item.unitRef.resourceId,
        name: item.name,
        property: null,
        state: item.lifecycleState,
      })),
      select: selectResource,
    },
    {
      kind: 'assets',
      rows: assets.flatMap((item) =>
        unit === undefined ||
        (item.unitRef?.resourceId === unit.unitRef.resourceId && item.unitRef.tenantId === unit.unitRef.tenantId)
          ? [
              {
                archived: property?.archive !== undefined,
                code: item.code,
                id: item.assetRef.resourceId,
                name: item.name,
                property: null,
                state: item.lifecycleState,
              },
            ]
          : [],
      ),
      select: selectResource,
    },
  ];
  return {
    agreements,
    asset,
    assets,
    availability,
    employees,
    employeesMessage,
    finance,
    key,
    language: language ?? 'cs',
    loadSummary,
    message,
    money,
    occupancy,
    ownerHref,
    pending: recordsLoading || summaryPending,
    property,
    records,
    recordsLoading,
    refresh,
    relatedSections,
    search,
    selectResource,
    summaryMessage,
    t,
    tables,
    unit,
    units,
    updateSearch,
    work,
  };
};
const secondaryTextClass = 'propertyportfolio:text-sm propertyportfolio:text-(--color-fg-secondary)';
const relatedCardClass = 'propertyportfolio:min-w-0 space-y-250';
const detailHeadingClass = 'propertyportfolio:font-semibold';
const tableWrapperClass = 'propertyportfolio:min-w-0 propertyportfolio:overflow-x-auto';
const archivedAtFormat = new Intl.DateTimeFormat('cs-CZ', { dateStyle: 'medium', timeZone: 'Europe/Prague' });
const formatArchivedAt = (value: string) => archivedAtFormat.format(DateTime.toEpochMillis(DateTime.makeUnsafe(value)));
type RecordsModel = ReturnType<typeof usePropertyRecords>;
type PropertyEditor = ReturnType<typeof usePropertyEditor>;
interface RecordsView {
  readonly availabilityLabel: (id: string, lifecycle: string) => string;
  readonly editor: PropertyEditor;
  readonly leasable: (lifecycle: string) => boolean;
  readonly model: RecordsModel;
  readonly requestArchive: (label: string, onConfirm: (reason: string) => void) => void;
  readonly requestRetire: (unit: RecordsResponse['units'][number]) => void;
}
interface RecordConfirmation {
  readonly description: string;
  readonly initialReason?: string;
  readonly onConfirm: (reason: string) => void;
  readonly title: string;
}
const RecordsConfirmation = ({
  onClose,
  request,
  view,
}: {
  readonly onClose: () => void;
  readonly request: RecordConfirmation;
  readonly view: RecordsView;
}) => {
  const { key, t } = view.model;
  const [reason, setReason] = useState(request.initialReason ?? '');
  const needsReason = request.initialReason !== undefined;
  const confirm = () => {
    if (view.editor.busy || (needsReason && reason.trim() === '')) {
      return;
    }
    request.onConfirm(reason.trim());
    onClose();
  };
  return (
    <Dialog
      actions={
        <>
          <Button onClick={onClose} theme="outlined" type="button" variant="secondary">
            {t(`${key}.editor.cancel`)}
          </Button>
          <Button
            disabled={view.editor.busy || (needsReason && reason.trim() === '')}
            onClick={confirm}
            type="button"
            variant="danger"
          >
            {needsReason ? t(`${key}.editor.archiveConfirm`) : t(`${key}.editor.retireConfirm`)}
          </Button>
        </>
      }
      closeLabel={t(`${key}.editor.cancel`)}
      customTrigger
      description={request.description}
      onOpenChange={({ open }) => {
        if (!open) {
          onClose();
        }
      }}
      open
      role="alertdialog"
      size="sm"
      title={request.title}
    >
      {needsReason && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            confirm();
          }}
        >
          <FormInput
            id="record-archive-reason"
            label={t(`${key}.editor.archiveReason`)}
            onChange={(event) => setReason(event.target.value)}
            required
            value={reason}
          />
        </form>
      )}
    </Dialog>
  );
};
const unitLeaseBlock = (
  unit: RecordsResponse['units'][number],
  archived: boolean,
  leasable: RecordsView['leasable'],
): LeaseBlock | undefined => {
  if (archived || unit.lifecycleState === 'RETIRED') {
    return 'retired';
  }
  if (unit.lifecycleState === 'ACTIVE') {
    return leasable(unit.lifecycleState) ? undefined : 'building';
  }
  return 'outOfService';
};

interface EditorFieldsProps {
  readonly disabled: boolean;
  readonly draft: PropertyDraft;
  readonly errors: PropertyEditor['errors'];
  readonly fields: PropertyEditor['fields'];
  readonly model: RecordsModel;
  readonly onBlur: () => void;
  readonly onEmployees: (value: string | string[]) => void;
  readonly onLifecycle: (value: string) => void;
  readonly onText: (field: Exclude<PropertyEditor['fields'][number], 'responsibleEmployeeIds'>, value: string) => void;
}

/** The fields of a building or unit, shared by the create dialog and the autosaving edit dialog. */
const RecordsEditorFields = ({
  disabled,
  draft,
  errors,
  fields,
  model,
  onBlur,
  onEmployees,
  onLifecycle,
  onText,
}: EditorFieldsProps) => {
  const { key, t } = model;
  const propertyDraft = draft.unitFor === undefined && draft.unit === undefined;
  return (
    <>
      {fields.map((field) => {
        if (field === 'responsibleEmployeeIds') {
          return (
            <ResponsibleEmployeesField
              copy={{
                empty: t(`${key}.editor.employeesEmpty`),
                label: t(`${key}.editor.responsiblePerson`),
                loading: t(`${key}.editor.employeesLoading`),
                placeholder: t(`${key}.editor.employeesPlaceholder`),
                required: t(`${key}.editor.responsibleRequired`),
                retry: t(`${key}.editor.employeesRetry`),
                unavailable: t(`${key}.editor.employeeUnknown`),
              }}
              disabled={disabled}
              error={model.employeesMessage}
              invalid={errors.responsibleEmployeeIds !== undefined}
              key={field}
              loading={model.recordsLoading}
              onChange={onEmployees}
              onRetry={() => model.refresh()}
              selection={responsibleSelection(draft, model.employees)}
            />
          );
        }
        if (field === 'note') {
          return (
            <FormTextarea
              disabled={disabled}
              id="property-note"
              key={field}
              label={t(`${key}.editor.note`)}
              onBlur={onBlur}
              onChange={(event) => onText('note', event.target.value)}
              value={draft.note}
            />
          );
        }
        return (
          <FormInput
            disabled={disabled || (field === 'code' && draft.property !== undefined)}
            id={`property-${field}`}
            key={field}
            label={t(`${key}.editor.${field}`)}
            onBlur={onBlur}
            onChange={(event) => onText(field, event.target.value)}
            required
            value={draft[field]}
            {...(errors[field] === undefined
              ? {}
              : {
                  helpText: t(`${key}.editor.${errors[field]}`, { field: t(`${key}.editor.${field}`) }),
                  validateStatus: 'error' as const,
                })}
          />
        );
      })}
      {propertyDraft && (
        <Combobox
          allowCustomValue={false}
          disabled={disabled}
          id="property-lifecycle"
          items={(['PLANNED', 'ACTIVE', 'INACTIVE', 'DISPOSED'] as const).map((value) => ({
            label: t(`${key}.states.${value}`),
            value,
          }))}
          label={t(`${key}.state`)}
          onChange={(value) => onLifecycle(Array.isArray(value) ? (value[0] ?? '') : value)}
          value={[draft.lifecycleState]}
        />
      )}
    </>
  );
};

const noBlur = () => {
  // A new record is saved only on "Uložit".
};

const unitFields = ['name', 'note'] as const;
const propertyFields = ['code', 'name', 'address', 'propertyType', 'responsibleEmployeeIds', 'note'] as const;

/**
 * Edit an existing building or unit. Changes save themselves (debounced, on blur and on Zavřít) against the revision
 * the draft builds on; when someone else changed the record, the dialog offers the current version instead.
 */
const RecordsEditPanel = ({ base: opened, view }: { readonly base: PropertyDraft; readonly view: RecordsView }) => {
  const { editor, model } = view;
  const { key, records, t } = model;
  const server = (records === undefined ? undefined : currentEditDraft(opened, records)) ?? opened;
  /** The version of the record the draft builds on: what it opened with, last saved or reloaded. */
  const base = useRef(server);
  const rememberSaved = (value: PropertyDraft, result: RevisionedSaveResult) => {
    if (result !== 'conflict' && result !== 'failed') {
      base.current = value;
    }
  };
  const send = (value: PropertyDraft, expectedRevision: number, command: PropertyCommand) =>
    autosavePropertyEdit(command, expectedRevision, editUnchangedSince(base.current)).pipe(
      Effect.tap((result) => Effect.sync(() => rememberSaved(value, result))),
    );
  const autosave = useAutosaveDraft<PropertyDraft, never>({
    equals: sameEditDraft,
    isValid: (value) => Option.isSome(editCommandOf(value, records)),
    revision: records?.revision ?? 0,
    runtime: browserRuntime,
    save: (value, expectedRevision) =>
      Option.match(editCommandOf(value, records), {
        onNone: () => Effect.succeed<RevisionedSaveResult>('failed'),
        onSome: (command) => send(value, expectedRevision, command),
      }),
    server,
  });
  const settledOnServer = !autosave.pending && sameEditDraft(autosave.draft, server);
  useEffect(() => {
    if (settledOnServer) {
      base.current = server;
    }
  }, [base, server, settledOnServer]);
  const { draft } = autosave;
  const close = () => {
    autosave.flush();
    editor.closeEdit();
  };
  const handleBlur = autosave.flush;
  const handleRetry = autosave.retry;
  const handleReloadLatest = autosave.reloadLatest;
  const isUnit = draft.unit !== undefined;
  return (
    <Dialog
      actions={
        <>
          <AutosaveStatus onReloadLatest={handleReloadLatest} onRetry={handleRetry} status={autosave.status} />
          <Button onClick={close} theme="outlined" variant="secondary">
            {t(`${key}.editor.close`)}
          </Button>
        </>
      }
      closeLabel={t(`${key}.editor.close`)}
      customTrigger
      onOpenChange={({ open }) => {
        if (!open) {
          close();
        }
      }}
      open
      size="lg"
      title={t(`${key}.editor.${isUnit ? 'editUnit' : 'edit'}`, {
        name: draft.unit?.name ?? draft.property?.name ?? '',
      })}
    >
      <form
        className="propertyportfolio:grid gap-250"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          autosave.flush();
        }}
      >
        <RecordsEditorFields
          disabled={false}
          draft={draft}
          errors={propertyDraftErrors(draft, records)}
          fields={isUnit ? unitFields : propertyFields}
          model={model}
          onBlur={handleBlur}
          onEmployees={(value) => autosave.setDraft((current) => withResponsibleEmployees(current, value))}
          onLifecycle={(value) => autosave.setDraft((current) => withLifecycle(current, value))}
          onText={(field, value) => autosave.setDraft((current) => withTextField(current, field, value))}
        />
      </form>
    </Dialog>
  );
};

const RecordsEditorForm = ({ view }: { readonly view: RecordsView }) => {
  const { editor, model } = view;
  const { key, t } = model;
  const { draft, editing } = editor;
  if (editing !== undefined) {
    return (
      <RecordsEditPanel
        base={editing}
        key={editing.unit?.unitRef.resourceId ?? editing.property?.propertyRef.resourceId}
        view={view}
      />
    );
  }
  if (draft === undefined) {
    return null;
  }
  const propertyDraft = draft.unitFor === undefined && draft.unit === undefined;
  return (
    <Dialog
      actions={
        <>
          <Button disabled={editor.busy} onClick={() => editor.cancel()} theme="outlined" variant="secondary">
            {t(`${key}.editor.cancel`)}
          </Button>
          <Button
            disabled={editor.busy || editor.blocked || (propertyDraft && model.employees === undefined)}
            form="property-record-editor"
            isLoading={editor.busy}
            type="submit"
            variant="primary"
          >
            {t(`${key}.editor.save`)}
          </Button>
        </>
      }
      closeLabel={t(`${key}.editor.cancel`)}
      customTrigger
      onOpenChange={({ open }) => {
        if (!open && !editor.busy) {
          editor.cancel();
        }
      }}
      open
      size="lg"
      title={
        draft.unitFor === undefined
          ? t(`${key}.editor.${editor.title}`, { name: draft.unit?.name ?? draft.property?.name ?? '' })
          : t(`${key}.editor.createUnitIn`, { name: draft.unitFor.name })
      }
    >
      <form
        className="propertyportfolio:grid gap-250"
        id="property-record-editor"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          editor.save();
        }}
      >
        <RecordsEditorFields
          disabled={editor.busy}
          draft={draft}
          errors={editor.errors}
          fields={editor.fields}
          model={model}
          onBlur={noBlur}
          onEmployees={(value) => editor.changeResponsibleEmployees(value)}
          onLifecycle={(value) => editor.changeLifecycle(value)}
          onText={(field, value) => editor.change(field, value)}
        />
        {editor.feedback !== undefined && <output>{t(`${key}.editor.${editor.feedback}`)}</output>}
      </form>
    </Dialog>
  );
};

const RecordsTables = ({ kind, view }: { readonly kind: 'units' | 'assets'; readonly view: RecordsView }) => {
  const { availabilityLabel, editor, model } = view;
  const { key, t } = model;
  const group = model.tables.find((item) => item.kind === kind);
  const rows =
    group?.rows.filter((item) =>
      propertyRecordVisible(
        {
          archived: item.archived,
          closed: kind === 'units' && item.state === 'RETIRED',
          selected: item.id === model.search.resourceId || item.id === model.unit?.unitRef.resourceId,
        },
        model.search,
      ),
    ) ?? [];
  if (rows.length === 0) {
    return kind === 'units' ? <p>{t(`${key}.noUnits`)}</p> : null;
  }
  return (
    <div className={tableWrapperClass}>
      <Table size="sm" variant="line">
        <Table.Caption className="propertyportfolio:sr-only">{t(`${key}.${kind}`)}</Table.Caption>
        <Table.Header>
          <Table.Row>
            {['code', 'name', 'state', 'detail'].map((column) => (
              <Table.ColumnHeader key={column}>{t(`${key}.${column}`)}</Table.ColumnHeader>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((item) => (
            <Table.Row key={item.id}>
              <Table.Cell>{item.code}</Table.Cell>
              <Table.Cell>{item.name}</Table.Cell>
              <Table.Cell>
                <Badge size="sm" variant={item.state === 'ACTIVE' ? 'success' : 'outline'}>
                  {t(`${key}.states.${item.state}`)}
                </Badge>
                {item.archived && (
                  <Badge size="sm" variant="secondary">
                    {t(`${key}.archived`)}
                  </Badge>
                )}
                {kind === 'units' && <p className={secondaryTextClass}>{availabilityLabel(item.id, item.state)}</p>}
              </Table.Cell>
              <Table.Cell>
                <Button
                  disabled={editor.busy}
                  onClick={() => model.selectResource(item.id)}
                  size="sm"
                  theme="outlined"
                  variant="secondary"
                >
                  {t(`${key}.detail`)}
                </Button>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
};

const RecordsUnitActions = ({ view }: { readonly view: RecordsView }) => {
  const { editor, model, requestArchive, requestRetire } = view;
  const { key, t, unit } = model;
  const disabled = editor.busy || editor.blocked;
  if (unit === undefined) {
    return null;
  }
  const archived = unit.archive ?? model.property?.archive;
  return (
    <>
      {archived === undefined && (
        <Button disabled={disabled} onClick={() => editor.beginUnitEdit(unit)} theme="outlined" variant="secondary">
          {t(`${key}.editor.editUnit`, { name: unit.name })}
        </Button>
      )}
      {unit.lifecycleState === 'RETIRED' && archived === undefined && (
        <Button
          disabled={disabled}
          onClick={() =>
            requestArchive(t(`${key}.unitLabel`, { code: unit.code }), (reason) => editor.archiveUnit(unit, reason))
          }
          theme="outlined"
          variant="danger"
        >
          {t(`${key}.archiveUnit`)}
        </Button>
      )}
      {unit.archive !== undefined && model.property?.archive === undefined && (
        <Button disabled={disabled} onClick={() => editor.restoreUnit(unit)} theme="outlined" variant="secondary">
          {t(`${key}.restore`)}
        </Button>
      )}
      {archived === undefined && unit.lifecycleState === 'ACTIVE' && (
        <Button
          disabled={disabled}
          onClick={() => editor.changeUnitLifecycle(unit, 'OUT_OF_SERVICE')}
          theme="outlined"
          variant="secondary"
        >
          {t(`${key}.setOutOfService`)}
        </Button>
      )}
      {archived === undefined &&
        unit.lifecycleState === 'OUT_OF_SERVICE' &&
        model.property?.lifecycleState !== 'DISPOSED' && (
          <Button
            disabled={disabled}
            onClick={() => editor.changeUnitLifecycle(unit, 'ACTIVE')}
            theme="outlined"
            variant="secondary"
          >
            {t(`${key}.returnToService`)}
          </Button>
        )}
      {archived === undefined && unit.lifecycleState !== 'RETIRED' && (
        <Button disabled={disabled} onClick={() => requestRetire(unit)} theme="outlined" variant="danger">
          {t(`${key}.retireUnit`)}
        </Button>
      )}
    </>
  );
};

const RecordsPropertyActions = ({ view }: { readonly view: RecordsView }) => {
  const { editor, model, requestArchive } = view;
  const { key, property, t } = model;
  if (property === undefined) {
    return null;
  }
  if (property.archive !== undefined) {
    return (
      <Button
        disabled={editor.busy || editor.blocked}
        onClick={() => editor.restoreProperty(property)}
        theme="outlined"
        variant="secondary"
      >
        {t(`${key}.restore`)}
      </Button>
    );
  }
  return (
    <>
      <Button
        disabled={editor.busy || editor.blocked}
        onClick={() => editor.begin(property)}
        theme="outlined"
        variant="secondary"
      >
        {t(`${key}.editor.edit`)}
      </Button>
      <Button
        disabled={editor.busy || editor.blocked}
        onClick={() => editor.toggleLifecycle(property)}
        theme="outlined"
        variant="secondary"
      >
        {t(`${key}.editor.${property.lifecycleState === 'ACTIVE' ? 'deactivate' : 'activate'}`)}
      </Button>
      {property.lifecycleState !== 'ACTIVE' && (
        <Button
          disabled={editor.busy || editor.blocked}
          onClick={() =>
            requestArchive(t(`${key}.propertyLabel`, { code: property.code }), (reason) =>
              editor.archiveProperty(property, reason),
            )
          }
          theme="outlined"
          variant="danger"
        >
          {t(`${key}.archiveProperty`)}
        </Button>
      )}
    </>
  );
};

const RecordsMetadata = ({ view }: { readonly view: RecordsView }) => {
  const { model } = view;
  const { key, property, t, unit } = model;
  if (property === undefined) {
    return null;
  }
  const archive = unit?.archive ?? property.archive;
  const note = unit === undefined ? property.note : unit.note;
  return (
    <div className="space-y-200">
      <h2 className="propertyportfolio:text-xl propertyportfolio:font-semibold">{unit?.name ?? property.name}</h2>
      <p className={secondaryTextClass}>{unit === undefined ? property.address : unit.code}</p>
      {unit === undefined ? (
        <dl className="propertyportfolio:grid gap-200 propertyportfolio:sm:grid-cols-2">
          <div>
            <dt className={secondaryTextClass}>{t(`${key}.editor.propertyType`)}</dt>
            <dd>{property.propertyType ?? t(`${key}.notProvided`)}</dd>
          </div>
          <div>
            <dt className={secondaryTextClass}>{t(`${key}.editor.responsiblePerson`)}</dt>
            <dd>
              {property.responsibleEmployeeIds === undefined
                ? (property.responsiblePerson ?? t(`${key}.editor.responsibleNotSet`))
                : property.responsibleEmployeeIds
                    .map(
                      (id) =>
                        model.employees?.find((employee) => employee.id === id)?.fullName ??
                        t(`${key}.editor.employeeUnknown`, { id }),
                    )
                    .join(', ')}
            </dd>
          </div>
        </dl>
      ) : (
        <dl className="propertyportfolio:grid gap-200 propertyportfolio:sm:grid-cols-2">
          <div>
            <dt className={secondaryTextClass}>{t(`${key}.kind`)}</dt>
            <dd>{unit.unitKind ?? t(`${key}.notProvided`)}</dd>
          </div>
          <div>
            <dt className={secondaryTextClass}>{t(`${key}.capacity`)}</dt>
            <dd>{unit.capacity ?? t(`${key}.notProvided`)}</dd>
          </div>
        </dl>
      )}
      {note !== null && note !== '' && <p>{note}</p>}
      {archive !== undefined && (
        <output>
          {t(`${key}.archiveDetails`, { date: formatArchivedAt(archive.archivedAt), reason: archive.reason })}
        </output>
      )}
      {unit?.lifecycleState === 'RETIRED' && <p>{t(`${key}.retiredDescription`)}</p>}
      {property.lifecycleState !== 'ACTIVE' && <p>{t(`${key}.buildingBlocked`)}</p>}
    </div>
  );
};

const RecordsUnavailable = ({ failure, view }: { readonly failure: string; readonly view: RecordsView }) => {
  const { model } = view;
  const { key, t } = model;
  return (
    <div className="space-y-200">
      <output>{t(`${key}.${model.pending ? 'loading' : failure}`)}</output>
      {!model.pending && (
        <Button onClick={() => model.loadSummary()} theme="outlined" variant="secondary">
          {t(`${key}.retry`)}
        </Button>
      )}
    </div>
  );
};

const RecordsEquipment = ({ view }: { readonly view: RecordsView }) => {
  const { model } = view;
  const { asset, key, property, t, unit } = model;
  if (property === undefined) {
    return null;
  }
  return (
    <div className="space-y-300">
      <RecordsTables kind="assets" view={view} />
      {asset !== undefined && (
        <section aria-label={asset.name} className={relatedCardClass}>
          <h3 className={detailHeadingClass}>
            {asset.code} · {asset.name}
          </h3>
          <p>
            {asset.category} · {asset.serialNumber ?? t(`${key}.notProvided`)}
          </p>
          <p>
            {t(`${key}.lastService`)}: {asset.lastServiceAt ?? t(`${key}.notProvided`)} · {t(`${key}.nextService`)}:{' '}
            {asset.nextServiceAt ?? t(`${key}.notProvided`)}
          </p>
          {model.work !== undefined && (
            <ul>
              {model.work.items.flatMap((task) =>
                task.contextRefs.some(
                  (ref) =>
                    ref.moduleId === asset.assetRef.moduleId &&
                    ref.resourceType === asset.assetRef.resourceType &&
                    ref.tenantId === asset.assetRef.tenantId &&
                    ref.resourceId === asset.assetRef.resourceId,
                )
                  ? [
                      <li key={task.ref.resourceId}>
                        <Link href={model.ownerHref('ukoly', task.ref.resourceId)}>{task.title}</Link>
                      </li>,
                    ]
                  : [],
              )}
            </ul>
          )}
        </section>
      )}
      <PropertyEquipment
        key={`${property.propertyRef.resourceId}:${unit?.unitRef.resourceId ?? ''}`}
        language={model.language}
        propertyId={property.propertyRef.resourceId}
        unitId={unit?.unitRef.resourceId}
      />
    </div>
  );
};

const RecordsFinance = ({ view }: { readonly view: RecordsView }) => {
  const { model } = view;
  const { finance, key, t } = model;
  if (finance === undefined) {
    return <RecordsUnavailable failure="financeUnavailable" view={view} />;
  }
  return (
    <div className="space-y-250">
      <p>
        {finance.state.invoices.length === 0
          ? t(`${key}.financialEmpty`)
          : t(`${key}.financialValues`, {
              cost: model.money(finance.indicators.costMinor),
              outstanding: model.money(finance.indicators.grossOutstandingMinor),
              revenue: model.money(finance.indicators.revenueMinor),
            })}
      </p>
      <ul>
        {finance.state.invoices.map((invoice) => (
          <li key={invoice.ref.resourceId}>
            <Link href={model.ownerHref('finance', invoice.ref.resourceId)}>
              {invoice.documentNumber} · {model.money(invoice.totalMinor)}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
};

const RelatedTabSchema = Schema.Literals(['leases', 'agreements', 'documents', 'tasks']);
type RelatedTab = typeof RelatedTabSchema.Type;
const sourceFailure = {
  agreements: 'agreementsUnavailable',
  documents: 'agreementsUnavailable',
  leases: 'occupancyUnavailable',
  tasks: 'tasksUnavailable',
} as const;
const RecordsSource = ({ tab, view }: { readonly tab: RelatedTab; readonly view: RecordsView }) => {
  const { leasable, model } = view;
  const { key, property, t, unit } = model;
  const source = model.relatedSections.find((section) => section.kind === tab);
  if (source === undefined || !source.enabled) {
    return <RecordsUnavailable failure={sourceFailure[tab]} view={view} />;
  }
  if (unit !== undefined && tab !== 'documents') {
    return (
      <UnitStory
        agreements={model.agreements}
        language={model.language}
        leaseBlock={unitLeaseBlock(unit, (unit.archive ?? property?.archive) !== undefined, leasable)}
        occupancy={model.occupancy}
        section={tab}
        t={t}
        tasks={model.work?.items}
        unit={unit}
        unitAssets={model.assets.flatMap((item) =>
          item.unitRef?.tenantId === unit.unitRef.tenantId &&
          item.unitRef.moduleId === unit.unitRef.moduleId &&
          item.unitRef.resourceType === unit.unitRef.resourceType &&
          item.unitRef.resourceId === unit.unitRef.resourceId
            ? [item.assetRef]
            : [],
        )}
      />
    );
  }
  if (source.items.length === 0) {
    return <p>{t(`${key}.emptyRelated`)}</p>;
  }
  return (
    <ul className="space-y-200">
      {source.items.map((item) => (
        <li key={item.href}>
          <Link href={item.href}>{item.label}</Link>
        </li>
      ))}
    </ul>
  );
};

const RecordsTabContent = ({ tab, view }: { readonly tab: PropertyTab; readonly view: RecordsView }) => {
  const { property, unit } = view.model;
  if (property === undefined) {
    return null;
  }
  const subject =
    unit === undefined
      ? { id: property.propertyRef.resourceId, kind: 'property' as const, label: property.name }
      : { id: unit.unitRef.resourceId, kind: 'unit' as const, label: `${unit.code} · ${unit.name}` };
  return Match.value(tab).pipe(
    Match.when('units', () => <RecordsTables kind="units" view={view} />),
    Match.when('equipment', () => <RecordsEquipment view={view} />),
    Match.when('finance', () => <RecordsFinance view={view} />),
    Match.when('discussion', () => <RecordDiscussion section="comments" subject={subject} />),
    Match.when('documents', () => (
      <div className="space-y-300">
        <RecordsSource tab="documents" view={view} />
        <RecordDiscussion section="documents" subject={subject} />
      </div>
    )),
    Match.whenOr('leases', 'agreements', 'tasks', (relatedTab) => <RecordsSource tab={relatedTab} view={view} />),
    Match.exhaustive,
  );
};

const RecordsFilters = ({ view }: { readonly view: RecordsView }) => {
  const { editor, model } = view;
  const { key, search, t } = model;
  const archivedCount =
    (model.records?.properties.filter((item) => item.archive !== undefined).length ?? 0) +
    (model.records?.units.filter((item) => item.archive !== undefined).length ?? 0);
  return (
    <div className="propertyportfolio:flex propertyportfolio:flex-wrap propertyportfolio:items-center gap-250">
      <FormCheckbox
        checked={search.includeClosed === true}
        disabled={editor.busy}
        label={t(`${key}.includeClosed`)}
        onCheckedChange={(checked) => model.updateSearch({ ...search, includeClosed: checked ? true : undefined })}
      />
      {archivedCount > 0 && (
        <FormCheckbox
          checked={search.includeArchived === true}
          disabled={editor.busy}
          label={t(`${key}.includeArchived`, { count: archivedCount })}
          onCheckedChange={(checked) => model.updateSearch({ ...search, includeArchived: checked ? true : undefined })}
        />
      )}
    </div>
  );
};

const RecordsPageContent = (input: RecordsInput) => {
  const model = usePropertyRecords(input);
  const editor = usePropertyEditor(model.records, model.employees, (result) => {
    model.refresh();
    model.selectResource(result.resourceRef.resourceId);
  });
  const { key, property, search, t, unit } = model;
  const leasable = (lifecycle: string) =>
    lifecycle === 'ACTIVE' && property?.lifecycleState === 'ACTIVE' && property.archive === undefined;
  const availabilityLabel = (id: string, lifecycle: string) => {
    if (lifecycle === 'RETIRED') {
      return t(`${key}.retiredAvailability`);
    }
    if (lifecycle !== 'ACTIVE') {
      return t(`${key}.outOfService`);
    }
    if (!leasable(lifecycle)) {
      return t(`${key}.buildingBlocked`);
    }
    if (model.occupancy === undefined) {
      return t(`${key}.${model.pending ? 'loading' : 'occupancyUnavailable'}`);
    }
    return t(`${key}.availability.${model.availability(id)}`);
  };
  const [confirmation, setConfirmation] = useState<RecordConfirmation>();
  const requestArchive = (label: string, onConfirm: (reason: string) => void) =>
    setConfirmation({
      description: t(`${key}.editor.archiveDescription`, { label }),
      initialReason: t(`${key}.editor.archiveDefaultReason`),
      onConfirm,
      title: t(`${key}.editor.archiveTitle`, { label }),
    });
  const requestRetire = (item: RecordsResponse['units'][number]) =>
    setConfirmation({
      description: t(`${key}.editor.retireDescription`, { label: item.code }),
      onConfirm: () => editor.changeUnitLifecycle(item, 'RETIRED'),
      title: t(`${key}.editor.retireTitle`, { label: item.code }),
    });
  const view: RecordsView = { availabilityLabel, editor, leasable, model, requestArchive, requestRetire };
  const propertyItem = (item: RecordsResponse['properties'][number]) => ({
    address: item.address,
    archived: item.archive !== undefined,
    code: item.code,
    id: item.propertyRef.resourceId,
    name: item.name,
    stateLabel: t(`${key}.states.${item.lifecycleState}`),
    unitCount:
      model.records?.units.filter(
        (record) =>
          record.propertyRef.resourceId === item.propertyRef.resourceId &&
          record.propertyRef.tenantId === item.propertyRef.tenantId &&
          record.archive === undefined,
      ).length ?? 0,
  });
  const unitItem = (item: RecordsResponse['units'][number]) => ({
    archived: item.archive !== undefined || property?.archive !== undefined,
    availabilityLabel: availabilityLabel(item.unitRef.resourceId, item.lifecycleState),
    code: item.code,
    id: item.unitRef.resourceId,
    name: item.name,
    stateLabel: t(`${key}.states.${item.lifecycleState}`),
  });
  const visibleProperties =
    model.records?.properties.filter((item) =>
      propertyRecordVisible(
        {
          archived: item.archive !== undefined,
          closed: !['ACTIVE', 'PLANNED'].includes(item.lifecycleState),
          selected: item.propertyRef.resourceId === property?.propertyRef.resourceId,
        },
        search,
      ),
    ) ?? [];
  usePrefetchPropertySummaries(
    input,
    renderedPropertySummaryRows(property, visibleProperties),
    model.records?.revision ?? 0,
  );
  const visibleUnits = model.units.filter((item) =>
    propertyRecordVisible(
      {
        archived: item.archive !== undefined || property?.archive !== undefined,
        closed: item.lifecycleState === 'RETIRED',
        selected: item.unitRef.resourceId === unit?.unitRef.resourceId,
      },
      search,
    ),
  );
  const activeTab = selectedPropertyTab(search, unit !== undefined, model.asset !== undefined);
  return (
    <>
      <UltramodernRouteHead />
      <h1 className="mb-300 propertyportfolio:text-3xl propertyportfolio:font-semibold">{t(`${key}.title`)}</h1>
      {confirmation !== undefined && (
        <RecordsConfirmation onClose={() => setConfirmation(undefined)} request={confirmation} view={view} />
      )}
      {model.records === undefined ? (
        <section>
          <output>{model.recordsLoading ? t(`${key}.loading`) : model.message}</output>
          {!model.recordsLoading && (
            <Button onClick={() => model.refresh()} variant="secondary">
              {t(`${key}.retry`)}
            </Button>
          )}
        </section>
      ) : (
        <PropertyWorkspace
          actions={
            <div className="propertyportfolio:flex propertyportfolio:flex-wrap gap-200">
              {unit === undefined ? <RecordsPropertyActions view={view} /> : <RecordsUnitActions view={view} />}
            </div>
          }
          activeTab={activeTab}
          busy={editor.busy || editor.blocked}
          canCreateUnit={property !== undefined && property.archive === undefined}
          details={<RecordsMetadata view={view} />}
          editor={<RecordsEditorForm view={view} />}
          filters={<RecordsFilters view={view} />}
          messages={
            <>
              {model.message !== '' && <output>{model.message}</output>}
              {editor.feedback !== undefined && editor.draft === undefined && (
                <output>{t(`${key}.editor.${editor.feedback}`)}</output>
              )}
              {search.resourceId !== undefined && property === undefined && !model.recordsLoading && (
                <output>{t(`${key}.notFound`)}</output>
              )}
            </>
          }
          onCreateProperty={() => editor.begin()}
          onCreateUnit={() => {
            if (property !== undefined) {
              editor.beginUnit(property);
            }
          }}
          onSelectResource={(id) => model.selectResource(id)}
          onSelectTab={(tab) => {
            const next = propertyTabs(unit !== undefined).find((value) => value === tab);
            if (next !== undefined) {
              model.updateSearch({ ...search, tab: next });
            }
          }}
          properties={visibleProperties.map(propertyItem)}
          property={property === undefined ? undefined : propertyItem(property)}
          t={(name, values) => t(`property-workspace:${name}`, values)}
          tabs={propertyTabs(unit !== undefined).map((tab) => ({
            content: <RecordsTabContent tab={tab} view={view} />,
            label: t(`${key}.tabs.${tab}`),
            value: tab,
          }))}
          unit={unit === undefined ? undefined : unitItem(unit)}
          units={visibleUnits.map(unitItem)}
        />
      )}
    </>
  );
};

export const RecordsPage = ({ context }: Pick<ModulePageProps, 'context'>) => {
  const input = recordsInput(context, useId());
  return (
    <FederatedI18nBoundary
      defaultNamespace="property-portfolio"
      fallbackLanguage="en"
      resources={propertyPortfolioI18nResources}
      supportedLanguages={['en', 'cs']}
    >
      <RecordsPageContent key={input.scope} {...input} />
    </FederatedI18nBoundary>
  );
};
export default RecordsPage;
