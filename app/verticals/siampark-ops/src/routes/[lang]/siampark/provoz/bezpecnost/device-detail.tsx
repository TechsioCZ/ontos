// @effect-diagnostics asyncFunction:off
// Device card (S11): facts, faults with their linked service task, attachments and the change history.
import { SectionCard, SidePanel, formatDate, formatDateTime, surfaceTileClassName } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { DateTime } from 'effect';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { isInspectionOverdue } from '../../../../../../shared/commands/security.ts';
import { securityAttachmentKinds } from '../../../../../../shared/domain/security.ts';
import type {
  SecurityAttachmentKind,
  SecurityDevice,
  SecurityIncident,
} from '../../../../../../shared/domain/security.ts';
import { CommentThread } from '../../../../../ui/comment-thread.tsx';
import { ChangeHistory } from '../../../../../ui/change-history.tsx';
import { LinkedDocuments } from '../../../../../ui/linked-documents.tsx';
import { downloadFile, MAX_UPLOAD_BYTES, uploadFile } from '../../../../../ui/use-agenda.ts';
import type { RunCommand } from './device-forms.tsx';
import { linkNewTask } from './device-forms.tsx';
import {
  addDays,
  deviceStateVariant,
  incidentStateVariant,
  personaName,
  severityVariant,
  todayPrague,
  useLiveTaskStates,
  useSecurityLabel,
} from './security-model.ts';

const stamp = (value: DateTime.Utc) => value.pipe(DateTime.formatIso, formatDateTime);

const Fact = ({
  children,
  icon,
  label,
}: {
  readonly children: ReactNode;
  readonly icon: string;
  readonly label: string;
}) => (
  <div className="flex min-w-0 items-start gap-100">
    <span aria-hidden className={`${icon} shrink-0 text-fg-secondary text-lg`} />
    <div className="flex min-w-0 flex-col gap-50">
      <dt className="text-fg-secondary text-xs">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  </div>
);

const Missing = () => {
  const { t } = useModernI18n();
  return <span className="text-fg-secondary">{t('siampark-ops.common.notProvided')}</span>;
};

const tasksHref = (resourceId: string) => {
  const lang = typeof window === 'undefined' ? 'cs' : (window.location.pathname.split('/')[1] ?? 'cs');
  return `/${lang === '' ? 'cs' : lang}/siampark/work?resourceId=${encodeURIComponent(resourceId)}`;
};

const formatSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(0)} kB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const IncidentCard = ({
  busy,
  canWrite,
  incident,
  liveState,
  onChangeState,
  onCreateTask,
  onResolve,
}: {
  readonly busy: boolean;
  readonly canWrite: boolean;
  readonly incident: SecurityIncident;
  readonly liveState: ReactNode;
  readonly onChangeState: (state: SecurityIncident['state']) => void;
  readonly onCreateTask: () => void;
  readonly onResolve: () => void;
}) => {
  const k = useSecurityLabel();
  return (
    <li className={`${surfaceTileClassName} flex flex-col gap-150 p-200`} data-testid="security-incident">
      <div className="flex flex-wrap items-start justify-between gap-100">
        <div className="flex min-w-0 flex-col gap-50">
          <span className="font-semibold text-sm">{incident.title}</span>
          <span className="text-fg-secondary text-xs">
            {formatDate(incident.occurredOn)} · {k('fields.reportedBy')}: {personaName(k, incident.createdBy)}
          </span>
        </div>
        <div className="flex flex-wrap gap-50">
          <Badge size="sm" variant={severityVariant(incident.severity)}>
            {k(`severity.${incident.severity}`)}
          </Badge>
          <Badge size="sm" variant={incidentStateVariant(incident.state)}>
            {k(`incidentState.${incident.state}`)}
          </Badge>
        </div>
      </div>
      {incident.description !== undefined && incident.description !== '' && (
        <p className="whitespace-pre-line text-sm">{incident.description}</p>
      )}
      {incident.resolution !== undefined && (
        <p className="rounded-md bg-surface-secondary p-150 text-sm">
          <span className="font-medium">{k('fields.resolution')}: </span>
          {incident.resolution}
          {incident.resolvedAt !== undefined && (
            <span className="text-fg-secondary"> · {stamp(incident.resolvedAt)}</span>
          )}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-100 border-border-primary border-t pt-150 text-sm">
        <span aria-hidden className="icon-[mdi--clipboard-check-outline] size-5 text-fg-secondary" />
        {incident.task === undefined ? (
          <>
            <span className="text-fg-secondary">{k('detail.taskMissing')}</span>
            {canWrite && (
              <Button disabled={busy} onClick={onCreateTask} size="sm" theme="outlined" variant="secondary">
                {k('actions.createTask')}
              </Button>
            )}
          </>
        ) : (
          <>
            <span className="font-medium" data-testid="security-linked-task">
              {incident.task.title}
            </span>
            <span className="text-fg-secondary">{liveState}</span>
            <Link href={tasksHref(incident.task.resourceId)}>{k('actions.openTasks')}</Link>
          </>
        )}
      </div>
      {canWrite && (
        <div className="flex flex-wrap gap-100">
          {incident.state === 'reported' && (
            <Button
              disabled={busy}
              onClick={() => onChangeState('in_progress')}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              {k('actions.startWork')}
            </Button>
          )}
          {incident.state !== 'resolved' && (
            <Button disabled={busy} onClick={onResolve} size="sm" variant="primary">
              {k('actions.resolve')}
            </Button>
          )}
          {incident.state === 'resolved' && (
            <Button
              disabled={busy}
              onClick={() => onChangeState('in_progress')}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              {k('actions.reopen')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
};

export const DeviceDetailPanel = ({
  canWrite,
  device,
  incidents,
  onClose,
  onEdit,
  onInspection,
  onReload,
  onReport,
  onResolve,
  revision,
  run,
  tenantId,
}: {
  readonly canWrite: boolean;
  readonly device: SecurityDevice | undefined;
  readonly incidents: readonly SecurityIncident[];
  readonly onClose: () => void;
  readonly onEdit: () => void;
  readonly onInspection: () => void;
  readonly onReload: () => Promise<void>;
  readonly onReport: () => void;
  readonly onResolve: (incident: SecurityIncident) => void;
  readonly revision: number;
  readonly run: RunCommand;
  readonly tenantId: string;
}) => {
  const k = useSecurityLabel();
  const { t } = useModernI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<SecurityAttachmentKind>('revision_protocol');
  const fileInput = useRef<HTMLInputElement>(null);
  const own = incidents
    .filter((incident) => incident.deviceId === device?.id)
    .toSorted((left, right) => right.occurredOn.localeCompare(left.occurredOn));
  const live = useLiveTaskStates(
    own.flatMap((incident) => (incident.task === undefined ? [] : [incident.task.resourceId])),
  );
  const today = todayPrague();

  if (device === undefined) {
    return null;
  }

  const liveLabel = (resourceId: string) => {
    const state = live[resourceId];
    if (state === undefined || state.status === 'loading') {
      return '';
    }
    if (state.status === 'failed' || state.state === undefined) {
      return k('detail.taskLiveUnavailable');
    }
    return k('detail.taskLive', { state: k(`taskState.${state.state}`) });
  };

  const changeState = async (incident: SecurityIncident, state: SecurityIncident['state']) => {
    setBusy(true);
    const outcome = await run({ _tag: 'SecurityIncidentChangeState', incidentId: incident.id, state });
    setBusy(false);
    toast.create(
      outcome.ok
        ? { title: k('stateSaved'), type: 'success' }
        : { title: t(`siampark-ops.common.errors.${outcome.reason}`), type: 'error' },
    );
  };

  const createTask = async (incident: SecurityIncident) => {
    setBusy(true);
    const ok = await linkNewTask({
      description: incident.description ?? '',
      device,
      dueDate: addDays(today, 3),
      incidentId: incident.id,
      label: k,
      revision,
      severity: incident.severity,
      severityLabel: k(`severity.${incident.severity}`),
      tenantId,
      title: incident.title,
    });
    await onReload();
    setBusy(false);
    toast.create(ok ? { title: k('taskCreated'), type: 'success' } : { title: k('report.taskFailed'), type: 'error' });
  };

  const upload = async (file: File) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.create({ title: k('uploadFailed'), type: 'error' });
      return;
    }
    setBusy(true);
    const uploaded = await uploadFile(file);
    if (!uploaded.ok) {
      setBusy(false);
      toast.create({ title: k('uploadFailed'), type: 'error' });
      return;
    }
    const outcome = await run({ _tag: 'SecurityDeviceAttach', deviceId: device.id, file: uploaded.file, kind });
    setBusy(false);
    toast.create(
      outcome.ok
        ? { title: k('uploaded'), type: 'success' }
        : { title: t(`siampark-ops.common.errors.${outcome.reason}`), type: 'error' },
    );
  };

  const overdue = isInspectionOverdue(device, today);
  const attachments = device.attachments ?? [];
  const history = (device.history ?? []).toSorted(
    (left, right) => DateTime.toEpochMillis(right.at) - DateTime.toEpochMillis(left.at),
  );

  return (
    <SidePanel
      closeOnInteractOutside
      description={
        <span className="flex flex-wrap items-center gap-100">
          <Badge size="sm" variant="outline">
            {k(`deviceType.${device.deviceType}`)}
          </Badge>
          <Badge size="sm" variant={deviceStateVariant(device.state)}>
            {k(`state.${device.state}`)}
          </Badge>
          {overdue && (
            <Badge size="sm" variant="danger">
              {k('stats.overdue')}
            </Badge>
          )}
          <Badge size="sm" variant="info">
            {k('evidenceOnly')}
          </Badge>
        </span>
      }
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open
      resizeLabel={t('siampark-ops.common.close')}
      size="lg"
      title={device.name}
    >
      <div className="flex flex-col gap-250 py-200" data-testid="security-device-detail">
        {canWrite && (
          <div className="flex flex-wrap gap-100">
            {device.state !== 'decommissioned' && (
              <Button icon="icon-[mdi--alert-outline]" onClick={onReport} size="sm" variant="primary">
                {k('actions.reportFault')}
              </Button>
            )}
            <Button
              icon="icon-[mdi--clipboard-check-outline]"
              onClick={onInspection}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              {k('actions.inspection')}
            </Button>
            <Button icon="icon-[mdi--pencil-outline]" onClick={onEdit} size="sm" theme="outlined" variant="secondary">
              {k('actions.edit')}
            </Button>
          </div>
        )}

        <SectionCard title={k('detail.card')}>
          <dl className="grid grid-cols-1 gap-200 sm:grid-cols-2">
            <Fact icon="icon-[mdi--office-building-outline]" label={k('fields.location')}>
              {device.location?.label ?? <Missing />}
            </Fact>
            <Fact icon="icon-[mdi--map-marker-check-outline]" label={k('fields.locationDetail')}>
              {device.locationDetail ?? <Missing />}
            </Fact>
            <Fact icon="icon-[mdi--account-tie-outline]" label={k('fields.administrator')}>
              {device.administrator ?? <Missing />}
            </Fact>
            <Fact icon="icon-[mdi--truck-delivery-outline]" label={k('fields.supplier')}>
              {device.supplier ?? <Missing />}
            </Fact>
            <Fact icon="icon-[mdi--key-variant]" label={k('fields.serialNumber')}>
              {device.serialNumber ?? <Missing />}
            </Fact>
            <Fact icon="icon-[mdi--shield-check-outline]" label={k('fields.state')}>
              {k(`state.${device.state}`)}
            </Fact>
            <Fact icon="icon-[mdi--history]" label={k('fields.lastInspectionDate')}>
              {device.lastInspectionDate === undefined ? <Missing /> : formatDate(device.lastInspectionDate)}
            </Fact>
            <Fact icon="icon-[mdi--calendar-account-outline]" label={k('fields.nextInspectionDate')}>
              {device.nextInspectionDate === undefined ? (
                <Missing />
              ) : (
                <span className={overdue ? 'font-semibold text-fg-danger' : ''}>
                  {formatDate(device.nextInspectionDate)}
                  {overdue ? ` · ${k('detail.overdue')}` : ''}
                </span>
              )}
            </Fact>
          </dl>
          {device.note !== undefined && device.note !== '' && (
            <p className="whitespace-pre-line rounded-md bg-surface-secondary p-150 text-sm">{device.note}</p>
          )}
          <p className="text-fg-secondary text-xs">
            {k('detail.createdInfo', { at: stamp(device.createdAt), by: personaName(k, device.createdBy) })}
            {' · '}
            {k('detail.updatedInfo', { at: stamp(device.updatedAt), by: personaName(k, device.updatedBy) })}
          </p>
        </SectionCard>

        <SectionCard title={`${k('detail.incidents')} (${own.length})`}>
          {own.length === 0 ? (
            <p className="text-fg-secondary text-sm">{k('detail.noIncidents')}</p>
          ) : (
            <ul className="flex flex-col gap-150">
              {own.map((incident) => (
                <IncidentCard
                  busy={busy}
                  canWrite={canWrite}
                  incident={incident}
                  key={incident.id}
                  liveState={incident.task === undefined ? '' : liveLabel(incident.task.resourceId)}
                  onChangeState={(state) => void changeState(incident, state)}
                  onCreateTask={() => void createTask(incident)}
                  onResolve={() => onResolve(incident)}
                />
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          actions={
            canWrite ? (
              <div className="flex flex-wrap items-end gap-100">
                <div className="w-48">
                  <Select
                    items={securityAttachmentKinds.map((value) => ({
                      displayValue: k(`attachmentKind.${value}`),
                      label: k(`attachmentKind.${value}`),
                      value,
                    }))}
                    label={k('fields.attachmentKind')}
                    name="attachmentKind"
                    onValueChange={({ value }) =>
                      setKind((value[0] as SecurityAttachmentKind | undefined) ?? 'revision_protocol')
                    }
                    size="sm"
                    value={[kind]}
                  />
                </div>
                <input
                  aria-label={k('fields.file')}
                  className="hidden"
                  data-testid="security-file-input"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file !== undefined) {
                      void upload(file);
                    }
                  }}
                  ref={fileInput}
                  type="file"
                />
                <Button
                  disabled={busy}
                  icon="icon-[mdi--paperclip]"
                  onClick={() => fileInput.current?.click()}
                  size="sm"
                  theme="outlined"
                  variant="secondary"
                >
                  {k('actions.upload')}
                </Button>
              </div>
            ) : undefined
          }
          title={k('detail.attachments')}
        >
          {attachments.length === 0 ? (
            <p className="text-fg-secondary text-sm">{k('detail.noAttachments')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border-primary">
              {attachments.map((attachment) => (
                <li className="flex flex-wrap items-center justify-between gap-100 py-100" key={attachment.file.id}>
                  <div className="flex min-w-0 items-center gap-100">
                    <span aria-hidden className="icon-[mdi--file-document-outline] size-5 shrink-0 text-fg-secondary" />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate font-medium text-sm">{attachment.file.name}</span>
                      <span className="text-fg-secondary text-xs">
                        {k(`attachmentKind.${attachment.kind}`)} · {formatSize(attachment.file.size)} ·{' '}
                        {stamp(attachment.addedAt)} · {personaName(k, attachment.addedBy)}
                      </span>
                    </div>
                  </div>
                  <Button
                    icon="icon-[mdi--download]"
                    onClick={() =>
                      void downloadFile(attachment.file.id).then((result) => {
                        if (!result.ok) {
                          toast.create({ title: k('downloadFailed'), type: 'error' });
                        }
                      })
                    }
                    size="sm"
                    theme="outlined"
                    variant="secondary"
                  >
                    {k('actions.download')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {canWrite && <p className="text-fg-secondary text-xs">{k('detail.maxSize')}</p>}
        </SectionCard>

        <SectionCard title={k('detail.linkedDocuments')}>
          <LinkedDocuments subject={{ id: device.id, kind: 'device', label: device.name }} />
        </SectionCard>

        <SectionCard>
          <CommentThread subject={{ id: device.id, kind: 'device', label: device.name }} title={k('detail.comments')} />
        </SectionCard>

        <SectionCard>
          <ChangeHistory entityId={device.id} refreshKey={DateTime.toEpochMillis(device.updatedAt)} />
        </SectionCard>

        <SectionCard title={k('detail.history')}>
          <ol className="flex flex-col gap-150 border-border-primary border-l pl-200">
            {history.map((entry, index) => (
              <li className="flex flex-col gap-50" key={`${DateTime.toEpochMillis(entry.at)}-${index}`}>
                <span className="text-sm">
                  <span className="font-medium">{k(`history.${entry.event}`)}</span> · {entry.summary}
                </span>
                <span className="text-fg-secondary text-xs">
                  {stamp(entry.at)} · {personaName(k, entry.by)}
                </span>
              </li>
            ))}
          </ol>
        </SectionCard>
      </div>
    </SidePanel>
  );
};
