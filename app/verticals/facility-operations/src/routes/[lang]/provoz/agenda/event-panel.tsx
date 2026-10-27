// Detail of one calendar entry. Derived deadlines are read-only here: the date is changed in the source record
// (S13 „Termín se upravuje v původním záznamu“). Own calendar events can be edited, reassigned, completed or
// cancelled, and carry a comment thread (S14). Also the create form. Owned by the ops-agenda lane.
import { DetailList, SidePanel } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { DateTime, Effect, Schema } from 'effect';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { useState } from 'react';
import { OpsCommandSchema } from '../../../../../shared/agendas.ts';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import type { AgendaState, CalendarEvent, CalendarEventKind } from '../../../../../shared/domain/agenda.ts';
import type { PropertyRef } from '../../../../../shared/domain/common.ts';
import { CommentThread } from '../../../../ui/comment-thread.tsx';
import { urgencyOf } from '../../../../ui/ops-agenda/deadlines.ts';
import type { Deadline } from '../../../../../shared/domain/ops-overview.ts';
import { useAgendaPeople } from '../../../../ui/ops-agenda/agenda-people.tsx';
import { Pill, categoryTone, fmt, langOf, urgencyTone } from '../../../../ui/ops-agenda/ui-bits.tsx';
import { usePropertyOptions } from '../../../../ui/property-options.ts';
import type { CommandOutcome } from '../../../../ui/use-agenda.ts';

const k = 'facility-operations.agenda';
const kinds: readonly CalendarEventKind[] = ['MEETING', 'DEADLINE', 'INSPECTION', 'REMINDER'];
const NONE = 'none';
interface PanelFeedback {
  readonly cause?: Schema.SchemaError;
  readonly message: string;
}
type WireCommand = typeof OpsCommandSchema.Encoded;
type CreateEventCommand = Extract<WireCommand, { readonly _tag: 'AgendaEventCreate' }>;
type UpdateEventCommand = Extract<WireCommand, { readonly _tag: 'AgendaEventUpdate' }>;

interface Draft {
  readonly assignee: string;
  readonly date: string;
  readonly kind: CalendarEventKind;
  readonly location: string;
  readonly note: string;
  readonly title: string;
}

const emptyDraft = (date: string): Draft => ({
  assignee: NONE,
  date,
  kind: 'MEETING',
  location: NONE,
  note: '',
  title: '',
});

const draftOf = (event: CalendarEvent): Draft => ({
  assignee: event.assignee?.principalId ?? NONE,
  date: event.date,
  kind: event.kind,
  location: event.related === undefined ? NONE : `${event.related.kind}:${event.related.id}`,
  note: event.note ?? '',
  title: event.title,
});

const EventForm = ({ draft, setDraft }: { readonly draft: Draft; readonly setDraft: (draft: Draft) => void }) => {
  const { t } = useModernI18n();
  const properties = usePropertyOptions();
  const people = useAgendaPeople();
  return (
    <div className="facilityoperations:flex facilityoperations:flex-col facilityoperations:gap-3">
      <FormInput
        autoComplete="off"
        id="ops-agenda-title"
        label={t(`${k}.fields.title`)}
        maxLength={300}
        onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        required
        value={draft.title}
      />
      <div className="facilityoperations:grid facilityoperations:grid-cols-2 facilityoperations:gap-3">
        <FormInput
          id="ops-agenda-date"
          label={t(`${k}.fields.date`)}
          onChange={(event) => setDraft({ ...draft, date: event.target.value })}
          required
          type="date"
          value={draft.date}
        />
        <Select
          items={kinds.map((value) => ({
            displayValue: t(`${k}.kind.${value}`),
            label: t(`${k}.kind.${value}`),
            value,
          }))}
          label={t(`${k}.fields.kind`)}
          name="kind"
          onValueChange={({ value }) =>
            setDraft({ ...draft, kind: kinds.find((kind) => kind === value[0]) ?? 'MEETING' })
          }
          size="md"
          value={[draft.kind]}
        />
      </div>
      <Select
        items={[
          { displayValue: t(`${k}.fields.nobody`), label: t(`${k}.fields.nobody`), value: NONE },
          ...people.map((person) => ({
            displayValue: person.displayName,
            label: person.displayName,
            value: person.principalId,
          })),
          ...(draft.assignee !== NONE && !people.some((person) => person.principalId === draft.assignee)
            ? [
                {
                  displayValue: t(`${k}.fields.currentAssignee`),
                  label: t(`${k}.fields.currentAssignee`),
                  value: draft.assignee,
                },
              ]
            : []),
        ]}
        label={t(`${k}.fields.knownAssignee`)}
        name="assignee"
        onValueChange={({ value }) => setDraft({ ...draft, assignee: value[0] ?? NONE })}
        size="md"
        value={[draft.assignee]}
      />
      {properties.status === 'ready' && (
        <Select
          items={[
            {
              displayValue: t('facility-operations.property.none'),
              label: t('facility-operations.property.none'),
              value: NONE,
            },
            ...properties.options.map((option) => ({
              displayValue: option.ref.label,
              label: option.ref.label,
              value: option.value,
            })),
          ]}
          label={t('facility-operations.common.location')}
          name="location"
          onValueChange={({ value }) => setDraft({ ...draft, location: value[0] ?? NONE })}
          size="md"
          value={[draft.location]}
        />
      )}
      <FormTextarea
        id="ops-agenda-note"
        label={t('facility-operations.common.note')}
        maxLength={4000}
        onChange={(event) => setDraft({ ...draft, note: event.target.value })}
        rows={3}
        value={draft.note}
      />
    </div>
  );
};

