import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
// Side panels of the security agenda: device card create/edit, fault report (+ linked task), inspection, resolve.
import { SaveBar, SidePanel, surfaceTileClassName, useDraftSave } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate as Select } from '@app/admin-ui/select-template';
import { Effect, Option, Result, Schema } from 'effect';
import { useReducer, useState } from 'react';
import type { ReactNode } from 'react';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import type { IsoDateSchema, PropertyRef } from '../../../../../shared/domain/common.ts';
import {
  SecurityIncidentIdSchema,
  SecurityDeviceTypeSchema,
  SecurityDeviceStateSchema,
  SecuritySeveritySchema,
  securityDeviceStates,
  securityDeviceTypes,
  securitySeverities,
} from '../../../../../shared/domain/security.ts';
import type { SecurityDevice, SecurityIncident, SecuritySeverity } from '../../../../../shared/domain/security.ts';
import { usePropertyOptions } from '../../../../ui/property-options.ts';
import { runCommand } from '../../../../ui/use-agenda.ts';
import type { CommandOutcome, FailureReason } from '../../../../ui/use-agenda.ts';
import { addDays, createServiceTask, locationText, todayPrague, useSecurityLabel } from './security-model.ts';
import { deviceCreateCommandOf, deviceDraftOf, deviceUpdateCommandOf, sameDeviceDraft } from './device-draft.ts';
import type { DeviceDraft } from './device-draft.ts';
import { facilityAutosaveOutcome } from '../../../../ui/facility-autosave.ts';

export type RunCommand = (command: OpsCommand) => Effect.Effect<CommandOutcome>;
type InspectionCommand = Extract<OpsCommand, { readonly _tag: 'SecurityDeviceRecordInspection' }>;
type MutableInspectionCommand = { -readonly [Key in keyof InspectionCommand]: InspectionCommand[Key] };
type ReportCommand = Extract<OpsCommand, { readonly _tag: 'SecurityIncidentReport' }>;
type MutableReportCommand = { -readonly [Key in keyof ReportCommand]: ReportCommand[Key] };
type ResolveCommand = Extract<OpsCommand, { readonly _tag: 'SecurityIncidentChangeState' }>;
type MutableResolveCommand = { -readonly [Key in keyof ResolveCommand]: ResolveCommand[Key] };

type FormError = FailureReason | 'required';
const NONE = 'none';

const ErrorLine = ({ error }: { readonly error: FormError | undefined }) => {
  const { t } = useModernI18n();
  if (error === undefined) {
    return null;
  }
  return (
    <StatusText showIcon status="error">
      {error === 'required'
        ? t('facility-operations.common.required')
        : t(`facility-operations.common.errors.${error}`)}
    </StatusText>
  );
};

const PanelFrame = ({
  actions,
  busy = false,
  children,
  onClose,
  onSubmit,
  open,
  submitLabel,
  title,
}: {
  /** Explicit actions (an edit panel shows its autosave state instead of a submit button). */
  readonly actions?: ReactNode | undefined;
  readonly busy?: boolean | undefined;
  readonly children: ReactNode;
  readonly onClose: () => void;
  readonly onSubmit?: (() => void) | undefined;
  readonly open: boolean;
  /** Submit button label of a create/action panel; unused when `actions` is given. */
  readonly submitLabel?: string | undefined;
  readonly title: string;
}) => {
  const { t } = useModernI18n();
  const panelActions = actions ?? (
    <>
      <Button onClick={onClose} theme="outlined" variant="secondary">
        {t('facility-operations.common.cancel')}
      </Button>
      <Button
        isLoading={busy}
        loadingText={t('facility-operations.common.saving')}
        onClick={onSubmit}
        variant="primary"
      >
        {submitLabel}
      </Button>
    </>
  );
  return (
    <SidePanel
      actions={panelActions}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open={open}
      resizeLabel={t('facility-operations.common.close')}
      size="md"
      title={title}
    >
      {onSubmit === undefined ? (
        <div className="flex flex-col gap-200 py-200">{children}</div>
      ) : (
        <form
          className="flex flex-col gap-200 py-200"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          {children}
        </form>
      )}
    </SidePanel>
  );
};

