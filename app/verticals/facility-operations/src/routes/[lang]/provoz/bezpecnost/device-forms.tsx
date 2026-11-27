import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
// Side panels of the security agenda: device card create/edit, fault report (+ linked task), inspection, resolve.
import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  requiredLabelFor,
  saveLabelsFor,
  surfaceTileClassName,
  useDraftSave,
} from '@app/admin-ui';
import type { SaveOutcome, UnsavedChangesGuard } from '@app/admin-ui';
import {
  CheckboxField,
  ChoiceField,
  FormBuilder,
  FormReact,
  FormRoot,
  RuledTextAreaField,
  RuledTextField,
  TextAreaField,
  TextField,
  useAtomSet,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Effect, Option, Result, Schema } from 'effect';
import { useState } from 'react';
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
import { useFormValues } from '../../../../ui/form-values.tsx';

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

/**
 * The device card's values. Uložit sends them through the form save or the draft save, so the form only holds them
 * and Enter sends nothing.
 */
const makeDeviceForm = () =>
  FormReact.make(
    FormBuilder.empty
      .addField('administrator', Schema.String)
      .addField('deviceType', Schema.String)
      .addField('lastInspectionDate', Schema.String)
      .addField('location', Schema.String)
      .addField('locationDetail', Schema.String)
      .addField('name', Schema.String)
      .addField('nextInspectionDate', Schema.String)
      .addField('note', Schema.String)
      .addField('serialNumber', Schema.String)
      .addField('state', Schema.String)
      .addField('supplier', Schema.String),
    {
      fields: {
        administrator: TextField,
        deviceType: ChoiceField,
        lastInspectionDate: TextField,
        location: ChoiceField,
        locationDetail: TextField,
        name: RuledTextField,
        nextInspectionDate: TextField,
        note: TextAreaField,
        serialNumber: TextField,
        state: ChoiceField,
        supplier: TextField,
      },
      onSubmit: () => Effect.void,
      runtime: browserAtomRuntime,
    },
  );

/** A new card and the edit of one are separate forms. */
const deviceCreateForm = makeDeviceForm();
const deviceEditForm = makeDeviceForm();
type DeviceForm = typeof deviceCreateForm;
type DeviceValues = DeviceForm['schema']['Encoded'];

/** The values the card form shows for a draft: no location is the "none" choice. */
const deviceValuesOf = (draft: DeviceDraft): DeviceValues => ({
  ...draft,
  location: draft.location === '' ? NONE : draft.location,
});

/** The draft the card form shows: a type or state that is not one of the choices keeps the opening one. */
const deviceDraftFrom = (values: DeviceValues, opened: DeviceDraft): DeviceDraft => ({
  ...values,
  deviceType: Schema.is(SecurityDeviceTypeSchema)(values.deviceType) ? values.deviceType : opened.deviceType,
  location: values.location === NONE ? '' : values.location,
  state: Schema.is(SecurityDeviceStateSchema)(values.state) ? values.state : opened.state,
});

const DeviceFields = ({
  form,
  k,
  nameMissing,
  properties,
}: {
  readonly form: DeviceForm;
  readonly k: ReturnType<typeof useSecurityLabel>;
  readonly nameMissing: boolean;
  readonly properties: ReturnType<typeof usePropertyOptions>;
}) => {
  const { language } = useModernI18n();
  const options = (values: readonly string[], prefix: string) =>
    values.map((value) => ({ label: k(`${prefix}.${value}`), value }));
  return (
    <>
      <form.name
        autoComplete="off"
        id="security-name"
        invalid={nameMissing}
        label={k('fields.name')}
        maxLength={200}
        required
        requiredLabel={requiredLabelFor(language)}
        {...(nameMissing ? { helpText: k('fields.nameRequired') } : {})}
      />
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <form.deviceType items={options(securityDeviceTypes, 'deviceType')} label={k('fields.deviceType')} />
        <form.state items={options(securityDeviceStates, 'state')} label={k('fields.state')} />
      </div>
      {properties.status === 'ready' ? (
        <form.location
          items={[
            { label: '—', value: NONE },
            ...properties.options.map((option) => ({ label: option.ref.label, value: option.value })),
          ]}
          label={k('fields.location')}
        />
      ) : null}
      <form.locationDetail
        autoComplete="off"
        id="security-location-detail"
        label={k('fields.locationDetail')}
        maxLength={300}
      />
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <form.administrator
          autoComplete="off"
          id="security-administrator"
          label={k('fields.administrator')}
          maxLength={200}
        />
        <form.supplier autoComplete="off" id="security-supplier" label={k('fields.supplier')} maxLength={200} />
        <form.serialNumber autoComplete="off" id="security-serial" label={k('fields.serialNumber')} maxLength={120} />
        <div />
        <form.lastInspectionDate id="security-last-inspection" label={k('fields.lastInspectionDate')} type="date" />
        <form.nextInspectionDate id="security-next-inspection" label={k('fields.nextInspectionDate')} type="date" />
      </div>
      <form.note id="security-note" label={k('fields.note')} maxLength={4000} rows={3} />
    </>
  );
};

