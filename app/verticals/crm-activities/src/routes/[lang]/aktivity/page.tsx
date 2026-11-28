import { committedResult } from '../../../api/action-result.ts';
import type { ActionProposalAccepted } from '@app/core-runtime/http/action-proposal';
import { ActivityRefSchema } from '../../../../shared/resources/activity.ts';
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { definePageData, modulePagePreload, pageDataPending } from '@app/shared-contracts/page-data';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import type { Types } from 'effect';
import { ActivityCommandSchema } from '../../../../shared/actions/apply-command.ts';
import type { ActivityCommand, ApplyCommandPayload } from '../../../../shared/actions/apply-command.ts';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Table } from '@techsio/ui-kit/organisms/table';
import {
  ChoiceField,
  ClearableChoiceField,
  FormReact,
  FormRoot,
  TextField,
  fromPayload,
  useAtomSet,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { DateTime, Effect, Match, Option, Predicate, Random, Schema, Struct } from 'effect';
import { Atom } from 'effect/reactivity';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useBlocker, useRouterState } from '@modern-js/plugin-tanstack/runtime';
import {
  SaveBar,
  UnsavedChangesDialog,
  requiredLabelFor,
  saveLabelsFor,
  useDraftSave,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { constVoid } from 'effect/Function';
import { browserAtomRuntime, browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { loadCounterpartiesClient, executeCounterpartyRead } from '@app/party-registry/api/client';
import { executeRecords as executeWorkRecords } from '@app/work-tasks/clients/records';
import { executeRecords } from '../../../api/records-consumer.ts';
import { executeApplyCommand } from '../../../api/apply-command-action-client.ts';
import type { Activity, RecordsResponse } from '../../../../shared/apis/records.ts';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { UltramodernRouteHead } from '../../ultramodern-route-head';
import csResource from '../../../../locales/cs/crm-activities.json';
import enResource from '../../../../locales/en/crm-activities.json';

const searchSchema = Schema.Struct({
  resourceId: Schema.optional(ActivityRefSchema.fields.resourceId.check(Schema.isUUID())),
});
const crmActivitiesI18nResources = {
  cs: { 'crm-activities': csResource },
  en: { 'crm-activities': enResource },
} as const;

type FollowUpFields = Types.Mutable<Pick<ActivityCommand, 'followUpTaskRef'>>;
type Counterparties = Effect.Success<ReturnType<typeof loadCounterpartiesClient>>;
type Counterparty = Counterparties[number];
type Tasks = Effect.Success<ReturnType<typeof executeWorkRecords>>['items'];
type Card = Effect.Success<ReturnType<typeof executeCounterpartyRead>>;
type SearchError = Effect.Error<ReturnType<typeof loadCounterpartiesClient>>;
type ApplyFailure = Effect.Error<ReturnType<typeof executeApplyCommand>>;
/** Governed records reads (activities and Work Tasks) share the generated read problems. */
type LoadError = Effect.Error<ReturnType<typeof executeRecords>>;

/** The activity list a page shows: the person's legal entity and the optional `resourceId` from the query. */
interface ActivitiesInput {
  readonly legalEntityId: string;
  readonly resourceId: string | undefined;
}

const requestId = Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }).pipe(
  Effect.map(([first, second]) => `crm-activities:${first}:${second}`),
);

/** Decodes a raw query string (`?resourceId=…`, the shape the Shell passes as `search`). */
const searchCodec = Schema.toCodecJson(Schema.fromURLSearchParams(searchSchema));

const resourceIdOf = (search: string): string | undefined =>
  Option.getOrUndefined(Schema.decodeOption(searchCodec)(search))?.resourceId;

/** The page's primary data: loaded before the Shell reveals the page, kept per document, revalidated after writes. */
export const activities = definePageData({
  changesFrom: ['crm-activities'],
  key: (input: ActivitiesInput) => `${input.legalEntityId}|${input.resourceId ?? ''}`,
  load: (input: ActivitiesInput) =>
    requestId.pipe(
      Effect.flatMap((id) =>
        executeRecords(input.resourceId === undefined ? {} : { resourceId: input.resourceId }, id),
      ),
    ),
  runtime: browserRuntime,
});