/** The fields of one device card, shared by the create panel and the autosaving edit panel. */
const DeviceFields = ({
  draft,
  k,
  nameMissing,
  properties,
  set,
}: {
  readonly draft: DeviceDraft;
  readonly k: ReturnType<typeof useSecurityLabel>;
  readonly nameMissing: boolean;
  readonly properties: ReturnType<typeof usePropertyOptions>;
  readonly set: <Key extends keyof DeviceDraft>(key: Key, value: DeviceDraft[Key]) => void;
}) => {
  const options = (values: readonly string[], prefix: string) =>
    values.map((value) => ({ displayValue: k(`${prefix}.${value}`), label: k(`${prefix}.${value}`), value }));
  return (
    <>
      <FormInput
        autoComplete="off"
        id="security-name"
        label={k('fields.name')}
        maxLength={200}
        onChange={(event) => set('name', event.target.value)}
        required
        value={draft.name}
        {...(nameMissing ? { helpText: k('fields.nameRequired'), validateStatus: 'error' as const } : {})}
      />
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <Select
          items={options(securityDeviceTypes, 'deviceType')}
          label={k('fields.deviceType')}
          name="deviceType"
          onValueChange={({ value }) => {
            const parsed = Schema.decodeUnknownResult(SecurityDeviceTypeSchema)(value[0] ?? 'camera');
            if (Result.isSuccess(parsed)) {
              set('deviceType', parsed.success);
            }
          }}
          size="md"
          value={[draft.deviceType]}
        />
        <Select
          items={options(securityDeviceStates, 'state')}
          label={k('fields.state')}
          name="state"
          onValueChange={({ value }) => {
            const parsed = Schema.decodeUnknownResult(SecurityDeviceStateSchema)(value[0] ?? 'in_operation');
            if (Result.isSuccess(parsed)) {
              set('state', parsed.success);
            }
          }}
          size="md"
          value={[draft.state]}
        />
      </div>
      {properties.status === 'ready' ? (
        <Select
          items={[
            { displayValue: k('fields.location'), label: '—', value: NONE },
            ...properties.options.map((option) => ({
              displayValue: option.ref.label,
              label: option.ref.label,
              value: option.value,
            })),
          ]}
          label={k('fields.location')}
          name="location"
          onValueChange={({ value }) => set('location', value[0] === undefined || value[0] === NONE ? '' : value[0])}
          size="md"
          value={[draft.location === '' ? NONE : draft.location]}
        />
      ) : null}
      <FormInput
        autoComplete="off"
        id="security-location-detail"
        label={k('fields.locationDetail')}
        maxLength={300}
        onChange={(event) => set('locationDetail', event.target.value)}
        value={draft.locationDetail}
      />
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <FormInput
          autoComplete="off"
          id="security-administrator"
          label={k('fields.administrator')}
          maxLength={200}
          onChange={(event) => set('administrator', event.target.value)}
          value={draft.administrator}
        />
        <FormInput
          autoComplete="off"
          id="security-supplier"
          label={k('fields.supplier')}
          maxLength={200}
          onChange={(event) => set('supplier', event.target.value)}
          value={draft.supplier}
        />
        <FormInput
          autoComplete="off"
          id="security-serial"
          label={k('fields.serialNumber')}
          maxLength={120}
          onChange={(event) => set('serialNumber', event.target.value)}
          value={draft.serialNumber}
        />
        <div />
        <FormInput
          id="security-last-inspection"
          label={k('fields.lastInspectionDate')}
          onChange={(event) => set('lastInspectionDate', event.target.value)}
          type="date"
          value={draft.lastInspectionDate}
        />
        <FormInput
          id="security-next-inspection"
          label={k('fields.nextInspectionDate')}
          onChange={(event) => set('nextInspectionDate', event.target.value)}
          type="date"
          value={draft.nextInspectionDate}
        />
      </div>
      <FormTextarea
        id="security-note"
        label={k('fields.note')}
        maxLength={4000}
        onChange={(event) => set('note', event.target.value)}
        rows={3}
        value={draft.note}
      />
    </>
  );
};

/** The stored location of a draft: the picked property, or the one the device already has. */
const pickedLocationOf = ({
  device,
  draft,
  properties,
}: {
  /** The device as stored, so an unchanged location resolves even before the property list loads. */
  readonly device?: SecurityDevice | undefined;
  readonly draft: DeviceDraft;
  readonly properties: ReturnType<typeof usePropertyOptions>;
}): PropertyRef | undefined => {
  if (draft.location === '') {
    return undefined;
  }
  if (properties.status === 'ready') {
    const found = properties.options.find((option) => option.value === draft.location)?.ref;
    if (found !== undefined) {
      return found;
    }
  }
  return device?.location !== undefined && `${device.location.kind}:${device.location.id}` === draft.location
    ? device.location
    : undefined;
};

