import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
// Device card (S11): facts, faults with their linked service task, attachments and the change history.
import { SectionCard, SidePanel, formatDate, formatDateTime, surfaceTileClassName } from '@app/admin-ui';
import {
  FileField,
  FormBuilder,
  FormReact,
  FormRoot,
  TemplateChoiceField,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DateTime, Effect, Option, Predicate, Schema } from 'effect';
import { Atom } from 'effect/reactivity';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { isInspectionOverdue } from '../../../../../shared/commands/security.ts';
import { SecurityAttachmentKindSchema, securityAttachmentKinds } from '../../../../../shared/domain/security.ts';
import type {
  SecurityAttachmentKind,
  SecurityDevice,
  SecurityIncident,
} from '../../../../../shared/domain/security.ts';
import { CommentThread } from '../../../../ui/comment-thread.tsx';
import { ChangeHistory } from '../../../../ui/change-history.tsx';
import { LinkedDocuments } from '../../../../ui/linked-documents.tsx';
import { downloadFile, MAX_UPLOAD_BYTES, uploadFile } from '../../../../ui/use-agenda.ts';
import type { RunCommand, TaskLinkOutcome } from './device-forms.tsx';
import { linkNewTask } from './device-forms.tsx';
import {
  addDays,
  deviceStateVariant,
  incidentStateVariant,
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
  return <span className="text-fg-secondary">{t('facility-operations.common.notProvided')}</span>;
};

const tasksHref = (resourceId: string) => {
  const lang = Predicate.isUndefined(globalThis.window) ? 'cs' : (window.location.pathname.split('/')[1] ?? 'cs');
  return `/${lang === '' ? 'cs' : lang}/ukoly?resourceId=${encodeURIComponent(resourceId)}`;
};

