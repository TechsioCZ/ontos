import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
// Side panels of the security agenda: device card create/edit, fault report (+ linked task), inspection, resolve.
import { SidePanel, surfaceTileClassName } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { Effect, Result, Schema } from 'effect';
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
import type {
  SecurityDevice,
  SecurityDeviceState,
  SecurityDeviceType,
  SecurityIncident,
  SecuritySeverity,
} from '../../../../../shared/domain/security.ts';
import { usePropertyOptions } from '../../../../ui/property-options.ts';
import { runCommand } from '../../../../ui/use-agenda.ts';
import type { CommandOutcome, FailureReason } from '../../../../ui/use-agenda.ts';
import { addDays, createServiceTask, locationText, todayPrague, useSecurityLabel } from './security-model.ts';

export type RunCommand = (command: OpsCommand) => Effect.Effect<CommandOutcome>;
type DeviceFields = Omit<Extract<OpsCommand, { readonly _tag: 'SecurityDeviceCreate' }>, '_tag'>;
type MutableDeviceFields = { -readonly [Key in keyof DeviceFields]: DeviceFields[Key] };
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
  busy,
  children,
  onClose,
  onSubmit,
  open,
  submitLabel,
  title,
}: {
  readonly busy: boolean;
  readonly children: ReactNode;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
  readonly open: boolean;
  readonly submitLabel: string;
  readonly title: string;
}) => {
  const { t } = useModernI18n();
  return (
    <SidePanel
      actions={
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
      }
      closeOnInteractOutside={false}
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
      <form
        className="flex flex-col gap-200 py-200"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        {children}
      </form>
    </SidePanel>
  );
};

interface DeviceDraft {
  administrator: string;
  deviceType: SecurityDeviceType;
  lastInspectionDate: typeof IsoDateSchema.Encoded;
  location: string;
  locationDetail: string;
  name: string;
  nextInspectionDate: typeof IsoDateSchema.Encoded;
  note: string;
  serialNumber: string;
  state: SecurityDeviceState;
  supplier: string;
}

const draftOf = (device: SecurityDevice | undefined): DeviceDraft => {
  if (device === undefined) {
    return {
      administrator: '',
      deviceType: 'camera',
      lastInspectionDate: '',
      location: '',
      locationDetail: '',
      name: '',
      nextInspectionDate: '',
      note: '',
      serialNumber: '',
      state: 'in_operation',
      supplier: '',
    };
  }
  return {
    administrator: device.administrator ?? '',
    deviceType: device.deviceType,
    lastInspectionDate: device.lastInspectionDate ?? '',
    location: device.location === undefined ? '' : `${device.location.kind}:${device.location.id}`,
    locationDetail: device.locationDetail ?? '',
    name: device.name,
    nextInspectionDate: device.nextInspectionDate ?? '',
    note: device.note ?? '',
    serialNumber: device.serialNumber ?? '',
    state: device.state,
    supplier: device.supplier ?? '',
  };
};

const textKeys = ['administrator', 'locationDetail', 'note', 'serialNumber', 'supplier'] as const;
const dateKeys = ['lastInspectionDate', 'nextInspectionDate'] as const;

/** Create (device undefined) or edit one device card. */
interface SubmitSecurityDeviceInput {
  readonly device: SecurityDevice | undefined;
  readonly draft: DeviceDraft;
  readonly k: ReturnType<typeof useSecurityLabel>;
  readonly onSaved: (deviceId: string | undefined) => void;
  readonly pickedLocation: () => PropertyRef | undefined;
  readonly run: RunCommand;
  readonly setBusy: (busy: boolean) => void;
  readonly setError: (error: FormError | undefined) => void;
  readonly toast: ReturnType<typeof useToast>;
}

const submitSecurityDevice = Effect.fn('Facility.submitSecurityDevice')(function* submitSecurityDevice({
  device,
  draft,
  k,
  onSaved,
  pickedLocation,
  run,
  setBusy,
  setError,
  toast,
}: SubmitSecurityDeviceInput) {
  if (draft.name.trim() === '') {
    setError('required');
    return;
  }
  const location = pickedLocation();
  const fields: MutableDeviceFields = {
    deviceType: draft.deviceType,
    name: draft.name.trim(),
    state: draft.state,
  };
  for (const key of [...textKeys, ...dateKeys]) {
    const value = draft[key].trim();
    if (value !== '') {
      fields[key] = value;
    }
  }
  if (location !== undefined) {
    fields.location = location;
  }
  setBusy(true);
  const command: OpsCommand =
    device === undefined
      ? { _tag: 'SecurityDeviceCreate', ...fields }
      : {
          _tag: 'SecurityDeviceUpdate',
          ...fields,
          clear: [
            ...[...textKeys, ...dateKeys].filter((key) => draft[key].trim() === '' && device[key] !== undefined),
            ...(location === undefined && device.location !== undefined ? (['location'] as const) : []),
          ],
          deviceId: device.id,
        };
  const outcome = yield* run(command);
  setBusy(false);
  if (outcome.ok) {
    toast.create({ title: device === undefined ? k('created') : k('saved'), type: 'success' });
    onSaved(outcome.result.entityIds[0]);
  } else {
    setError(outcome.reason);
  }
});

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
}) => {
  const k = useSecurityLabel();
  const toast = useToast();
  const properties = usePropertyOptions();
  const [draft, setDraft] = useState<DeviceDraft>(() => draftOf(device));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FormError | undefined>();
  const set = <Key extends keyof DeviceDraft>(key: Key, value: DeviceDraft[Key]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const pickedLocation = (): PropertyRef | undefined => {
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

  const submit = () =>
    submitSecurityDevice({ device, draft, k, onSaved, pickedLocation, run, setBusy, setError, toast });

  const options = (values: readonly string[], prefix: string) =>
    values.map((value) => ({ displayValue: k(`${prefix}.${value}`), label: k(`${prefix}.${value}`), value }));

  return (
    <PanelFrame
      busy={busy}
      onClose={onClose}
      onSubmit={() => {
        void browserRuntime.runPromise(submit());
      }}
      open={open}
      submitLabel={device === undefined ? k('create.submit') : k('edit.submit')}
      title={device === undefined ? k('create.title') : k('edit.title')}
    >
      <ErrorLine error={error} />
      <FormInput
        autoComplete="off"
        id="security-name"
        label={k('fields.name')}
        maxLength={200}
        onChange={(event) => set('name', event.target.value)}
        required
        value={draft.name}
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
    </PanelFrame>
  );
};

/** Creates the work-tasks task and stores its reference on the incident. Returns whether both succeeded. */
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
  if (!task.ok) {
    return false;
  }
  const linked = yield* runCommand(
    { _tag: 'SecurityIncidentLinkTask', incidentId: input.incidentId, task: task.task },
    input.revision,
  );
  return linked.ok;
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
  if (!withTask || incidentId === undefined) {
    setBusy(false);
    toast.create({ title: k('report.done'), type: 'success' });
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
    created
      ? { title: k('report.doneWithTask'), type: 'success' }
      : { description: k('report.taskFailed'), title: k('report.done'), type: 'warning' },
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