/** Tasks an activity can follow up: loaded once the record form is shown, revalidated after writes. */
export const followUpTasks = definePageData({
  changesFrom: ['crm-activities', 'work-tasks'],
  key: (legalEntityId: string) => legalEntityId,
  load: (_legalEntityId: string) => requestId.pipe(Effect.flatMap((id) => executeWorkRecords({}, id))),
  runtime: browserRuntime,
});

export const preloadPage = modulePagePreload((props) =>
  activities.preload({ legalEntityId: props.context?.legalEntityId ?? '', resourceId: resourceIdOf(props.search) }),
);

type CounterpartyRef = Counterparty['ref'];

/**
 * The activity as typed: the chosen contact's reference, the follow-up task and the summary. The draft holds what the
 * command sends and nothing the directory describes, so no version of it keeps a contact's name or roles. A later
 * search only offers other contacts: the contact stays chosen until the user picks another one, clears it, or the
 * contact directory refuses the user.
 */
interface ActivityDraft {
  readonly counterpartyRef: CounterpartyRef | null;
  readonly summary: string;
  readonly taskId: readonly string[];
}

const blankActivity: ActivityDraft = { counterpartyRef: null, summary: '', taskId: [] };

/** Two drafts are the same when they would record the same activity. */
const sameActivity = (left: ActivityDraft, right: ActivityDraft) =>
  left.summary === right.summary &&
  left.counterpartyRef?.resourceId === right.counterpartyRef?.resourceId &&
  left.taskId.join(',') === right.taskId.join(',');

const withoutContact = (draft: ActivityDraft): ActivityDraft => ({ ...draft, counterpartyRef: null });

/**
 * The activity form: the summary and its checks come from the RecordActivity command; the contact search, the chosen
 * contact (by id, `""` for none) and the follow-up task (`""` for none) are the form's own. Uložit records the
 * activity through the draft save below; the form never submits it, so Enter records nothing.
 */