const formatSize = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} kB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

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
          <span className="text-fg-secondary text-xs">{formatDate(incident.occurredOn)}</span>
        </div>
        <div className="flex flex-wrap gap-50">
          <Badge severity={severityVariant(incident.severity)} size="sm">
            {k(`severity.${incident.severity}`)}
          </Badge>
          <Badge severity={incidentStateVariant(incident.state)} size="sm">
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
              <Button appearance="outline" disabled={busy} onClick={onCreateTask} severity="secondary" size="sm">
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
              appearance="outline"
              disabled={busy}
              onClick={() => onChangeState('in_progress')}
              severity="secondary"
              size="sm"
            >
              {k('actions.startWork')}
            </Button>
          )}
          {incident.state !== 'resolved' && (
            <Button disabled={busy} onClick={onResolve} severity="primary" size="sm">
              {k('actions.resolve')}
            </Button>
          )}
          {incident.state === 'resolved' && (
            <Button
              appearance="outline"
              disabled={busy}
              onClick={() => onChangeState('in_progress')}
              severity="secondary"
              size="sm"
            >
              {k('actions.reopen')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
};

/** An attachment to upload: its kind, then the file, which uploads as soon as it is picked. */
const attachmentForm = FormReact.make(
  FormBuilder.empty
    .addField('attachmentKind', Schema.String)
    .addField('file', Schema.OptionFromNullOr(Schema.instanceOf(File))),
  {
    fields: { attachmentKind: TemplateChoiceField, file: FileField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
const noAttachment = { attachmentKind: 'revision_protocol', file: null };
/** The picked file, which changes only when the pick does. */
const pickedAttachment = attachmentForm
  .getFieldAtoms(attachmentForm.fields.file)
  .value.pipe(Atom.map(Option.getOrElse((): File | null => null)));

const DeviceAttachments = ({
  attachments,
  busy,
  canWrite,
  onDownload,
  onUpload,
}: {
  readonly attachments: NonNullable<SecurityDevice['attachments']>;
  readonly busy: boolean;
  readonly canWrite: boolean;
  readonly onDownload: (fileId: string) => void;
  readonly onUpload: (file: File, kind: SecurityAttachmentKind) => void;
}) => {
  const k = useSecurityLabel();
  const { t } = useModernI18n();
  const { attachmentKind } = Option.getOrElse(useAtomValue(attachmentForm.values), () => noAttachment);
  const kind: SecurityAttachmentKind = Schema.is(SecurityAttachmentKindSchema)(attachmentKind)
    ? attachmentKind
    : 'revision_protocol';
  const setFile = useAtomSet(attachmentForm.getFieldAtoms(attachmentForm.fields.file).setValue);
  useAtomSubscribe(
    pickedAttachment,
    (picked) => {
      if (picked !== null) {
        setFile(null);
        onUpload(picked, kind);
      }
    },
    { immediate: false },
  );
  return (
    <SectionCard
      actions={
        canWrite ? (
          <FormRoot
            className="flex flex-wrap items-end gap-100"
            defaultValues={noAttachment}
            form={attachmentForm}
            translateMessage={(message) => t(message)}
          >
            <div className="w-48">
              <attachmentForm.attachmentKind
                items={securityAttachmentKinds.map((value) => ({ label: k(`attachmentKind.${value}`), value }))}
                label={k('fields.attachmentKind')}
                size="sm"
              />
            </div>
            <attachmentForm.file aria-label={k('fields.file')} className="hidden" data-testid="security-file-input">
              {(pick) => (
                <Button
                  appearance="outline"
                  disabled={busy}
                  icon="icon-[mdi--paperclip]"
                  onClick={pick}
                  severity="secondary"
                  size="sm"
                  type="button"
                >
                  {k('actions.upload')}
                </Button>
              )}
            </attachmentForm.file>
          </FormRoot>
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
                    {stamp(attachment.addedAt)}
                  </span>
                </div>
              </div>
              <Button
                appearance="outline"
                icon="icon-[mdi--download]"
                onClick={() => {
                  onDownload(attachment.file.id);
                }}
                severity="secondary"
                size="sm"
              >
                {k('actions.download')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {canWrite && <p className="text-fg-secondary text-xs">{k('detail.maxSize')}</p>}
    </SectionCard>
  );
};

interface ChangeSecurityIncidentStateInput {
  readonly incident: SecurityIncident;
  readonly k: ReturnType<typeof useSecurityLabel>;
  readonly run: RunCommand;
  readonly setBusy: (busy: boolean) => void;
  readonly state: SecurityIncident['state'];
  readonly t: ReturnType<typeof useModernI18n>['t'];
  readonly toast: ReturnType<typeof useToast>;
}

const changeSecurityIncidentState = Effect.fn('Facility.changeSecurityIncidentState')(
  function* changeSecurityIncidentState({
    incident,
    k,
    run,
    setBusy,
    state,
    t,
    toast,
  }: ChangeSecurityIncidentStateInput) {
    setBusy(true);
    const outcome = yield* run({ _tag: 'SecurityIncidentChangeState', incidentId: incident.id, state });
    setBusy(false);
    toast.create(
      outcome.ok
        ? { title: k('stateSaved'), type: 'success' }
        : { title: t(`facility-operations.common.errors.${outcome.reason}`), type: 'error' },
    );
  },
);

interface CreateSecurityIncidentTaskInput {
  readonly device: SecurityDevice;
  readonly incident: SecurityIncident;
  readonly k: ReturnType<typeof useSecurityLabel>;
  readonly onReload: () => Effect.Effect<void>;
  readonly revision: number;
  readonly setBusy: (busy: boolean) => void;
  readonly t: ReturnType<typeof useModernI18n>['t'];
  readonly tenantId: string;
  readonly toast: ReturnType<typeof useToast>;
  readonly today: SecurityIncident['occurredOn'];
}

const createSecurityIncidentTask = Effect.fn('Facility.createSecurityIncidentTask')(
  function* createSecurityIncidentTask({
    device,
    incident,
    k,
    onReload,
    revision,
    setBusy,
    t,
    tenantId,
    toast,
    today,
  }: CreateSecurityIncidentTaskInput) {
    setBusy(true);
    const outcome = yield* linkNewTask({
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
    yield* onReload();
    setBusy(false);
    toast.create(
      (
        {
          failed: { title: k('report.taskFailed'), type: 'error' },
          linked: { title: k('taskCreated'), type: 'success' },
          pending_approval: { title: t('facility-operations.common.errors.approval_required'), type: 'info' },
        } satisfies Record<TaskLinkOutcome, Parameters<typeof toast.create>[0]>
      )[outcome],
    );
  },
);

interface UploadSecurityAttachmentInput {
  readonly device: SecurityDevice;
  readonly file: File;
  readonly k: ReturnType<typeof useSecurityLabel>;
  readonly kind: SecurityAttachmentKind;
  readonly run: RunCommand;
  readonly setBusy: (busy: boolean) => void;
  readonly t: ReturnType<typeof useModernI18n>['t'];
  readonly toast: ReturnType<typeof useToast>;
}

const uploadSecurityAttachment = Effect.fn('Facility.uploadSecurityAttachment')(function* uploadSecurityAttachment({
  device,
  file,
  k,
  kind,
  run,
  setBusy,
  t,
  toast,
}: UploadSecurityAttachmentInput) {
  if (file.size > MAX_UPLOAD_BYTES) {
    toast.create({ title: k('uploadFailed'), type: 'error' });
    return;
  }
  setBusy(true);
  const uploaded = yield* uploadFile(file);
  if (!uploaded.ok) {
    setBusy(false);
    toast.create({ title: k('uploadFailed'), type: 'error' });
    return;
  }
  const outcome = yield* run({ _tag: 'SecurityDeviceAttach', deviceId: device.id, file: uploaded.file, kind });
  setBusy(false);
  toast.create(
    outcome.ok
      ? { title: k('uploaded'), type: 'success' }
      : { title: t(`facility-operations.common.errors.${outcome.reason}`), type: 'error' },
  );
});

const DeviceFacts = ({ device, overdue }: { readonly device: SecurityDevice; readonly overdue: boolean }) => {
  const k = useSecurityLabel();
  return (
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
        {k('detail.createdInfo', { at: stamp(device.createdAt) })}
        {' · '}
        {k('detail.updatedInfo', { at: stamp(device.updatedAt) })}
      </p>
    </SectionCard>
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
  readonly onReload: () => Effect.Effect<void>;
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

  const changeState = (incident: SecurityIncident, state: SecurityIncident['state']) =>
    changeSecurityIncidentState({ incident, k, run, setBusy, state, t, toast });

  const createTask = (incident: SecurityIncident) =>
    createSecurityIncidentTask({ device, incident, k, onReload, revision, setBusy, t, tenantId, toast, today });

  const upload = (file: File, kind: SecurityAttachmentKind) =>
    uploadSecurityAttachment({ device, file, k, kind, run, setBusy, t, toast });

  const overdue = isInspectionOverdue(device, today);
  const attachments = device.attachments ?? [];
  const history = (device.history ?? []).toSorted(
    (left, right) => DateTime.toEpochMillis(right.at) - DateTime.toEpochMillis(left.at),
  );

  return (
    <SidePanel
      description={
        <span className="flex flex-wrap items-center gap-100">
          <Badge appearance="outline" severity="neutral" size="sm">
            {k(`deviceType.${device.deviceType}`)}
          </Badge>
          <Badge severity={deviceStateVariant(device.state)} size="sm">
            {k(`state.${device.state}`)}
          </Badge>
          {overdue && (
            <Badge severity="danger" size="sm">
              {k('stats.overdue')}
            </Badge>
          )}
          <Badge severity="info" size="sm">
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
      resizeLabel={t('facility-operations.common.close')}
      size="lg"
      title={device.name}
    >
      <div className="flex flex-col gap-250 py-200" data-testid="security-device-detail">
        {canWrite && (
          <div className="flex flex-wrap gap-100">
            {device.state !== 'decommissioned' && (
              <Button icon="icon-[mdi--alert-outline]" onClick={onReport} severity="primary" size="sm">
                {k('actions.reportFault')}
              </Button>
            )}
            <Button
              appearance="outline"
              icon="icon-[mdi--clipboard-check-outline]"
              onClick={onInspection}
              severity="secondary"
              size="sm"
            >
              {k('actions.inspection')}
            </Button>
            <Button
              appearance="outline"
              icon="icon-[mdi--pencil-outline]"
              onClick={onEdit}
              severity="secondary"
              size="sm"
            >
              {k('actions.edit')}
            </Button>
          </div>
        )}

        <DeviceFacts device={device} overdue={overdue} />

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
                  onChangeState={(state) => {
                    void browserRuntime.runPromise(changeState(incident, state));
                  }}
                  onCreateTask={() => {
                    void browserRuntime.runPromise(createTask(incident));
                  }}
                  onResolve={() => onResolve(incident)}
                />
              ))}
            </ul>
          )}
        </SectionCard>

        <DeviceAttachments
          attachments={attachments}
          busy={busy}
          canWrite={canWrite}
          onDownload={(fileId) => {
            void browserRuntime.runPromise(
              downloadFile(fileId).pipe(
                Effect.tap((result) =>
                  Effect.sync(() => {
                    if (!result.ok) {
                      toast.create({ title: k('downloadFailed'), type: 'error' });
                    }
                  }),
                ),
              ),
            );
          }}
          onUpload={(file, kind) => {
            void browserRuntime.runPromise(upload(file, kind));
          }}
        />

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
                <span className="text-fg-secondary text-xs">{stamp(entry.at)}</span>
              </li>
            ))}
          </ol>
        </SectionCard>
      </div>
    </SidePanel>
  );
};