const useLocationRef = () => {
  const properties = usePropertyOptions();
  return (value: string): PropertyRef | undefined =>
    value === NONE || properties.status !== 'ready'
      ? undefined
      : properties.options.find((option) => option.value === value)?.ref;
};

export const CreateEventPanel = ({
  initialDate,
  onClose,
  onRun,
  open,
}: {
  readonly initialDate: string;
  readonly onClose: () => void;
  readonly onRun: (command: OpsCommand) => Effect.Effect<CommandOutcome>;
  readonly open: boolean;
}) => {
  const { t } = useModernI18n();
  const [draft, setDraft] = useState(() => emptyDraft(initialDate));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PanelFeedback>();
  const locationRef = useLocationRef();
  const people = useAgendaPeople();
  const personOf = (id: string | undefined) => people.find((person) => person.principalId === id);
  const [previousForm, setPreviousForm] = useState({ initialDate, open });
  if (previousForm.open !== open || previousForm.initialDate !== initialDate) {
    setPreviousForm({ initialDate, open });
    if (open) {
      setDraft(emptyDraft(initialDate));
      setError(undefined);
    }
  }
  const submit = () => {
    if (draft.title.trim() === '' || !/^\d{4}-\d{2}-\d{2}$/u.test(draft.date)) {
      setError({ message: t('facility-operations.common.required') });
      return;
    }
    setBusy(true);
    const related = locationRef(draft.location);
    const assignee = personOf(draft.assignee === NONE ? undefined : draft.assignee);
    const command: { -readonly [Key in keyof CreateEventCommand]: CreateEventCommand[Key] } = {
      _tag: 'AgendaEventCreate',
      date: draft.date,
      kind: draft.kind,
      title: draft.title.trim(),
    };
    if (assignee !== undefined) {
      command.assignee = { principalId: assignee.principalId, tenantId: assignee.tenantId };
      command.assigneeLabel = assignee.displayName;
    }
    if (related !== undefined) {
      command.related = related;
    }
    if (draft.note.trim() !== '') {
      command.note = draft.note.trim();
    }
    browserRuntime.runFork(
      Schema.decodeEffect(OpsCommandSchema)(command).pipe(
        Effect.flatMap(onRun),
        Effect.match({
          onFailure: (cause) => {
            setBusy(false);
            setError({ cause, message: t('facility-operations.common.errors.invalid') });
          },
          onSuccess: (outcome) => {
            setBusy(false);
            if (outcome.ok) {
              onClose();
            } else {
              setError({ message: t(`facility-operations.common.errors.${outcome.reason}`) });
            }
          },
        }),
      ),
    );
  };
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
            onClick={() => {
              submit();
            }}
            variant="primary"
          >
            {t(`${k}.create.submit`)}
          </Button>
        </>
      }
      closeOnInteractOutside={false}
      description={t(`${k}.create.description`)}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open={open}
      resizeLabel={t('facility-operations.common.close')}
      size="md"
      title={t(`${k}.create.title`)}
    >
      <div className="facilityoperations:flex facilityoperations:flex-col facilityoperations:gap-3 facilityoperations:py-2">
        {error !== undefined && (
          <StatusText showIcon status="error">
            {error.message}
          </StatusText>
        )}
        <EventForm draft={draft} setDraft={setDraft} />
      </div>
    </SidePanel>
  );
};

