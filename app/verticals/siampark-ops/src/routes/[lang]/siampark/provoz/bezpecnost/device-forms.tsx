// @effect-diagnostics asyncFunction:off
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
import { Schema } from 'effect';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { OpsCommand } from '../../../../../../shared/agendas.ts';
import type { PropertyRef } from '../../../../../../shared/domain/common.ts';
import {
  SecurityIncidentIdSchema,
  securityDeviceStates,
  securityDeviceTypes,
  securitySeverities,
} from '../../../../../../shared/domain/security.ts';
import type {
  SecurityDevice,
  SecurityDeviceState,
  SecurityDeviceType,
  SecurityIncident,
  SecuritySeverity,
} from '../../../../../../shared/domain/security.ts';
import { usePropertyOptions } from '../../../../../ui/property-options.ts';
import { runCommand } from '../../../../../ui/use-agenda.ts';
import type { CommandOutcome, FailureReason } from '../../../../../ui/use-agenda.ts';
import { addDays, createServiceTask, locationText, todayPrague, useSecurityLabel } from './security-model.ts';

export type RunCommand = (command: OpsCommand) => Promise<CommandOutcome>;

const NONE = 'none';

const ErrorLine = ({ error }: { readonly error: FailureReason | 'required' | undefined }) => {
  const { t } = useModernI18n();
  if (error === undefined) {
    return null;
  }
  return (
    <StatusText showIcon status="error">
      {error === 'required' ? t('siampark-ops.common.required') : t(`siampark-ops.common.errors.${error}`)}
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
            {t('siampark-ops.common.cancel')}
          </Button>
          <Button isLoading={busy} loadingText={t('siampark-ops.common.saving')} onClick={onSubmit} variant="primary">
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
      resizeLabel={t('siampark-ops.common.close')}
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
  lastInspectionDate: string;
  location: string;
  locationDetail: string;
  name: string;
  nextInspectionDate: string;
  note: string;
  serialNumber: string;
  state: SecurityDeviceState;
  supplier: string;
}

const draftOf = (device: SecurityDevice | undefined): DeviceDraft => ({
  administrator: device?.administrator ?? '',
  deviceType: device?.deviceType ?? 'camera',
  lastInspectionDate: device?.lastInspectionDate ?? '',
  location: device?.location === undefined ? '' : `${device.location.kind}:${device.location.id}`,
  locationDetail: device?.locationDetail ?? '',
  name: device?.name ?? '',
  nextInspectionDate: device?.nextInspectionDate ?? '',
  note: device?.note ?? '',
  serialNumber: device?.serialNumber ?? '',
  state: device?.state ?? 'in_operation',
  supplier: device?.supplier ?? '',
});

const textKeys = ['administrator', 'locationDetail', 'note', 'serialNumber', 'supplier'] as const;
const dateKeys = ['lastInspectionDate', 'nextInspectionDate'] as const;

/** Create (device undefined) or edit one device card. */
export const DeviceFormPanel = ({
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
  const [error, setError] = useState<FailureReason | 'required' | undefined>(undefined);
  useEffect(() => {
    if (open) {
      setDraft(draftOf(device));
      setError(undefined);
    }
  }, [open, device]);
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

  const submit = async () => {
    if (draft.name.trim() === '') {
      setError('required');
      return;
    }
    const location = pickedLocation();
    const filled = Object.fromEntries(
      [...textKeys, ...dateKeys].flatMap((key) => (draft[key].trim() === '' ? [] : [[key, draft[key].trim()]])),
    );
    setBusy(true);
    const command: OpsCommand =
      device === undefined
        ? {
            _tag: 'SecurityDeviceCreate',
            ...filled,
            deviceType: draft.deviceType,
            name: draft.name.trim(),
            state: draft.state,
            ...(location === undefined ? {} : { location }),
          }
        : {
            _tag: 'SecurityDeviceUpdate',
            ...filled,
            clear: [
              ...[...textKeys, ...dateKeys].filter((key) => draft[key].trim() === '' && device[key] !== undefined),
              ...(location === undefined && device.location !== undefined ? (['location'] as const) : []),
            ],
            deviceId: device.id,
            deviceType: draft.deviceType,
            name: draft.name.trim(),
            state: draft.state,
            ...(location === undefined ? {} : { location }),
          };
    const outcome = await run(command);
    setBusy(false);
    if (outcome.ok) {
      toast.create({ title: device === undefined ? k('created') : k('saved'), type: 'success' });
      onSaved(outcome.result.entityIds[0]);
    } else {
      setError(outcome.reason);
    }
  };

  const options = (values: readonly string[], prefix: string) =>
    values.map((value) => ({ displayValue: k(`${prefix}.${value}`), label: k(`${prefix}.${value}`), value }));

  return (
    <PanelFrame
      busy={busy}
      onClose={onClose}
      onSubmit={() => void submit()}
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
          onValueChange={({ value }) => set('deviceType', (value[0] as SecurityDeviceType | undefined) ?? 'camera')}
          size="md"
          value={[draft.deviceType]}
        />
        <Select
          items={options(securityDeviceStates, 'state')}
          label={k('fields.state')}
          name="state"
          onValueChange={({ value }) => set('state', (value[0] as SecurityDeviceState | undefined) ?? 'in_operation')}
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

/** S11-01: report a fault and, in the same step, create the linked service task in siampark-work. */
export const ReportFaultPanel = ({
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
  const [deviceId, setDeviceId] = useState(initialDeviceId ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<SecuritySeverity>('high');
  const [occurredOn, setOccurredOn] = useState(todayPrague());
  const [withTask, setWithTask] = useState(true);
  const [dueDate, setDueDate] = useState(addDays(todayPrague(), 3));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureReason | 'required' | undefined>(undefined);
  useEffect(() => {
    if (open) {
      setDeviceId(initialDeviceId ?? '');
      setTitle('');
      setDescription('');
      setSeverity('high');
      setOccurredOn(todayPrague());
      setWithTask(true);
      setDueDate(addDays(todayPrague(), 3));
      setError(undefined);
    }
  }, [open, initialDeviceId]);

  const submit = async () => {
    const device = active.find((entry) => entry.id === deviceId);
    if (device === undefined || title.trim() === '' || occurredOn === '') {
      setError('required');
      return;
    }
    setBusy(true);
    const reported = await run({
      _tag: 'SecurityIncidentReport',
      deviceId: device.id,
      occurredOn,
      severity,
      title: title.trim(),
      ...(description.trim() === '' ? {} : { description: description.trim() }),
    });
    if (!reported.ok) {
      setBusy(false);
      setError(reported.reason);
      return;
    }
    const createdId = reported.result.entityIds[0];
    const incidentId = createdId === undefined ? undefined : Schema.decodeSync(SecurityIncidentIdSchema)(createdId);
    if (!withTask || incidentId === undefined) {
      setBusy(false);
      toast.create({ title: k('report.done'), type: 'success' });
      onSaved(device.id);
      return;
    }
    const created = await linkNewTask({
      description: description.trim(),
      device,
      dueDate,
      incidentId,
      label: k,
      revision: reported.result.revision,
      severity,
      severityLabel: t(`siampark-ops.security.severity.${severity}`),
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
  };

  return (
    <PanelFrame
      busy={busy}
      onClose={onClose}
      onSubmit={() => void submit()}
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
        placeholder={k('report.pickDevice')}
        onValueChange={({ value }) => setDeviceId(value[0] ?? '')}
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
          onValueChange={({ value }) => setSeverity((value[0] as SecuritySeverity | undefined) ?? 'high')}
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

/** Creates the siampark-work task and stores its reference on the incident. Returns whether both succeeded. */
export const linkNewTask = async (input: {
  readonly description: string;
  readonly device: SecurityDevice;
  readonly dueDate: string;
  readonly incidentId: SecurityIncident['id'];
  readonly label: ReturnType<typeof useSecurityLabel>;
  readonly revision: number;
  readonly severity: SecuritySeverity;
  readonly severityLabel: string;
  readonly tenantId: string;
  readonly title: string;
}) => {
  const k = input.label;
  const language = window.location.pathname.split('/')[1] === 'en' ? 'en' : 'cs';
  const deviceUrl = new URL(`/${language}/siampark/provoz/bezpecnost`, window.location.origin);
  deviceUrl.searchParams.set('device', input.device.id);
  const task = await createServiceTask(
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
  const linked = await runCommand(
    { _tag: 'SecurityIncidentLinkTask', incidentId: input.incidentId, task: task.task },
    input.revision,
  );
  return linked.ok;
};

/** Records a performed inspection and the next planned one. */
export const InspectionPanel = ({
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
  const [date, setDate] = useState(todayPrague());
  const [next, setNext] = useState(addDays(todayPrague(), 365));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureReason | 'required' | undefined>(undefined);
  useEffect(() => {
    if (open) {
      setDate(todayPrague());
      setNext(addDays(todayPrague(), 365));
      setNote('');
      setError(undefined);
    }
  }, [open]);
  const submit = async () => {
    if (device === undefined || date === '') {
      setError('required');
      return;
    }
    setBusy(true);
    const outcome = await run({
      _tag: 'SecurityDeviceRecordInspection',
      deviceId: device.id,
      inspectionDate: date,
      ...(next === '' ? {} : { nextInspectionDate: next }),
      ...(note.trim() === '' ? {} : { note: note.trim() }),
    });
    setBusy(false);
    if (outcome.ok) {
      toast.create({ title: k('inspectionSaved'), type: 'success' });
      onSaved();
    } else {
      setError(outcome.reason);
    }
  };
  return (
    <PanelFrame
      busy={busy}
      onClose={onClose}
      onSubmit={() => void submit()}
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
export const ResolvePanel = ({
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
  const [error, setError] = useState<FailureReason | 'required' | undefined>(undefined);
  useEffect(() => {
    if (open) {
      setResolution('');
      setError(undefined);
    }
  }, [open]);
  const submit = async () => {
    if (incident === undefined) {
      return;
    }
    setBusy(true);
    const outcome = await run({
      _tag: 'SecurityIncidentChangeState',
      incidentId: incident.id,
      state: 'resolved',
      ...(resolution.trim() === '' ? {} : { resolution: resolution.trim() }),
    });
    setBusy(false);
    if (outcome.ok) {
      toast.create({ title: k('stateSaved'), type: 'success' });
      onSaved();
    } else {
      setError(outcome.reason);
    }
  };
  return (
    <PanelFrame
      busy={busy}
      onClose={onClose}
      onSubmit={() => void submit()}
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
