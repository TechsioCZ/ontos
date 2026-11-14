import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
// Side panels of the security agenda: device card create/edit, fault report (+ linked task), inspection, resolve.
import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  saveLabelsFor,
  surfaceTileClassName,
  useDraftSave,
} from '@app/admin-ui';
import type { SaveOutcome, UnsavedChangesGuard } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput, FormTextarea } from '@app/admin-ui/form-controls';
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
  inspectionNoteLimit,
} from '../../../../../shared/domain/security.ts';
import type { SecurityDevice, SecurityIncident, SecuritySeverity } from '../../../../../shared/domain/security.ts';
import { usePropertyOptions } from '../../../../ui/property-options.ts';
import { runCommand } from '../../../../ui/use-agenda.ts';
import type { CommandOutcome, FailureReason } from '../../../../ui/use-agenda.ts';
import { addDays, createServiceTask, locationText, todayPrague, useSecurityLabel } from './security-model.ts';
import { deviceCreateCommandOf, deviceDraftOf, deviceUpdateCommandOf, sameDeviceDraft } from './device-draft.ts';
import type { DeviceDraft } from './device-draft.ts';
import { useEditGuard } from '../../../../ui/edit-guard.tsx';
import { facilitySaveOutcome } from '../../../../ui/facility-save.ts';
import { useDraftBase } from '../../../../ui/draft-base.ts';
import { FormSaveFooter, commandResult, refusedOutcome, submitDone, useFormSave } from '../../../../ui/form-save.tsx';
import type { FormSubmitResult } from '../../../../ui/form-save.tsx';

export type RunCommand = (command: OpsCommand) => Effect.Effect<CommandOutcome>;
type InspectionCommand = Extract<OpsCommand, { readonly _tag: 'SecurityDeviceRecordInspection' }>;
type MutableInspectionCommand = { -readonly [Key in keyof InspectionCommand]: InspectionCommand[Key] };
type ReportCommand = Extract<OpsCommand, { readonly _tag: 'SecurityIncidentReport' }>;
type MutableReportCommand = { -readonly [Key in keyof ReportCommand]: ReportCommand[Key] };
type ResolveCommand = Extract<OpsCommand, { readonly _tag: 'SecurityIncidentChangeState' }>;
type MutableResolveCommand = { -readonly [Key in keyof ResolveCommand]: ResolveCommand[Key] };

const INSPECTION_NOTE_TOO_LONG = 'inspection_note_too_long';
type FormError = FailureReason | 'inspection_note_too_long' | 'required';
const NONE = 'none';
const CANCEL_LABEL = 'facility-operations.common.cancel';

/** The text of a form error, for the error line and the save bar. */
const useErrorText = () => {
  const { t } = useModernI18n();
  return (error: FormError | undefined) => {
    if (error === INSPECTION_NOTE_TOO_LONG) {
      return t('facility-operations.security.inspection.noteTooLong', { limit: inspectionNoteLimit });
    }
    return error === undefined
      ? error
      : t(error === 'required' ? 'facility-operations.common.required' : `facility-operations.common.errors.${error}`);
  };
};

const ErrorLine = ({ error }: { readonly error: FormError | undefined }) => {
  const text = useErrorText()(error);
  if (text === undefined) {
    return null;
  }
  return (
    <StatusText showIcon status="error">
      {text}
    </StatusText>
  );
};

/** The side panel of one security form; its actions end with the shared save bar. Enter never submits. */
const PanelFrame = ({
  actions,
  children,
  guard,
  onClose,
  open,
  title,
}: {
  /** Zrušit/Zavřít and the save bar, last. */
  readonly actions: ReactNode;
  readonly children: ReactNode;
  /** The unsaved-changes guard of an edit panel: every dismissal asks it first. */
  readonly guard?: UnsavedChangesGuard | undefined;
  readonly onClose: () => void;
  readonly open: boolean;
  readonly title: string;
}) => {
  const { t } = useModernI18n();
  return (
    <SidePanel
      actions={actions}
      guard={guard}
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
      <div className="flex flex-col gap-200 py-200">{children}</div>
    </SidePanel>
  );
};

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
  const [error, setError] = useState<FormError | undefined>();
  const errorText = useErrorText();
  const set = <Key extends keyof DeviceDraft>(key: Key, value: DeviceDraft[Key]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  // A new card is sent on Uložit only.
  const form = useFormSave<DeviceDraft>({
    equals: sameDeviceDraft,
    onDiscard: () => {
      setDraft(deviceDraftOf());
      setError(undefined);
    },
    submit: (value) => {
      const command = deviceCreateCommandOf(value, pickedLocationOf({ draft: value, properties }));
      if (Option.isNone(command)) {
        setError('required');
        return Effect.succeed<FormSubmitResult>('failed');
      }
      setError(undefined);
      return run(command.value).pipe(
        Effect.map((outcome) =>
          commandResult(
            outcome,
            (result) => {
              toast.create({ title: k('created'), type: 'success' });
              onSaved(result.entityIds[0]);
            },
            setError,
          ),
        ),
      );
    },
    value: draft,
  });

  return (
    <PanelFrame
      actions={<FormSaveFooter cancelLabel={t(CANCEL_LABEL)} error={errorText(error)} form={form} onCancel={onClose} />}
      guard={form.guard}
      onClose={onClose}
      open={open}
      title={k('create.title')}
    >
      <ErrorLine error={error} />
      <DeviceFields draft={draft} k={k} nameMissing={error === 'required'} properties={properties} set={set} />
    </PanelFrame>
  );
};