const useDeadlinePanel = ({
  canWrite,
  deadline,
  onClose,
  onRun,
  state,
  today,
}: {
  readonly canWrite: boolean;
  readonly deadline: Deadline | undefined;
  readonly onClose: () => void;
  readonly onRun: (command: OpsCommand) => Effect.Effect<CommandOutcome>;
  readonly state: AgendaState | undefined;
  readonly today: string;
}) => {
  const { language, t } = useModernI18n();
  const lang = langOf(language);
  const event =
    deadline?.eventId === undefined ? undefined : state?.events.find((entry) => entry.id === deadline.eventId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft | undefined>(() => (event === undefined ? undefined : draftOf(event)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PanelFeedback>();
  const locationRef = useLocationRef();
  const people = useAgendaPeople();
  const personOf = (id: string | undefined) => people.find((person) => person.principalId === id);
  const [previousRecord, setPreviousRecord] = useState({ event, key: deadline?.key });
  if (previousRecord.key !== deadline?.key || previousRecord.event !== event) {
    setPreviousRecord({ event, key: deadline?.key });
    setEditing(false);
    setError(undefined);
    setDraft(event === undefined ? undefined : draftOf(event));
  }

  const run = (command: WireCommand, close = false) => {
    setBusy(true);
    browserRuntime.runFork(
      Schema.decodeEffect(OpsCommandSchema)(command).pipe(
        Effect.flatMap(onRun),
        Effect.match({
          onFailure: (cause) => {
            setBusy(false);
            setError({ cause, message: t('facility-operations.common.errors.invalid') });
          },
          onSuccess: (outcome) => {
            setBusy(false);
            if (outcome.ok) {
              setEditing(false);
              setError(undefined);
              if (close) {
                onClose();
              }
            } else {
              setError({ message: t(`facility-operations.common.errors.${outcome.reason}`) });
            }
          },
        }),
      ),
    );
  };

  const save = () => {
    if (event === undefined || draft === undefined) {
      return;
    }
    if (draft.title.trim() === '' || !/^\d{4}-\d{2}-\d{2}$/u.test(draft.date)) {
      setError({ message: t('facility-operations.common.required') });
      return;
    }
    const assignee = personOf(draft.assignee === NONE ? undefined : draft.assignee);
    const related = locationRef(draft.location);
    let command: UpdateEventCommand = {
      _tag: 'AgendaEventUpdate',
      date: draft.date,
      eventId: event.id,
      kind: draft.kind,
      note: draft.note.trim(),
      title: draft.title.trim(),
    };
    if (draft.assignee === NONE) {
      command = { ...command, assignee: null };
    } else if (assignee !== undefined) {
      command = {
        ...command,
        assignee: { principalId: assignee.principalId, tenantId: assignee.tenantId },
        assigneeLabel: assignee.displayName,
      };
    }
    if (draft.location === NONE) {
      command = { ...command, related: null };
    } else if (related !== undefined) {
      command = { ...command, related };
    }
    run(command);
  };

  const status = event?.status ?? 'PLANNED';
  const urgency = deadline === undefined ? 'later' : urgencyOf(deadline, today);
  const owner = personOf(deadline?.ownerPrincipalId);

  return {
    busy,
    canWrite,
    deadline,
    draft,
    editing,
    error,
    event,
    lang,
    onClose,
    owner,
    personOf,
    run,
    save,
    setDraft,
    setEditing,
    status,
    t,
    urgency,
  };
};

const renderDeadlineActions = ({
  busy,
  canWrite,
  deadline,
  editing,
  event,
  lang,
  run,
  save,
  setEditing,
  status,
  t,
}: ReturnType<typeof useDeadlinePanel>) => {
  if (event !== undefined && canWrite) {
    return editing ? (
      <>
        <Button onClick={() => setEditing(false)} theme="outlined" variant="secondary">
          {t('facility-operations.common.cancel')}
        </Button>
        <Button isLoading={busy} loadingText={t('facility-operations.common.saving')} onClick={save} variant="primary">
          {t('facility-operations.common.save')}
        </Button>
      </>
    ) : (
      <div className="ops-event-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, width: '100%' }}>
        <style>{`.ops-event-actions > button { flex: 1 1 165px; height: auto; min-height: 44px; white-space: normal; padding-block: 10px; }`}</style>
        {status === 'PLANNED' && (
          <Button
            isLoading={busy}
            onClick={() => {
              run({ _tag: 'AgendaEventUpdate', eventId: event.id, status: 'CANCELLED' }, true);
            }}
            theme="borderless"
            variant="danger"
          >
            {t(`${k}.event.cancel`)}
          </Button>
        )}
        {status === 'PLANNED' ? (
          <Button
            isLoading={busy}
            onClick={() => {
              run({ _tag: 'AgendaEventUpdate', eventId: event.id, status: 'DONE' });
            }}
            theme="outlined"
            variant="secondary"
          >
            {t(`${k}.event.done`)}
          </Button>
        ) : (
          <Button
            isLoading={busy}
            onClick={() => {
              run({ _tag: 'AgendaEventUpdate', eventId: event.id, status: 'PLANNED' });
            }}
            theme="outlined"
            variant="secondary"
          >
            {t(`${k}.event.reopen`)}
          </Button>
        )}
        <Button onClick={() => setEditing(true)} variant="primary">
          {t(`${k}.event.edit`)}
        </Button>
      </div>
    );
  }
  if (deadline !== undefined && deadline.eventId === undefined) {
    return (
      <a className="facilityoperations:font-medium" href={`/${lang}${deadline.href}`}>
        {t(`${k}.event.openSource`, { source: t(`${k}.sources.${deadline.source}`) })}
      </a>
    );
  }
  return null;
};

const renderDeadlineDetails = ({ deadline, event, lang, owner, personOf, t }: ReturnType<typeof useDeadlinePanel>) => {
  if (deadline === undefined) {
    return null;
  }
  return (
    <DetailList
      items={[
        { label: t(`${k}.columns.date`), value: fmt.long(lang, deadline.date) },
        { label: t(`${k}.columns.source`), value: t(`${k}.sources.${deadline.source}`) },
        ...(deadline.location === undefined ? [] : [{ label: t(`${k}.columns.location`), value: deadline.location }]),
        ...(event?.kind === undefined ? [] : [{ label: t(`${k}.fields.kind`), value: t(`${k}.kind.${event.kind}`) }]),
        ...(owner === undefined ? [] : [{ label: t(`${k}.fields.owner`), value: owner.displayName }]),
        ...(deadline.amountMinor === undefined
          ? []
          : [
              {
                label: t(`${k}.columns.amount`),
                value: `${(deadline.amountMinor / 100).toLocaleString('cs-CZ')} Kč`,
              },
            ]),
        ...(event?.note === undefined || event.note === ''
          ? []
          : [{ label: t('facility-operations.common.note'), value: event.note }]),
        ...(event === undefined
          ? []
          : [
              {
                label: t('facility-operations.common.createdBy'),
                value: [
                  personOf(event.createdBy.principalId)?.displayName,
                  fmt.stamp(lang, DateTime.formatIso(event.createdAt)),
                ]
                  .filter((part) => part !== undefined)
                  .join(' · '),
              },
              {
                label: t('facility-operations.common.updatedAt'),
                value: [
                  personOf(event.updatedBy.principalId)?.displayName,
                  fmt.stamp(lang, DateTime.formatIso(event.updatedAt)),
                ]
                  .filter((part) => part !== undefined)
                  .join(' · '),
              },
            ]),
      ]}
    />
  );
};

export const DeadlinePanel = (props: Parameters<typeof useDeadlinePanel>[0]) => {
  const model = useDeadlinePanel(props);
  const { deadline, draft, editing, error, event, onClose, setDraft, status, t, urgency } = model;

  return (
    <SidePanel
      actions={renderDeadlineActions(model)}
      closeOnInteractOutside
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open={deadline !== undefined}
      resizeLabel={t('facility-operations.common.close')}
      size="md"
      title={deadline?.title ?? ''}
    >
      {deadline !== undefined && (
        <div
          className="facilityoperations:flex facilityoperations:flex-col facilityoperations:gap-4 facilityoperations:py-2"
          data-testid="deadline-panel"
        >
          <div className="facilityoperations:flex facilityoperations:flex-wrap facilityoperations:gap-2">
            <Pill tone={categoryTone[deadline.category]}>{t(`${k}.category.${deadline.category}`)}</Pill>
            <Pill tone={urgencyTone[urgency]}>{t(`${k}.urgency.${urgency}`)}</Pill>
            {event !== undefined && <Pill tone="neutral">{t(`${k}.eventStatus.${status}`)}</Pill>}
            {deadline.source === 'agreements' && deadline.detail === 'DRAFT' && (
              <Pill tone="neutral">{t(`${k}.event.draftContract`)}</Pill>
            )}
          </div>
          {error !== undefined && (
            <StatusText showIcon status="error">
              {error.message}
            </StatusText>
          )}
          {editing && draft !== undefined ? (
            <EventForm draft={draft} setDraft={setDraft} />
          ) : (
            renderDeadlineDetails(model)
          )}
          {deadline.eventId === undefined && (
            <p
              className="facilityoperations:m-0 facilityoperations:rounded-lg facilityoperations:p-3 facilityoperations:text-sm"
              style={{ background: 'var(--color-surface-subtle, #f8fafc)' }}
            >
              {t(`${k}.event.derivedNote`, { source: t(`${k}.sources.${deadline.source}`) })}
            </p>
          )}
          {event !== undefined && !editing && (
            <CommentThread
              subject={{ id: event.id, kind: 'event', label: event.title }}
              title={t(`${k}.event.comments`)}
            />
          )}
        </div>
      )}
    </SidePanel>
  );
};