/** One form of a panel: it fills the panel body. */
const formClassName = 'flex flex-col gap-200';

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
  const opened = deviceDraftOf();
  const shown = useFormValues(deviceCreateForm, deviceValuesOf(opened));
  const draft = deviceDraftFrom(shown.values, opened);
  const setValues = useAtomSet(deviceCreateForm.setValues);
  const [error, setError] = useState<FormError | undefined>();
  const errorText = useErrorText();

  // A new card is sent on Uložit only.
  const form = useFormSave<DeviceDraft>({
    equals: sameDeviceDraft,
    onDiscard: () => {
      setValues(deviceValuesOf(deviceDraftOf()));
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
      <FormRoot
        className={formClassName}
        defaultValues={deviceValuesOf(opened)}
        form={deviceCreateForm}
        translateMessage={(message) => t(message)}
      >
        {shown.ready}
        <ErrorLine error={error} />
        <DeviceFields form={deviceCreateForm} k={k} nameMissing={error === 'required'} properties={properties} />
      </FormRoot>
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
  const opened = deviceDraftOf(device);
  const shown = useFormValues(deviceEditForm, deviceValuesOf(opened));
  const draft = deviceDraftFrom(shown.values, opened);
  const setValues = useAtomSet(deviceEditForm.setValues);
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
        setValues(deviceValuesOf(stored));
      }
    },
    settled: !record.pending && sameDeviceDraft(draft, record.confirmed),
  });
  const guard = useEditGuard(record, () => {
    setValues(deviceValuesOf(record.confirmed));
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
    setValues(deviceValuesOf(current));
  };
  return (
    <>
      <PanelFrame
        actions={
          <>
            <Button appearance="outline" onClick={close} severity="secondary">
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
        <FormRoot
          className={formClassName}
          defaultValues={deviceValuesOf(opened)}
          form={deviceEditForm}
          translateMessage={(message) => t(message)}
        >
          {shown.ready}
          <DeviceFields form={deviceEditForm} k={k} nameMissing={record.status === 'invalid'} properties={properties} />
        </FormRoot>
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

/** The fault report's values; Uložit sends them through the form save, so Enter sends nothing. */
const reportForm = FormReact.make(
  FormBuilder.empty
    .addField('description', Schema.String)
    .addField('deviceId', Schema.String)
    .addField('dueDate', Schema.String)
    .addField('occurredOn', Schema.String)
    .addField('severity', Schema.String)
    .addField('title', Schema.String)
    .addField('withTask', Schema.Boolean),
  {
    fields: {
      description: TextAreaField,
      deviceId: ChoiceField,
      dueDate: TextField,
      occurredOn: TextField,
      severity: ChoiceField,
      title: TextField,
      withTask: CheckboxField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
type ReportDraft = typeof reportForm.schema.Encoded;

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
  const { language } = useModernI18n();
  const active = devices.filter((device) => device.state !== 'decommissioned');
  const opened = reportDraftOf(initialDeviceId);
  const { ready, values: draft } = useFormValues(reportForm, opened);
  const { description, deviceId, dueDate, occurredOn, title, withTask } = draft;
  // A severity that is not one of the choices reads as the one the report opens with.
  const severity = Schema.is(SecuritySeveritySchema)(draft.severity) ? draft.severity : 'high';
  const setValues = useAtomSet(reportForm.setValues);
  const requiredLabel = requiredLabelFor(language);
  const [error, setError] = useState<FormError | undefined>();
  const errorText = useErrorText();
  // A fault is reported on Uložit only, with the same command and follow-up task as before.
  const form = useFormSave<ReportDraft>({
    onDiscard: () => {
      setValues(reportDraftOf(initialDeviceId));
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
      <FormRoot
        className={formClassName}
        defaultValues={opened}
        form={reportForm}
        translateMessage={(message) => t(message)}
      >
        {ready}
        <ErrorLine error={error} />
        <reportForm.deviceId
          items={active.map((device) => ({ label: `${device.name} · ${locationText(device, '')}`, value: device.id }))}
          label={k('fields.device')}
          placeholder={k('report.pickDevice')}
        />
        <reportForm.title
          autoComplete="off"
          id="security-incident-title"
          label={k('fields.title')}
          maxLength={200}
          required
          requiredLabel={requiredLabel}
        />
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
          <reportForm.severity
            items={securitySeverities.map((value) => ({ label: k(`severity.${value}`), value }))}
            label={k('fields.severity')}
          />
          <reportForm.occurredOn
            id="security-incident-date"
            label={k('fields.occurredOn')}
            required
            requiredLabel={requiredLabel}
            type="date"
          />
        </div>
        <reportForm.description
          id="security-incident-description"
          label={k('fields.description')}
          maxLength={4000}
          rows={3}
        />
        <div className={`${surfaceTileClassName} flex flex-col gap-150 p-200`}>
          <reportForm.withTask
            helpText={k('report.withTaskHint')}
            id="security-with-task"
            label={k('report.withTask')}
          />
          {withTask && <reportForm.dueDate id="security-task-due" label={k('fields.taskDueDate')} type="date" />}
        </div>
      </FormRoot>
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

/** The inspection's values; Uložit sends them through the form save, so Enter sends nothing. */
const inspectionForm = FormReact.make(
  FormBuilder.empty.addField('date', Schema.String).addField('next', Schema.String).addField('note', Schema.String),
  {
    fields: { date: TextField, next: TextField, note: RuledTextAreaField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
const inspectionOf = () => ({ date: todayPrague(), next: addDays(todayPrague(), 365), note: '' });

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
  const { language } = useModernI18n();
  const opened = inspectionOf();
  const { ready, values } = useFormValues(inspectionForm, opened);
  const { date, next, note } = values;
  const setValues = useAtomSet(inspectionForm.setValues);
  const [error, setError] = useState<FormError | undefined>();
  const errorText = useErrorText();
  // The inspection opens with today and the next date filled in: Uložit records it as it is.
  const form = useFormSave({
    onDiscard: () => {
      setValues(inspectionOf());
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
      <FormRoot
        className={formClassName}
        defaultValues={opened}
        form={inspectionForm}
        translateMessage={(message) => t(message)}
      >
        {ready}
        <ErrorLine error={error} />
        <p className="text-fg-secondary text-sm">{device?.name}</p>
        <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
          <inspectionForm.date
            id="security-inspection-date"
            label={k('fields.inspectionDate')}
            required
            requiredLabel={requiredLabelFor(language)}
            type="date"
          />
          <inspectionForm.next id="security-inspection-next" label={k('fields.nextInspectionDate')} type="date" />
        </div>
        <inspectionForm.note
          helpText={k('inspection.noteLimit', { limit: inspectionNoteLimit })}
          id="security-inspection-note"
          // Marked while typing once the note is longer than what is kept; the typed text itself is never cut.
          invalid={note.trim().length > inspectionNoteLimit}
          label={k('fields.note')}
          maxLength={4000}
          rows={3}
        />
      </FormRoot>
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

/** The resolution note; Uložit sends it through the form save, so Enter sends nothing. */
const resolveForm = FormReact.make(FormBuilder.empty.addField('resolution', Schema.String), {
  fields: { resolution: TextAreaField },
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});
const noResolution = { resolution: '' };

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
  const {
    ready,
    values: { resolution },
  } = useFormValues(resolveForm, noResolution);
  const setValues = useAtomSet(resolveForm.setValues);
  const [error, setError] = useState<FormError | undefined>();
  const errorText = useErrorText();
  // The resolution note is optional: Uložit resolves the fault as it is.
  const form = useFormSave({
    onDiscard: () => {
      setValues(noResolution);
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
      <FormRoot
        className={formClassName}
        defaultValues={noResolution}
        form={resolveForm}
        translateMessage={(message) => t(message)}
      >
        {ready}
        <ErrorLine error={error} />
        <p className="font-medium text-sm">{incident?.title}</p>
        <resolveForm.resolution id="security-resolution" label={k('fields.resolution')} maxLength={4000} rows={4} />
      </FormRoot>
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
