// Detail of one calendar entry. Derived deadlines are read-only here: the date is changed in the source record
// (S13 „Termín se upravuje v původním záznamu“). Own calendar events can be edited, reassigned, completed or
// cancelled, and carry a comment thread (S14). Also the create form. Owned by the ops-agenda lane.
import { DetailList, SaveBar, SidePanel, UnsavedChangesDialog, saveLabelsFor, useDraftSave } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { SelectTemplate as Select } from '@app/admin-ui/select-template';
import { DateTime, Effect, Schema } from 'effect';
import { constVoid } from 'effect/Function';
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
import { useDraftBase } from '../../../../ui/draft-base.ts';
import { useEditGuard } from '../../../../ui/edit-guard.tsx';
import { facilitySaveOutcome } from '../../../../ui/facility-save.ts';

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

const closeKey = 'facility-operations.common.close';
const requiredKey = 'facility-operations.common.required';
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const completeDraft = (draft: Draft) => draft.title.trim() !== '' && datePattern.test(draft.date);

const sameDraft = (left: Draft, right: Draft): boolean =>
  left.assignee === right.assignee &&
  left.date === right.date &&
  left.kind === right.kind &&
  left.location === right.location &&
  left.note === right.note &&
  left.title === right.title;

/**
 * Sends one wire command as the save bar sees it: a command the schema refuses saves nothing and says why, the rest
 * is `facilitySaveOutcome`.
 */