/** Create one device card on "Vytvořit": the create stays an explicit submit. */
const DeviceCreatePanel = ({
  onClose,
  onSaved,
  open,
  run,
}: {
  readonly onClose: () => void;
  readonly onSaved: (deviceId: string | undefined) => void;
  readonly open: boolean;
  readonly run: RunCommand;
}) => {
  const { t } = useModernI18n();
  const k = useSecurityLabel();
  const toast = useToast();
  const properties = usePropertyOptions();
  const [draft, setDraft] = useState<DeviceDraft>(() => deviceDraftOf());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FormError | undefined>();
  const set = <Key extends keyof DeviceDraft>(key: Key, value: DeviceDraft[Key]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const submit = () => {
    const command = deviceCreateCommandOf(draft, pickedLocationOf({ draft, properties }));
    if (Option.isNone(command)) {
      setError('required');
      return Effect.void;
    }
    setBusy(true);
    return run(command.value).pipe(
      Effect.tap((outcome) =>
        Effect.sync(() => {
          setBusy(false);
          if (outcome.ok) {
            toast.create({ title: k('created'), type: 'success' });
            onSaved(outcome.result.entityIds[0]);
          } else {
            setError(outcome.reason);
          }
        }),
      ),
    );
  };

  return (
    <PanelFrame
      actions={
        <>
          <Button onClick={onClose} theme="outlined" variant="secondary">
            {t('facility-operations.common.cancel')}
          </Button>
          <Button
            isLoading={busy}
            loadingText={t('facility-operations.common.saving')}
            onClick={() => {
              void browserRuntime.runPromise(submit());
            }}
            variant="primary"
          >
            {k('create.submit')}
          </Button>
        </>
      }
      onClose={onClose}
      onSubmit={() => {
        void browserRuntime.runPromise(submit());
      }}
      open={open}
      title={k('create.title')}
    >
      <ErrorLine error={error} />
      <DeviceFields draft={draft} k={k} nameMissing={error === 'required'} properties={properties} set={set} />
    </PanelFrame>
  );
};

/**
 * Edit one device card. Changes save themselves (debounced, on blur and on Zavřít) against the agenda revision; a
 * revision conflict offers the version someone else saved, and a taken name stays local until it is filled in.
 */
const DeviceEditPanel = ({
  device,
  onClose,
  open,
  run,
}: {
  readonly device: SecurityDevice;
  readonly onClose: () => void;
  readonly open: boolean;
  readonly run: RunCommand;
}) => {
  const { t } = useModernI18n();
  const k = useSecurityLabel();
  const properties = usePropertyOptions();
  const [draft, setDraft] = useState<DeviceDraft>(() => deviceDraftOf(device));
  const set = <Key extends keyof DeviceDraft>(key: Key, value: DeviceDraft[Key]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const autosave = useDraftSave<DeviceDraft, never>({
    equals: sameDeviceDraft,
    isValid: (value) =>
      Option.isSome(deviceUpdateCommandOf(value, device, pickedLocationOf({ device, draft: value, properties }))),
    runtime: browserRuntime,
    save: (value) =>
      Option.match(deviceUpdateCommandOf(value, device, pickedLocationOf({ device, draft: value, properties })), {
        onNone: () => Effect.succeed<SaveOutcome>('failed'),
        onSome: (command) => facilityAutosaveOutcome(run(command)),
      }),
    value: draft,
  });
  const close = () => {
    onClose();
  };
  const handleSave = autosave.save;
  const handleReloadLatest = () => {
    const current = deviceDraftOf(device);
    autosave.adopt(current);
    setDraft(current);
  };
  return (
    <PanelFrame
      actions={
        <>
          <SaveBar onReloadLatest={handleReloadLatest} onSave={handleSave} status={autosave.status} />
          <Button onClick={close} theme="outlined" variant="secondary">
            {t('facility-operations.common.close')}
          </Button>
        </>
      }
      onClose={close}
      open={open}
      title={k('edit.title')}
    >
      <DeviceFields draft={draft} k={k} nameMissing={autosave.status === 'invalid'} properties={properties} set={set} />
    </PanelFrame>
  );
};

/** Create or edit one device card; an edit saves itself while the panel is open. */
const DeviceFormSession = ({
  device,
  onClose,
  onSaved,
  open,
  run,
}: {
  readonly device: SecurityDevice | undefined;
  readonly onClose: () => void;
  readonly onSaved: (deviceId: string | undefined) => void;
  readonly open: boolean;
  readonly run: RunCommand;
}) =>
  device === undefined ? (
    <DeviceCreatePanel onClose={onClose} onSaved={onSaved} open={open} run={run} />
  ) : (
    <DeviceEditPanel device={device} onClose={onClose} open={open} run={run} />
  );

/**
 * `linked`: task created and its reference stored on the incident. `pending_approval`: a proposal was
 * parked (task or link) and nothing has been applied yet, so no task reference is stored.
 */
export const TaskLinkOutcomeSchema = Schema.Literals(['failed', 'linked', 'pending_approval']);
export type TaskLinkOutcome = typeof TaskLinkOutcomeSchema.Type;

const linkOutcomeOf = (outcome: CommandOutcome): TaskLinkOutcome => {
  if (outcome.ok) {
    return 'linked';
  }
  return outcome.reason === 'approval_required' ? 'pending_approval' : 'failed';
};

/** Creates the work-tasks task and stores its reference on the incident. */
export const linkNewTask = Effect.fn('FacilityOperations.linkNewTask')(function* linkNewTask(input: {
  readonly description: string;
  readonly device: SecurityDevice;
  readonly dueDate: typeof IsoDateSchema.Encoded;
  readonly incidentId: SecurityIncident['id'];
  readonly label: ReturnType<typeof useSecurityLabel>;
  readonly revision: number;
  readonly severity: SecuritySeverity;
  readonly severityLabel: string;
  readonly tenantId: string;
  readonly title: string;
}) {
  const k = input.label;
  const language = window.location.pathname.split('/')[1] === 'en' ? 'en' : 'cs';
  const deviceUrl = new URL(`/${language}/provoz/bezpecnost`, window.location.origin);
  deviceUrl.searchParams.set('device', input.device.id);
  const task = yield* createServiceTask(
    {
      description: k('report.taskDescription', {
        description: input.description,
        device: input.device.name,
        location: locationText(input.device, '—'),
        severity: input.severityLabel,
        url: deviceUrl.href,
      }),
      dueDate: input.dueDate === '' ? addDays(todayPrague(), 3) : input.dueDate,
      severity: input.severity,
      title: k('report.taskTitle', { device: input.device.name, title: input.title }),
    },
    input.device,
    input.tenantId,
  );
  if (task.status !== 'created') {
    return task.status;
  }
  const linked = yield* runCommand(
    { _tag: 'SecurityIncidentLinkTask', incidentId: input.incidentId, task: task.task },
    input.revision,
  );
  return linkOutcomeOf(linked);
});

/** S11-01: report a fault and, in the same step, create the linked service task in work-tasks. */
interface SubmitSecurityFaultInput {
  readonly active: readonly SecurityDevice[];
  readonly description: string;
  readonly deviceId: string;
  readonly dueDate: typeof IsoDateSchema.Encoded;
  readonly k: ReturnType<typeof useSecurityLabel>;
  readonly occurredOn: SecurityIncident['occurredOn'];
  readonly onSaved: (deviceId: string) => void;
  readonly run: RunCommand;
  readonly setBusy: (busy: boolean) => void;
  readonly setError: (error: FormError | undefined) => void;
  readonly severity: SecuritySeverity;
  readonly t: ReturnType<typeof useModernI18n>['t'];
  readonly tenantId: string;
  readonly title: string;
  readonly toast: ReturnType<typeof useToast>;
  readonly withTask: boolean;
}

const submitSecurityFault = Effect.fn('Facility.submitSecurityFault')(function* submitSecurityFault({
  active,
  description,
  deviceId,
  dueDate,
  k,
  occurredOn,
  onSaved,
  run,
  setBusy,
  setError,
  severity,
  t,
  tenantId,
  title,
  toast,
  withTask,
}: SubmitSecurityFaultInput) {
  const device = active.find((entry) => entry.id === deviceId);
  if (device === undefined || title.trim() === '' || occurredOn === '') {
    setError('required');
    return;
  }
  setBusy(true);
  const command: MutableReportCommand = {
    _tag: 'SecurityIncidentReport',
    deviceId: device.id,
    occurredOn,
    severity,
    title: title.trim(),
  };
  if (description.trim() !== '') {
    command.description = description.trim();
  }
  const reported = yield* run(command);
  if (!reported.ok) {
    setBusy(false);
    setError(reported.reason);
    return;
  }
  const [createdId] = reported.result.entityIds;
  let incidentId: SecurityIncident['id'] | undefined;
  if (createdId !== undefined) {
    const parsedId = Schema.decodeResult(SecurityIncidentIdSchema)(createdId);
    if (Result.isFailure(parsedId)) {
      setBusy(false);
      setError('invalid');
      return;
    }
    incidentId = parsedId.success;
  }
  const reportedTitle = k('report.done');
  if (!withTask || incidentId === undefined) {
    setBusy(false);
    toast.create({ title: reportedTitle, type: 'success' });
    onSaved(device.id);
    return;
  }
  const created = yield* linkNewTask({
    description: description.trim(),
    device,
    dueDate,
    incidentId,
    label: k,
    revision: reported.result.revision,
    severity,
    severityLabel: t(`facility-operations.security.severity.${severity}`),
    tenantId,
    title: title.trim(),
  });
  setBusy(false);
  toast.create(
    (
      {
        failed: { description: k('report.taskFailed'), title: reportedTitle, type: 'warning' },
        linked: { title: k('report.doneWithTask'), type: 'success' },
        pending_approval: {
          description: t('facility-operations.common.errors.approval_required'),
          title: reportedTitle,
          type: 'info',
        },
      } satisfies Record<TaskLinkOutcome, Parameters<typeof toast.create>[0]>
    )[created],
  );
  onSaved(device.id);
});

interface ReportDraft {
  readonly description: string;
  readonly deviceId: string;
  readonly dueDate: typeof IsoDateSchema.Encoded;
  readonly occurredOn: SecurityIncident['occurredOn'];
  readonly severity: SecuritySeverity;
  readonly title: string;
  readonly withTask: boolean;
}
const reportDraftOf = (initialDeviceId: string | undefined): ReportDraft => {
  const today = todayPrague();
  return {
    description: '',
    deviceId: initialDeviceId ?? '',
    dueDate: addDays(today, 3),
    occurredOn: today,
    severity: 'high',
    title: '',
    withTask: true,
  };
};
const updateReportDraft = (draft: ReportDraft, changes: Partial<ReportDraft>): ReportDraft => ({
  ...draft,
  ...changes,
});

const ReportFaultSession = ({
  devices,
  initialDeviceId,
  onClose,
  onSaved,
  open,
  run,
  tenantId,
}: {
  readonly devices: readonly SecurityDevice[];
  readonly initialDeviceId: string | undefined;
  readonly onClose: () => void;
  readonly onSaved: (deviceId: string) => void;
  readonly open: boolean;
  readonly run: RunCommand;
  readonly tenantId: string;
}) => {
  const k = useSecurityLabel();
  const { t } = useModernI18n();
  const toast = useToast();
  const active = devices.filter((device) => device.state !== 'decommissioned');
  const [draft, updateDraft] = useReducer(updateReportDraft, initialDeviceId, reportDraftOf);
  const { description, deviceId, dueDate, occurredOn, severity, title, withTask } = draft;
  const setDeviceId = (nextValue: string) => updateDraft({ deviceId: nextValue });
  const setTitle = (nextValue: string) => updateDraft({ title: nextValue });
  const setDescription = (nextValue: string) => updateDraft({ description: nextValue });
  const setSeverity = (nextValue: SecuritySeverity) => updateDraft({ severity: nextValue });
  const setOccurredOn = (nextValue: SecurityIncident['occurredOn']) => updateDraft({ occurredOn: nextValue });
  const setWithTask = (nextValue: boolean) => updateDraft({ withTask: nextValue });
  const setDueDate = (nextValue: typeof IsoDateSchema.Encoded) => updateDraft({ dueDate: nextValue });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FormError | undefined>();

  const submit = () =>
    submitSecurityFault({
      active,
      description,
      deviceId,
      dueDate,
      k,
      occurredOn,
      onSaved,
      run,
      setBusy,
      setError,
      severity,
      t,
      tenantId,
      title,
      toast,
      withTask,
    });

  return (
    <PanelFrame
      busy={busy}
      onClose={onClose}
      onSubmit={() => {
        void browserRuntime.runPromise(submit());
      }}
      open={open}
      submitLabel={k('report.submit')}
      title={k('report.title')}
    >
      <ErrorLine error={error} />
      <Select
        items={active.map((device) => ({
          displayValue: device.name,
          label: `${device.name} · ${locationText(device, '')}`,
          value: device.id,
        }))}
        label={k('fields.device')}
        name="deviceId"
        onValueChange={({ value }) => setDeviceId(value[0] ?? '')}
        placeholder={k('report.pickDevice')}
        size="md"
        value={deviceId === '' ? [] : [deviceId]}
      />
      <FormInput
        autoComplete="off"
        id="security-incident-title"
        label={k('fields.title')}
        maxLength={200}
        onChange={(event) => setTitle(event.target.value)}
        required
        value={title}
      />
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <Select
          items={securitySeverities.map((value) => ({
            displayValue: k(`severity.${value}`),
            label: k(`severity.${value}`),
            value,
          }))}
          label={k('fields.severity')}
          name="severity"
          onValueChange={({ value }) => {
            const parsed = Schema.decodeUnknownResult(SecuritySeveritySchema)(value[0] ?? 'high');
            if (Result.isSuccess(parsed)) {
              setSeverity(parsed.success);
            }
          }}
          size="md"
          value={[severity]}
        />
        <FormInput
          id="security-incident-date"
          label={k('fields.occurredOn')}
          onChange={(event) => setOccurredOn(event.target.value)}
          required
          type="date"
          value={occurredOn}
        />
      </div>
      <FormTextarea
        id="security-incident-description"
        label={k('fields.description')}
        maxLength={4000}
        onChange={(event) => setDescription(event.target.value)}
        rows={3}
        value={description}
      />
      <div className={`${surfaceTileClassName} flex flex-col gap-150 p-200`}>
        <FormCheckbox
          checked={withTask}
          helpText={k('report.withTaskHint')}
          label={k('report.withTask')}
          name="withTask"
          onCheckedChange={setWithTask}
        />
        {withTask && (
          <FormInput
            id="security-task-due"
            label={k('fields.taskDueDate')}
            onChange={(event) => setDueDate(event.target.value)}
            type="date"
            value={dueDate}
          />
        )}
      </div>
    </PanelFrame>
  );
};

/** Records a performed inspection and the next planned one. */
interface SubmitSecurityInspectionInput {
  readonly date: typeof IsoDateSchema.Encoded;
  readonly device: SecurityDevice | undefined;
  readonly k: ReturnType<typeof useSecurityLabel>;
  readonly next: typeof IsoDateSchema.Encoded;
  readonly note: string;
  readonly onSaved: () => void;
  readonly run: RunCommand;
  readonly setBusy: (busy: boolean) => void;
  readonly setError: (error: FormError | undefined) => void;
  readonly toast: ReturnType<typeof useToast>;
}

const submitSecurityInspection = Effect.fn('Facility.submitSecurityInspection')(function* submitSecurityInspection({
  date,
  device,
  k,
  next,
  note,
  onSaved,
  run,
  setBusy,
  setError,
  toast,
}: SubmitSecurityInspectionInput) {
  if (device === undefined || date === '') {
    setError('required');
    return;
  }
  setBusy(true);
  const command: MutableInspectionCommand = {
    _tag: 'SecurityDeviceRecordInspection',
    deviceId: device.id,
    inspectionDate: date,
  };
  if (next !== '') {
    command.nextInspectionDate = next;
  }
  if (note.trim() !== '') {
    command.note = note.trim();
  }
  const outcome = yield* run(command);
  setBusy(false);
  if (outcome.ok) {
    toast.create({ title: k('inspectionSaved'), type: 'success' });
    onSaved();
  } else {
    setError(outcome.reason);
  }
});

const InspectionSession = ({
  device,
  onClose,
  onSaved,
  open,
  run,
}: {
  readonly device: SecurityDevice | undefined;
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly open: boolean;
  readonly run: RunCommand;
}) => {
  const k = useSecurityLabel();
  const toast = useToast();
  const [date, setDate] = useState(todayPrague);
  const [next, setNext] = useState(() => addDays(todayPrague(), 365));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FormError | undefined>();
  const submit = () =>
    submitSecurityInspection({ date, device, k, next, note, onSaved, run, setBusy, setError, toast });
  return (
    <PanelFrame
      busy={busy}
      onClose={onClose}
      onSubmit={() => {
        void browserRuntime.runPromise(submit());
      }}
      open={open}
      submitLabel={k('inspection.submit')}
      title={k('inspection.title')}
    >
      <ErrorLine error={error} />
      <p className="text-fg-secondary text-sm">{device?.name}</p>
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <FormInput
          id="security-inspection-date"
          label={k('fields.inspectionDate')}
          onChange={(event) => setDate(event.target.value)}
          required
          type="date"
          value={date}
        />
        <FormInput
          id="security-inspection-next"
          label={k('fields.nextInspectionDate')}
          onChange={(event) => setNext(event.target.value)}
          type="date"
          value={next}
        />
      </div>
      <FormTextarea
        id="security-inspection-note"
        label={k('fields.note')}
        maxLength={4000}
        onChange={(event) => setNote(event.target.value)}
        rows={3}
        value={note}
      />
    </PanelFrame>
  );
};

/** Resolves a fault with an optional resolution note. */
interface SubmitSecurityResolutionInput {
  readonly incident: SecurityIncident | undefined;
  readonly k: ReturnType<typeof useSecurityLabel>;
  readonly onSaved: () => void;
  readonly resolution: string;
  readonly run: RunCommand;
  readonly setBusy: (busy: boolean) => void;
  readonly setError: (error: FormError | undefined) => void;
  readonly toast: ReturnType<typeof useToast>;
}

const submitSecurityResolution = Effect.fn('Facility.submitSecurityResolution')(function* submitSecurityResolution({
  incident,
  k,
  onSaved,
  resolution,
  run,
  setBusy,
  setError,
  toast,
}: SubmitSecurityResolutionInput) {
  if (incident === undefined) {
    return;
  }
  setBusy(true);
  const command: MutableResolveCommand = {
    _tag: 'SecurityIncidentChangeState',
    incidentId: incident.id,
    state: 'resolved',
  };
  if (resolution.trim() !== '') {
    command.resolution = resolution.trim();
  }
  const outcome = yield* run(command);
  setBusy(false);
  if (outcome.ok) {
    toast.create({ title: k('stateSaved'), type: 'success' });
    onSaved();
  } else {
    setError(outcome.reason);
  }
});

const ResolveSession = ({
  incident,
  onClose,
  onSaved,
  open,
  run,
}: {
  readonly incident: SecurityIncident | undefined;
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly open: boolean;
  readonly run: RunCommand;
}) => {
  const k = useSecurityLabel();
  const toast = useToast();
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FormError | undefined>();
  const submit = () => submitSecurityResolution({ incident, k, onSaved, resolution, run, setBusy, setError, toast });
  return (
    <PanelFrame
      busy={busy}
      onClose={onClose}
      onSubmit={() => {
        void browserRuntime.runPromise(submit());
      }}
      open={open}
      submitLabel={k('resolveDialog.submit')}
      title={k('resolveDialog.title')}
    >
      <ErrorLine error={error} />
      <p className="font-medium text-sm">{incident?.title}</p>
      <FormTextarea
        id="security-resolution"
        label={k('fields.resolution')}
        maxLength={4000}
        onChange={(event) => setResolution(event.target.value)}
        rows={4}
        value={resolution}
      />
    </PanelFrame>
  );
};

/** Each open target owns one draft. Background record refreshes keep unsaved edits intact. */
export const DeviceFormPanel = (props: Parameters<typeof DeviceFormSession>[0]) =>
  props.open ? <DeviceFormSession key={props.device?.id ?? 'create'} {...props} /> : null;
export const ReportFaultPanel = (props: Parameters<typeof ReportFaultSession>[0]) =>
  props.open ? <ReportFaultSession key={props.initialDeviceId ?? 'choose-device'} {...props} /> : null;
export const InspectionPanel = (props: Parameters<typeof InspectionSession>[0]) =>
  props.open ? <InspectionSession key={props.device?.id ?? 'choose-device'} {...props} /> : null;
export const ResolvePanel = (props: Parameters<typeof ResolveSession>[0]) =>
  props.open ? <ResolveSession key={props.incident?.id ?? 'choose-incident'} {...props} /> : null;