const activityForm = FormReact.make(
  fromPayload(ActivityCommandSchema.mapFields(Struct.pick(['summary'])))
    .addField('counterpartyId', Schema.String)
    .addField('query', Schema.String)
    .addField('taskId', Schema.String),
  {
    fields: { counterpartyId: ClearableChoiceField, query: TextField, summary: TextField, taskId: ChoiceField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

type ActivityValues = typeof activityForm.schema.Encoded;

/** The empty form: what the page opens with. */
const blankValues: ActivityValues = { counterpartyId: '', query: '', summary: '', taskId: '' };

const counterpartyField = activityForm.getFieldAtoms(activityForm.fields.counterpartyId);
const summaryField = activityForm.getFieldAtoms(activityForm.fields.summary);

/**
 * The chosen contact's id as a plain string. It changes only when the choice does: the field's own value atom reports
 * every change of the form.
 */
const chosenContactId = counterpartyField.value.pipe(Atom.map(Option.getOrElse(() => '')));

/**
 * The one request this form sent whose outcome is still unknown: no answer came, or one that cannot say whether the
 * owner recorded it (a transport failure, 5xx, a commit the owner has not resolved). A retry of the same activity
 * sends exactly this request again, with its command, expected revision and idempotency key, whatever the list has
 * been refreshed to since, so the owner records it once and answers a retry with what it answered the first time. A
 * definite answer ends it, and the next send is a new request with a new key over the current revision.
 */
interface UnresolvedRequest {
  readonly activity: ActivityDraft;
  readonly idempotencyKey: string;
  readonly payload: ApplyCommandPayload;
}

const noUnresolvedRequest = Option.none<UnresolvedRequest>();

/**
 * The owner refused the request for certain (400, 403, 409, 422): it recorded nothing, and it answers the same key with
 * the same refusal, so sending the activity again is a new request.
 */
const refusedForCertain = (error: ApplyFailure | ActionProposalAccepted) =>
  [
    'ApplyCommandActionInvalidProblem',
    'ApplyCommandActionForbiddenProblem',
    'ApplyCommandActionConflictProblem',
    'ApplyCommandActionIneligibleProblem',
  ].some((tag) => Predicate.isTagged(error, tag));

/** The activity after the recorded one: same contact and follow-up, an empty summary. */
const nextActivity = (draft: ActivityDraft): ActivityDraft => ({ ...draft, summary: '' });

/**
 * The lookup was refused rather than unavailable: the login expired (401), or the Shell's gateway or the contact
 * directory denied the person (403). Only a transport or availability failure keeps the chosen contact.
 */
const refusedLookup = (error: SearchError) =>
  Predicate.hasProperty(error, 'status') && (error.status === 401 || error.status === 403);

/** How the picker and its clear action name a contact. */
const contactName = (contact: Counterparty) => contact.party.title ?? contact.ref.resourceId;

const useRelationshipsRecords = (input: ActivitiesInput) => {
  const { language, t } = useModernI18n();
  const key = 'crm-activities.pages.records';
  const snapshot = useSyncExternalStore(
    activities.subscribe,
    () => activities.snapshot(input),
    () => pageDataPending,
  );
  const { legalEntityId, resourceId } = input;
  useEffect(() => activities.ensure({ legalEntityId, resourceId }), [legalEntityId, resourceId]);
  const records: RecordsResponse | undefined = snapshot.state === 'ready' ? snapshot.value : undefined;
  const refreshing = snapshot.state !== 'pending' && snapshot.refreshing;
  const canWrite = records?.canWrite === true;
  const tasksSnapshot = useSyncExternalStore(
    followUpTasks.subscribe,
    () => followUpTasks.snapshot(legalEntityId),
    () => pageDataPending,
  );
  useEffect(() => {
    if (canWrite) {
      followUpTasks.ensure(legalEntityId);
    }
  }, [canWrite, legalEntityId]);
  const tasks: Tasks = tasksSnapshot.state === 'ready' ? tasksSnapshot.value.items : [];
  const failureText = (error: LoadError) =>
    Match.value(error).pipe(
      Match.tag('RecordsForbiddenProblem', () => t(`${key}.forbidden`)),
      Match.orElse(() => t(`${key}.unavailable`)),
    );
  const loadFailure = snapshot.state === 'failed' ? failureText(snapshot.error) : '';
  const tasksFailure = canWrite && tasksSnapshot.state === 'failed' ? failureText(tasksSnapshot.error) : '';
  // The activity as typed lives in the form: only Uložit sends it.
  const values = Option.getOrElse(useAtomValue(activityForm.values), () => blankValues);
  const { query } = values;
  const setCounterpartyId = useAtomSet(counterpartyField.setValue);
  const setSummary = useAtomSet(summaryField.setValue);
  /** The latest search's hits: what the picker offers besides the chosen contact. */
  const [counterparties, setCounterparties] = useState<Counterparties>([]);
  /** The chosen contact as the directory last described it: the one contact the form keeps beyond the latest hits. */
  const [contact, setContact] = useState<Counterparty | null>(null);
  const chosenId = useAtomValue(chosenContactId);
  // The chosen contact as the latest search describes it, else as the form kept it: a newer name replaces the kept one,
  // and a search that omits the contact keeps it chosen and labelled.
  const described =
    counterparties.find((item) => item.ref.resourceId === chosenId) ??
    (contact !== null && contact.ref.resourceId === chosenId ? contact : null);
  if (described !== contact) {
    setContact(described);
  }
  const chosen = described;
  // The picker's items are its complete collection: the latest search's hits plus the chosen contact they omit.
  const contactChoices =
    chosen === null || counterparties.some((item) => item.ref.resourceId === chosen.ref.resourceId)
      ? counterparties
      : [chosen, ...counterparties];
  /** The activity the form would record: the chosen contact's reference, the follow-up task and the summary. */
  const draft: ActivityDraft = {
    counterpartyRef: chosen?.ref ?? null,
    summary: values.summary,
    taskId: values.taskId === '' ? [] : [values.taskId],
  };
  const [card, setCard] = useState<Card>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  /** Why the last contact search found nothing to offer; it shows next to the picker. */
  const [searchFailure, setSearchFailure] = useState('');
  const retry = () => {
    setMessage('');
    void browserRuntime.runPromise(activities.refresh(input));
  };
  const showCard = (activity: Activity) => {
    if (activity.counterpartyRef === undefined) {
      return;
    }
    const { counterpartyRef } = activity;
    setPending(true);
    setCard(undefined);
    void browserRuntime.runPromise(
      requestId.pipe(
        Effect.flatMap((id) => executeCounterpartyRead({ counterpartyRef }, id)),
        Effect.match({
          onFailure: (error) => {
            setPending(false);
            setMessage(
              Match.value(error).pipe(
                Match.tag('CounterpartyReadForbiddenProblem', () => t(`${key}.forbidden`)),
                Match.orElse(() => t(`${key}.unavailable`)),
              ),
            );
          },
          onSuccess: (result) => {
            setCard(result);
            setPending(false);
          },
        }),
      ),
    );
  };
  /** The request whose outcome is still unknown, if one is. */
  const unresolved = useRef(noUnresolvedRequest);
  /** The unresolved request again for the same activity, otherwise a new one over the current revision. */
  const requestFor = (value: ActivityDraft, counterpartyRef: CounterpartyRef, current: RecordsResponse) =>
    Option.match(unresolved.current.pipe(Option.filter((request) => sameActivity(request.activity, value))), {
      onNone: () => {
        const task = tasks.find((item) => item.ref.resourceId === value.taskId[0]);
        const taskFields: FollowUpFields = {};
        if (task !== undefined) {
          taskFields.followUpTaskRef = task.ref;
        }
        return requestId.pipe(
          Effect.map((idempotencyKey): UnresolvedRequest => ({
            activity: value,
            idempotencyKey,
            payload: {
              command: {
                _tag: 'RecordActivity',
                counterpartyRef,
                kind: 'CALL',
                occurredAt: DateTime.makeUnsafe('2026-10-05T10:00:00Z'),
                ownerPrincipalRef: current.actorPrincipalRef,
                summary: value.summary,
                ...taskFields,
              },
              expectedRevision: current.revision,
            },
          })),
        );
      },
      onSome: Effect.succeed,
    });
  const send = (value: ActivityDraft): Effect.Effect<SaveOutcome> => {
    const { counterpartyRef } = value;
    if (records === undefined || counterpartyRef === null) {
      return Effect.succeed('failed');
    }
    return requestFor(value, counterpartyRef, records).pipe(
      Effect.tap((request) =>
        Effect.sync(() => {
          unresolved.current = Option.some(request);
        }),
      ),
      Effect.flatMap(({ idempotencyKey, payload }) =>
        Effect.all(
          {
            id: requestId,
            referenceCredentials: makeReferenceGatewayCredentials([
              'party-registry',
              ...(payload.command.followUpTaskRef === undefined ? [] : ['work-tasks']),
            ]),
          },
          { concurrency: 1 },
        ).pipe(
          Effect.flatMap(({ id, referenceCredentials }) =>
            executeApplyCommand(payload, id, { idempotencyKey, referenceCredentials }),
          ),
        ),
      ),
      Effect.flatMap(committedResult),
      // The owner recorded this very request earlier and no longer keeps its reply: the activity is recorded.
      Effect.catchTag('ApplyCommandActionAlreadyCommittedProblem', () => Effect.void),
      Effect.andThen(activities.refresh(input)),
      Effect.match({
        onFailure: (error): SaveOutcome => {
          if (refusedForCertain(error)) {
            unresolved.current = Option.none();
          }
          setMessage(
            Match.value(error).pipe(
              Match.tag('ApplyCommandActionForbiddenProblem', () => t(`${key}.forbidden`)),
              Match.orElse(() => t(`${key}.invalid`)),
            ),
          );
          return 'failed';
        },
        onSuccess: (): SaveOutcome => {
          unresolved.current = Option.none();
          setMessage(t(`${key}.saved`));
          return 'saved';
        },
      }),
    );
  };
  const record = useDraftSave<ActivityDraft, never>({
    equals: sameActivity,
    initial: blankActivity,
    isValid: (value) => value.summary.trim() !== '' && value.counterpartyRef !== null,
    runtime: browserRuntime,
    save: send,
    value: draft,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  // Uložit in the save bar and in the leave question. Once an activity is recorded, the form starts the next one from
  // it: same contact and follow-up, an empty summary, a new draft. An edit made while the save ran keeps the form on
  // the recorded activity ("dirty", not "saved"), so the same activity is not sent again.
  const save = () => {
    setMessage('');
    record.save();
    record.afterSave((status, confirmed) => {
      if (status === 'saved') {
        // The form shows the recorded activity, so only its summary empties.
        setSummary('');
        record.adopt(nextActivity(confirmed));
      }
    });
  };
  const guard = useUnsavedChangesGuard({
    draft: { ...record, save },
    navigation: blocker,
    // "Zahodit změny" puts nothing back: the person leaves, and the page that stays starts its form over (RecordsPage),
    // so the form shows what the person typed until it is gone.
    onDiscard: constVoid,
  });
  /**
   * The directory refused the user: nothing it returned stays chosen, on offer, on screen as an opened contact card, in
   * the saved version that decides whether leaving asks, or in what a running save confirms. A request whose outcome is
   * unknown keeps only the contact's reference, so a retry once the contact is back is still the same request.
   */
  const refuseContacts = (error: SearchError) => {
    setSearchFailure('');
    setContact(null);
    setCard(undefined);
    setCounterpartyId('');
    record.revise(withoutContact);
    setMessage(
      Predicate.hasProperty(error, 'status') && error.status === 401 ? t(`${key}.signedOut`) : t(`${key}.forbidden`),
    );
  };
  const searchFailed = (error: SearchError) => {
    setPending(false);
    // No earlier hit stays on offer after a failed search.
    setCounterparties([]);
    if (refusedLookup(error)) {
      refuseContacts(error);
    } else {
      // The lookup failed for now: the chosen contact stays chosen and the form says the search did not run.
      setSearchFailure(t(`${key}.searchUnavailable`));
    }
  };
  const searchFound = (result: Counterparties) => {
    // A newer answer about the chosen contact replaces the kept one as the page renders it.
    setCounterparties(result);
    setSearchFailure('');
    setPending(false);
  };
  // Find stays disabled while a search runs, so every answer is the answer to the only search outstanding.
  const findCounterparty = () => {
    setPending(true);
    void browserRuntime.runPromise(
      requestId.pipe(
        Effect.flatMap((id) => loadCounterpartiesClient({ query }, id)),
        Effect.match({ onFailure: searchFailed, onSuccess: searchFound }),
      ),
    );
  };
  const partyItems = contactChoices.map((item) => ({ label: contactName(item), value: item.ref.resourceId }));
  const taskItems = tasks.map((item) => ({ label: item.title, value: item.ref.resourceId }));
  return {
    card,
    clearContactLabel: t(`${key}.clearContact`, { name: chosen === null ? '' : contactName(chosen) }),
    findCounterparty,
    guard,
    key,
    language,
    loadFailed: snapshot.state === 'failed',
    message: [message, loadFailure, tasksFailure].find((text) => text !== '') ?? '',
    partyItems,
    pending: pending || refreshing,
    query,
    record,
    records,
    retry,
    save,
    searchFailure,
    showCard,
    t,
    taskItems,
  };
};

const RecordsPageContent = ({ input }: { readonly input: ActivitiesInput }) => {
  const {
    card,
    clearContactLabel,
    findCounterparty,
    guard,
    key,
    language,
    loadFailed,
    message,
    partyItems,
    pending,
    query,
    record,
    records,
    retry,
    save,
    searchFailure,
    showCard,
    t,
    taskItems,
  } = useRelationshipsRecords(input);
  return (
    <>
      <UltramodernRouteHead />
      <section aria-labelledby="records-heading" className="w-full min-w-0 max-w-none p-0 space-y-6 text-fg-primary">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold" id="records-heading">
              {t(`${key}.title`)}
            </h1>
            <p className="text-sm text-fg-secondary">{t(`${key}.intro`)}</p>
          </div>
        </header>
        <output aria-live="polite" className="block text-sm">
          {message}
        </output>
        {loadFailed && (
          <Button appearance="outline" disabled={pending} onClick={retry} severity="secondary" size="sm">
            {t(`${key}.retry`)}
          </Button>
        )}
        {records !== undefined && (
          <>
            <div className="overflow-x-auto">
              <Table appearance="line" size="sm">
                <Table.Caption>{t(`${key}.timeline`)}</Table.Caption>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>{t(`${key}.occurredAt`)}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t(`${key}.kind`)}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t(`${key}.summary`)}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t(`${key}.followUp`)}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t(`${key}.contact`)}</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {records.items.map((activity) => (
                    <Table.Row key={activity.ref.resourceId}>
                      <Table.Cell className="whitespace-nowrap text-fg-secondary">
                        <time dateTime={DateTime.formatIso(activity.occurredAt)}>
                          {DateTime.format(activity.occurredAt, {
                            day: '2-digit',
                            hour: '2-digit',
                            locale: language,
                            minute: '2-digit',
                            month: '2-digit',
                            timeZone: 'Europe/Prague',
                            year: 'numeric',
                          })}
                        </time>
                      </Table.Cell>
                      <Table.Cell>
                        <Badge
                          severity={Match.value(activity.kind).pipe(
                            Match.when('CALL', () => 'info' as const),
                            Match.when('EMAIL', () => 'warning' as const),
                            Match.when('MEETING', () => 'success' as const),
                            Match.when('NOTE', () => 'neutral' as const),
                            Match.exhaustive,
                          )}
                          size="sm"
                        >
                          {t(`${key}.kinds.${activity.kind}`)}
                        </Badge>
                      </Table.Cell>
                      <Table.Cell className="font-medium">{activity.summary}</Table.Cell>
                      <Table.Cell>
                        {activity.followUpTaskRef === undefined ? (
                          '—'
                        ) : (
                          <Link
                            href={`/${language ?? 'cs'}/ukoly?resourceId=${encodeURIComponent(activity.followUpTaskRef.resourceId)}`}
                          >
                            {t(`${key}.followUp`)}
                          </Link>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        {activity.counterpartyRef !== undefined && (
                          <Button
                            appearance="ghost"
                            disabled={pending}
                            onClick={() => showCard(activity)}
                            severity="secondary"
                            size="sm"
                          >
                            {t(`${key}.contact`)}
                          </Button>
                        )}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                  {records.items.length === 0 && (
                    <Table.Row>
                      <Table.Cell className="py-8 text-center text-fg-secondary" colSpan={5}>
                        {t(`${key}.empty`)}
                      </Table.Cell>
                    </Table.Row>
                  )}
                </Table.Body>
              </Table>
            </div>
            <div className="grid items-start gap-6 lg:grid-cols-2">
              {card !== undefined && (
                <article aria-label={t(`${key}.contact`)} className="surface-card min-w-0 space-y-5 p-5">
                  <div className="space-y-1">
                    <p className="text-sm text-fg-secondary">{t(`${key}.contact`)}</p>
                    <h2 className="text-xl font-semibold">{card.party.displayName ?? t(`${key}.unnamed`)}</h2>
                  </div>
                  <dl className="surface-tile grid gap-4 p-4 text-sm">
                    <div className="space-y-1">
                      <dt className="text-fg-secondary">{t(`${key}.partyType`)}</dt>
                      <dd>{t(`${key}.partyTypes.${card.party.partyType}`)}</dd>
                    </div>
                    <div className="space-y-2">
                      <dt className="text-fg-secondary">{t(`${key}.roles`)}</dt>
                      <dd className="flex flex-wrap gap-2">
                        {card.currentRoles.map((role) => (
                          <Badge appearance="outline" key={role.roleType} severity="neutral" size="sm">
                            {t(`${key}.roleTypes.${role.roleType}`)}
                          </Badge>
                        ))}
                      </dd>
                    </div>
                  </dl>
                </article>
              )}
              {records.canWrite && (
                <FormRoot
                  className={`surface-card min-w-0 space-y-5 p-5 ${card === undefined ? 'lg:col-span-2' : ''}`}
                  defaultValues={blankValues}
                  form={activityForm}
                  translateMessage={(text) => t(text, { defaultValue: text })}
                >
                  <h2 className="text-xl font-semibold">{t(`${key}.record`)}</h2>
                  <div className="grid items-start gap-4 md:grid-cols-2">
                    <div className="surface-tile space-y-4 p-4">
                      <div className="flex flex-wrap items-end gap-3">
                        <div className="min-w-0 flex-1">
                          <activityForm.query id="counterparty-query" label={t(`${key}.query`)} />
                        </div>
                        <Button
                          appearance="outline"
                          disabled={pending || query.trim() === ''}
                          onClick={findCounterparty}
                          severity="secondary"
                          size="sm"
                          type="button"
                        >
                          {t(`${key}.find`)}
                        </Button>
                      </div>
                      <activityForm.counterpartyId
                        clearLabel={() => clearContactLabel}
                        items={partyItems}
                        label={t(`${key}.contact`)}
                        placeholder={t(`${key}.choose`)}
                        warning={searchFailure}
                      />
                    </div>
                    <div className="surface-tile space-y-4 p-4">
                      <activityForm.taskId
                        items={taskItems}
                        label={t(`${key}.followUp`)}
                        placeholder={t(`${key}.choose`)}
                      />
                    </div>
                  </div>
                  <activityForm.summary
                    id="activity-summary"
                    label={t(`${key}.summary`)}
                    maxLength={2000}
                    required
                    requiredLabel={requiredLabelFor(language)}
                  />
                  <div className="border-t border-border-primary/60 pt-4">
                    <SaveBar
                      labels={saveLabelsFor(language)}
                      onReloadLatest={constVoid}
                      onSave={save}
                      size="sm"
                      status={record.status}
                    />
                  </div>
                  <UnsavedChangesDialog labels={saveLabelsFor(language)} prompt={guard.prompt} />
                </FormRoot>
              )}
            </div>
          </>
        )}
      </section>
    </>
  );
};

/** Rendered by the Shell with the props its `preloadPage` received; standalone it reads the query from the router. */
export const RecordsPage = (props: Partial<ModulePageProps>) => {
  // The form starts over once the router has arrived at another location of this page. The location a navigation is
  // still heading to does not count: when it leaves the page, the page would otherwise show a fresh form before it goes.
  const location = useRouterState({ select: (state) => (state.resolvedLocation ?? state.location).href });
  const routerSearch = useRouterState({ select: (state) => state.location.searchStr });
  const input = {
    legalEntityId: props.context?.legalEntityId ?? '',
    resourceId: resourceIdOf(props.search ?? routerSearch),
  };
  return (
    <FederatedI18nBoundary
      defaultNamespace="crm-activities"
      fallbackLanguage="en"
      resources={crmActivitiesI18nResources}
      supportedLanguages={['en', 'cs']}
    >
      <RecordsPageContent input={input} key={location} />
    </FederatedI18nBoundary>
  );
};

export default RecordsPage;