const useSendCommand = () => {
  const { t } = useModernI18n();
  const [error, setError] = useState<PanelFeedback>();
  const refused = (cause: Schema.SchemaError) =>
    Effect.sync((): SaveOutcome => {
      setError({ cause, message: t('facility-operations.common.errors.invalid') });
      return 'failed';
    });
  const answered = (outcome: SaveOutcome) =>
    Effect.sync(() => {
      setError(undefined);
      return outcome;
    });
  const send = (command: WireCommand, run: (command: OpsCommand) => Effect.Effect<CommandOutcome>) =>
    Schema.decodeEffect(OpsCommandSchema)(command).pipe(
      Effect.matchEffect({
        onFailure: refused,
        onSuccess: (decoded) => facilitySaveOutcome(run(decoded)).pipe(Effect.flatMap(answered)),
      }),
    );
  return { error: error?.message, send };
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
  const { language, t } = useModernI18n();
  const [draft, setDraft] = useState(() => emptyDraft(initialDate));
  const locationRef = useLocationRef();
  const people = useAgendaPeople();
  const personOf = (id: string | undefined) => people.find((person) => person.principalId === id);
  const { error, send } = useSendCommand();
  const commandOf = (value: Draft): CreateEventCommand => {
    const related = locationRef(value.location);
    const assignee = personOf(value.assignee === NONE ? undefined : value.assignee);
    const command: { -readonly [Key in keyof CreateEventCommand]: CreateEventCommand[Key] } = {
      _tag: 'AgendaEventCreate',
      date: value.date,
      kind: value.kind,
      title: value.title.trim(),
    };
    if (assignee !== undefined) {
      command.assignee = { principalId: assignee.principalId, tenantId: assignee.tenantId };
      command.assigneeLabel = assignee.displayName;
    }
    if (related !== undefined) {
      command.related = related;
    }
    if (value.note.trim() !== '') {
      command.note = value.note.trim();
    }
    return command;
  };
  // The new event is only on screen until Uložit sends it.
  const record = useDraftSave<Draft, never>({
    equals: sameDraft,
    isValid: completeDraft,
    runtime: browserRuntime,
    save: (value) => send(commandOf(value), onRun),
    value: draft,
  });
  const [previousForm, setPreviousForm] = useState({ initialDate, open });
  if (previousForm.open !== open || previousForm.initialDate !== initialDate) {
    setPreviousForm({ initialDate, open });
    if (open) {
      const empty = emptyDraft(initialDate);
      setDraft(empty);
      record.adopt(empty);
    }
  }
  const guard = useEditGuard(record, () => {
    setDraft(record.confirmed);
  });
  const labels = saveLabelsFor(language);
  const handleSave = () => {
    record.save();
    record.afterSave((status) => {
      if (status === 'saved') {
        onClose();
      }
    });
  };
  return (
    <>
      <SidePanel
        actions={
          <>
            <Button onClick={() => guard.request(onClose)} theme="outlined" variant="secondary">
              {t('facility-operations.common.cancel')}
            </Button>
            <SaveBar
              error={error}
              labels={labels}
              onReloadLatest={constVoid}
              onSave={handleSave}
              status={record.status}
            />
          </>
        }
        description={t(`${k}.create.description`)}
        guard={guard}
        onOpenChange={(next) => {
          if (!next) {
            onClose();
          }
        }}
        open={open}
        resizeLabel={t(closeKey)}
        size="md"
        title={t(`${k}.create.title`)}
      >
        <div className="facilityoperations:flex facilityoperations:flex-col facilityoperations:gap-3 facilityoperations:py-2">
          {record.status === 'invalid' && (
            <StatusText showIcon status="error">
              {t(requiredKey)}
            </StatusText>
          )}
          <EventForm draft={draft} setDraft={setDraft} />
        </div>
      </SidePanel>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};

/**
 * Edit of one own calendar event, against the read it was opened from: a newer change by someone else refuses the
 * save, and "Načíst nejnovější" loads that change. `event` is the live record of the current read.
 */
const EventEditPanel = ({
  event,
  onClose,
  onDone,
  onRun,
  title,
}: {
  readonly event: CalendarEvent;
  readonly onClose: () => void;
  /** Back to the event's detail: after a save, or when the edit is left. */
  readonly onDone: () => void;
  readonly onRun: (command: OpsCommand) => Effect.Effect<CommandOutcome>;
  readonly title: string;
}) => {
  const { language, t } = useModernI18n();
  const [draft, setDraft] = useState<Draft>(() => draftOf(event));
  const locationRef = useLocationRef();
  const people = useAgendaPeople();
  const personOf = (id: string | undefined) => people.find((person) => person.principalId === id);
  const { error, send } = useSendCommand();
  const commandOf = (value: Draft): UpdateEventCommand => {
    const assignee = personOf(value.assignee === NONE ? undefined : value.assignee);
    const related = locationRef(value.location);
    let command: UpdateEventCommand = {
      _tag: 'AgendaEventUpdate',
      date: value.date,
      eventId: event.id,
      kind: value.kind,
      note: value.note.trim(),
      title: value.title.trim(),
    };
    if (value.assignee === NONE) {
      command = { ...command, assignee: null };
    } else if (assignee !== undefined) {
      command = {
        ...command,
        assignee: { principalId: assignee.principalId, tenantId: assignee.tenantId },
        assigneeLabel: assignee.displayName,
      };
    }
    if (value.location === NONE) {
      command = { ...command, related: null };
    } else if (related !== undefined) {
      command = { ...command, related };
    }
    return command;
  };
  // Saves carry the revision of the read the draft was built on, so someone else's newer change refuses them.
  const base = useDraftBase(event, onRun);
  const record = useDraftSave<Draft, never>({
    equals: sameDraft,
    isValid: completeDraft,
    runtime: browserRuntime,
    save: (value) => base.confirm(send(commandOf(value), base.run)),
    value: draft,
  });
  base.sync({
    onAdopt: () => {
      const stored = draftOf(event);
      if (!sameDraft(stored, draft)) {
        record.adopt(stored);
        setDraft(stored);
      }
    },
    settled: !record.pending && sameDraft(draft, record.confirmed),
  });
  const guard = useEditGuard(record, () => {
    setDraft(record.confirmed);
  });
  const labels = saveLabelsFor(language);
  const handleSave = () => {
    record.save();
    record.afterSave((status) => {
      if (status === 'saved') {
        onDone();
      }
    });
  };
  const handleReloadLatest = () => {
    const current = draftOf(event);
    base.rebase();
    record.adopt(current);
    setDraft(current);
  };
  return (
    <>
      <SidePanel
        actions={
          <>
            <Button onClick={() => guard.request(onDone)} theme="outlined" variant="secondary">
              {t('facility-operations.common.cancel')}
            </Button>
            <SaveBar
              error={error}
              labels={labels}
              onReloadLatest={handleReloadLatest}
              onSave={handleSave}
              status={record.status}
            />
          </>
        }
        guard={guard}
        onOpenChange={(next) => {
          if (!next) {
            onClose();
          }
        }}
        open
        resizeLabel={t(closeKey)}
        size="md"
        title={title}
      >
        <div className="facilityoperations:flex facilityoperations:flex-col facilityoperations:gap-4 facilityoperations:py-2">
          {record.status === 'invalid' && (
            <StatusText showIcon status="error">
              {t(requiredKey)}
            </StatusText>
          )}
          <EventForm draft={draft} setDraft={setDraft} />
        </div>
      </SidePanel>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PanelFeedback>();
  const people = useAgendaPeople();
  const personOf = (id: string | undefined) => people.find((person) => person.principalId === id);
  // Another entry starts over; a newer read of the same event keeps an edit and its draft open.
  const [previousKey, setPreviousKey] = useState(deadline?.key);
  if (previousKey !== deadline?.key) {
    setPreviousKey(deadline?.key);
    setEditing(false);
    setError(undefined);
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

  const status = event?.status ?? 'PLANNED';
  const urgency = deadline === undefined ? 'later' : urgencyOf(deadline, today);
  const owner = personOf(deadline?.ownerPrincipalId);

  return {
    busy,
    canWrite,
    deadline,
    editing,
    error,
    event,
    lang,
    onClose,
    owner,
    personOf,
    run,
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
  event,
  lang,
  run,
  setEditing,
  status,
  t,
}: ReturnType<typeof useDeadlinePanel>) => {
  if (event !== undefined && canWrite) {
    return (
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
  const { deadline, editing, error, event, onClose, setEditing, status, t, urgency } = model;
  if (editing && event !== undefined && deadline !== undefined && model.canWrite) {
    return (
      <EventEditPanel
        event={event}
        key={event.id}
        onClose={onClose}
        onDone={() => setEditing(false)}
        onRun={props.onRun}
        title={deadline.title}
      />
    );
  }

  return (
    <SidePanel
      actions={renderDeadlineActions(model)}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open={deadline !== undefined}
      resizeLabel={t(closeKey)}
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
          {renderDeadlineDetails(model)}
          {deadline.eventId === undefined && (
            <p
              className="facilityoperations:m-0 facilityoperations:rounded-lg facilityoperations:p-3 facilityoperations:text-sm"
              style={{ background: 'var(--color-surface-subtle, #f8fafc)' }}
            >
              {t(`${k}.event.derivedNote`, { source: t(`${k}.sources.${deadline.source}`) })}
            </p>
          )}
          {event !== undefined && (
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