/**
 * Edit one device card. Nothing is sent until Uložit; the save goes against the agenda revision, so a revision
 * conflict offers the version someone else saved, and a card without a name cannot be saved.
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
  const { language, t } = useModernI18n();
  const k = useSecurityLabel();
  const properties = usePropertyOptions();
  const [draft, setDraft] = useState<DeviceDraft>(() => deviceDraftOf(device));
  const set = <Key extends keyof DeviceDraft>(key: Key, value: DeviceDraft[Key]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  // Saves carry the revision of the read the draft was built on, so someone else's newer change refuses them.
  const base = useDraftBase(device, run);
  const record = useDraftSave<DeviceDraft, never>({
    equals: sameDeviceDraft,
    isValid: (value) =>
      Option.isSome(deviceUpdateCommandOf(value, device, pickedLocationOf({ device, draft: value, properties }))),
    runtime: browserRuntime,
    save: (value) =>
      Option.match(deviceUpdateCommandOf(value, device, pickedLocationOf({ device, draft: value, properties })), {
        onNone: () => Effect.succeed<SaveOutcome>('failed'),
        onSome: (command) => base.confirm(facilitySaveOutcome(base.run(command))),
      }),
    value: draft,
  });
  base.sync({
    onAdopt: () => {
      const stored = deviceDraftOf(device);
      if (!sameDeviceDraft(stored, draft)) {
        record.adopt(stored);
        setDraft(stored);
      }
    },
    settled: !record.pending && sameDeviceDraft(draft, record.confirmed),
  });
  const guard = useEditGuard(record, () => {
    setDraft(record.confirmed);
  });
  const labels = saveLabelsFor(language);
  const close = () => {
    guard.request(onClose);
  };
  const handleSave = record.save;
  const handleReloadLatest = () => {
    const current = deviceDraftOf(device);
    base.rebase();
    record.adopt(current);
    setDraft(current);
  };
  return (
    <>
      <PanelFrame
        actions={
          <>
            <Button onClick={close} theme="outlined" variant="secondary">
              {t('facility-operations.common.close')}
            </Button>
            <SaveBar labels={labels} onReloadLatest={handleReloadLatest} onSave={handleSave} status={record.status} />
          </>
        }
        guard={guard}
        onClose={onClose}
        open={open}
        title={k('edit.title')}
      >
        <DeviceFields draft={draft} k={k} nameMissing={record.status === 'invalid'} properties={properties} set={set} />
      </PanelFrame>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};

/** Create or edit one device card; an edit is sent on Uložit only. */
const DeviceFormSession = ({
  device,
  onClose,
  onSaved,
  open,
  run,
}: {
  readonly device?: SecurityDevice | undefined;
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
    { device: input.device, tenantId: input.tenantId },
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
    return 'failed' as const;
  }
  setError(undefined);
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
    setError(reported.reason);
    return refusedOutcome(reported);
  }
  const [createdId] = reported.result.entityIds;
  let incidentId: SecurityIncident['id'] | undefined;
  if (createdId !== undefined) {
    const parsedId = Schema.decodeResult(SecurityIncidentIdSchema)(createdId);
    if (Result.isFailure(parsedId)) {
      setError('invalid');
      return 'failed' as const;
    }
    incidentId = parsedId.success;
  }
  const reportedTitle = k('report.done');
  if (!withTask || incidentId === undefined) {
    return submitDone(() => {
      toast.create({ title: reportedTitle, type: 'success' });
      onSaved(device.id);
    });
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
  return submitDone(() => {
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
  const [error, setError] = useState<FormError | undefined>();
  const errorText = useErrorText();
  // A fault is reported on Uložit only, with the same command and follow-up task as before.
  const form = useFormSave<ReportDraft>({
    onDiscard: () => {
      updateDraft(reportDraftOf(initialDeviceId));
      setError(undefined);
    },
    submit: () =>
      submitSecurityFault({
        active,
        description,
        deviceId,
        dueDate,
        k,
        occurredOn,
        onSaved,
        run,
        setError,
        severity,
        t,
        tenantId,
        title,
        toast,
        withTask,
      }),
    value: draft,
  });

  return (
    <PanelFrame
      actions={<FormSaveFooter cancelLabel={t(CANCEL_LABEL)} error={errorText(error)} form={form} onCancel={onClose} />}
      guard={form.guard}
      onClose={onClose}
      open={open}
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
  setError,
  toast,
}: SubmitSecurityInspectionInput) {
  if (device === undefined || date === '') {
    setError('required');
    return 'failed' as const;
  }
  if (note.trim().length > inspectionNoteLimit) {
    setError(INSPECTION_NOTE_TOO_LONG);
    return yield* Effect.succeed('failed' as const);
  }
  setError(undefined);
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
  return commandResult(
    outcome,
    () => {
      toast.create({ title: k('inspectionSaved'), type: 'success' });
      onSaved();
    },
    setError,
  );
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
  const { t } = useModernI18n();
  const k = useSecurityLabel();
  const toast = useToast();
  const [date, setDate] = useState(todayPrague);
  const [next, setNext] = useState(() => addDays(todayPrague(), 365));
  const [note, setNote] = useState('');
  const [error, setError] = useState<FormError | undefined>();
  const errorText = useErrorText();
  // The inspection opens with today and the next date filled in: Uložit records it as it is.
  const form = useFormSave({
    onDiscard: () => {
      setDate(todayPrague());
      setNext(addDays(todayPrague(), 365));
      setNote('');
      setError(undefined);
    },
    savableAtOnce: true,
    submit: () => submitSecurityInspection({ date, device, k, next, note, onSaved, run, setError, toast }),
    value: { date, next, note },
  });
  return (
    <PanelFrame
      actions={<FormSaveFooter cancelLabel={t(CANCEL_LABEL)} error={errorText(error)} form={form} onCancel={onClose} />}
      guard={form.guard}
      onClose={onClose}
      open={open}
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
        helpText={k('inspection.noteLimit', { limit: inspectionNoteLimit })}
        id="security-inspection-note"
        label={k('fields.note')}
        maxLength={4000}
        onChange={(event) => setNote(event.target.value)}
        rows={3}
        // Marked while typing once the note is longer than what is kept; the typed text itself is never cut.
        validateStatus={note.trim().length > inspectionNoteLimit ? 'error' : 'default'}
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
  readonly setError: (error: FormError | undefined) => void;
  readonly toast: ReturnType<typeof useToast>;
}

const submitSecurityResolution = Effect.fn('Facility.submitSecurityResolution')(function* submitSecurityResolution({
  incident,
  k,
  onSaved,
  resolution,
  run,
  setError,
  toast,
}: SubmitSecurityResolutionInput) {
  if (incident === undefined) {
    return 'failed' as const;
  }
  setError(undefined);
  const command: MutableResolveCommand = {
    _tag: 'SecurityIncidentChangeState',
    incidentId: incident.id,
    state: 'resolved',
  };
  if (resolution.trim() !== '') {
    command.resolution = resolution.trim();
  }
  const outcome = yield* run(command);
  return commandResult(
    outcome,
    () => {
      toast.create({ title: k('stateSaved'), type: 'success' });
      onSaved();
    },
    setError,
  );
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
  const { t } = useModernI18n();
  const k = useSecurityLabel();
  const toast = useToast();
  const [resolution, setResolution] = useState('');
  const [error, setError] = useState<FormError | undefined>();
  const errorText = useErrorText();
  // The resolution note is optional: Uložit resolves the fault as it is.
  const form = useFormSave({
    onDiscard: () => {
      setResolution('');
      setError(undefined);
    },
    savableAtOnce: true,
    submit: () => submitSecurityResolution({ incident, k, onSaved, resolution, run, setError, toast }),
    value: resolution,
  });
  return (
    <PanelFrame
      actions={<FormSaveFooter cancelLabel={t(CANCEL_LABEL)} error={errorText(error)} form={form} onCancel={onClose} />}
      guard={form.guard}
      onClose={onClose}
      open={open}
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
