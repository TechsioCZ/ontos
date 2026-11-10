import { committedResult, pendingProposalMessage } from '../../../api/action-result.ts';
import { selectItem } from '../../../ui/select-item.ts';
import { ActivityRefSchema } from '../../../../shared/resources/activity.ts';
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { definePageData, modulePagePreload, pageDataPending } from '@app/shared-contracts/page-data';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import type { Types } from 'effect';
import type { ActivityCommand } from '../../../../shared/actions/apply-command.ts';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Table } from '@techsio/ui-kit/organisms/table';
import { Select } from '@techsio/ui-kit/molecules/select';
import { withNativeLabels } from '@app/admin-ui/select-template';
import { DateTime, Effect, Match, Option, Random, Schema } from 'effect';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useBlocker, useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { SaveBar, UnsavedChangesDialog, saveLabelsFor, useDraftSave, useUnsavedChangesGuard } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { constVoid } from 'effect/Function';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { loadCounterpartiesClient, executeCounterpartyRead } from '@app/party-registry/api/client';
import { executeRecords as executeWorkRecords } from '@app/work-tasks/clients/records';
import { executeRecords } from '../../../api/records-consumer.ts';
import { executeApplyCommand } from '../../../api/apply-command-action-client.ts';
import type { Activity, RecordsResponse } from '../../../../shared/apis/records.ts';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { UltramodernRouteHead } from '../../ultramodern-route-head';
import csResource from '../../../../locales/cs/crm-activities.json';
import enResource from '../../../../locales/en/crm-activities.json';
import '../../index.css';

const searchSchema = Schema.Struct({
  resourceId: Schema.optional(ActivityRefSchema.fields.resourceId.check(Schema.isUUID())),
});
const crmActivitiesI18nResources = {
  cs: { 'crm-activities': csResource },
  en: { 'crm-activities': enResource },
} as const;

type FollowUpFields = Types.Mutable<Pick<ActivityCommand, 'followUpTaskRef'>>;
type Counterparties = Effect.Success<ReturnType<typeof loadCounterpartiesClient>>;
type Tasks = Effect.Success<ReturnType<typeof executeWorkRecords>>['items'];
type Card = Effect.Success<ReturnType<typeof executeCounterpartyRead>>;
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
const activities = definePageData({
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
const followUpTasks = definePageData({
  key: (legalEntityId: string) => legalEntityId,
  load: (_legalEntityId: string) => requestId.pipe(Effect.flatMap((id) => executeWorkRecords({}, id))),
  runtime: browserRuntime,
});

export const preloadPage = modulePagePreload((props) =>
  activities.preload({ legalEntityId: props.context?.legalEntityId ?? '', resourceId: resourceIdOf(props.search) }),
);

/** The activity as typed: the contact, the follow-up task and the summary. */
interface ActivityDraft {
  readonly counterpartyId: readonly string[];
  readonly summary: string;
  readonly taskId: readonly string[];
}

const blankActivity: ActivityDraft = { counterpartyId: [], summary: '', taskId: [] };

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
  // The activity as typed: only Uložit sends it.
  const [draft, setDraft] = useState<ActivityDraft>(blankActivity);
  const { counterpartyId, summary, taskId } = draft;
  const setSummary = (next: string) => setDraft((current) => ({ ...current, summary: next }));
  const setCounterpartyId = (next: readonly string[]) => setDraft((current) => ({ ...current, counterpartyId: next }));
  const setTaskId = (next: readonly string[]) => setDraft((current) => ({ ...current, taskId: next }));
  const [query, setQuery] = useState('');
  const [counterparties, setCounterparties] = useState<Counterparties>([]);
  const [card, setCard] = useState<Card>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const retry = () => {
    setMessage('');
    void browserRuntime.runPromise(activities.refresh(input));
  };
  const findCounterparty = () => {
    setPending(true);
    void browserRuntime.runPromise(
      requestId.pipe(
        Effect.flatMap((id) => loadCounterpartiesClient({ query }, id)),
        Effect.match({
          onFailure: (error) => {
            setPending(false);
            setMessage(
              pendingProposalMessage(error) ??
                Match.value(error).pipe(
                  Match.tag('CounterpartiesProviderForbiddenProblem', () => t(`${key}.forbidden`)),
                  Match.orElse(() => t(`${key}.unavailable`)),
                ),
            );
            setCounterparties([]);
          },
          onSuccess: (result) => {
            setCounterparties(result);
            setPending(false);
          },
        }),
      ),
    );
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
              pendingProposalMessage(error) ??
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
  const counterpartyOf = (value: ActivityDraft) =>
    counterparties.find((item) => item.ref.resourceId === value.counterpartyId[0]);
  const send = (value: ActivityDraft): Effect.Effect<SaveOutcome> => {
    const counterparty = counterpartyOf(value);
    if (records === undefined || counterparty === undefined) {
      return Effect.succeed('failed');
    }
    const task = tasks.find((item) => item.ref.resourceId === value.taskId[0]);
    const taskFields: FollowUpFields = {};
    if (task !== undefined) {
      taskFields.followUpTaskRef = task.ref;
    }
    return Effect.all(
      {
        id: requestId,
        referenceCredentials: makeReferenceGatewayCredentials([
          'party-registry',
          ...(taskFields.followUpTaskRef === undefined ? [] : ['work-tasks']),
        ]),
      },
      { concurrency: 1 },
    ).pipe(
      Effect.flatMap(({ id, referenceCredentials }) =>
        executeApplyCommand(
          {
            command: {
              _tag: 'RecordActivity',
              counterpartyRef: counterparty.ref,
              kind: 'CALL',
              occurredAt: DateTime.makeUnsafe('2026-10-05T10:00:00Z'),
              ownerPrincipalRef: records.actorPrincipalRef,
              summary: value.summary,
              ...taskFields,
            },
            expectedRevision: records.revision,
          },
          id,
          { idempotencyKey: id, referenceCredentials },
        ),
      ),
      Effect.flatMap(committedResult),
      Effect.andThen(activities.refresh(input)),
      Effect.match({
        onFailure: (error): SaveOutcome => {
          const proposal = pendingProposalMessage(error);
          setMessage(
            proposal ??
              Match.value(error).pipe(
                Match.tag('ApplyCommandActionForbiddenProblem', () => t(`${key}.forbidden`)),
                Match.orElse(() => t(`${key}.invalid`)),
              ),
          );
          return proposal === undefined ? 'failed' : 'proposed';
        },
        onSuccess: (): SaveOutcome => {
          setMessage(t(`${key}.saved`));
          return 'saved';
        },
      }),
    );
  };
  const record = useDraftSave<ActivityDraft, never>({
    initial: blankActivity,
    isValid: (value) => value.summary.trim() !== '' && counterpartyOf(value) !== undefined,
    runtime: browserRuntime,
    save: send,
    value: draft,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: record,
    navigation: blocker,
    onDiscard: () => {
      setDraft(record.confirmed);
    },
  });
  // A recorded activity keeps the contact and the follow-up for the next one; its summary starts empty.
  const handleSave = () => {
    const sent = draft;
    setMessage('');
    record.save();
    record.afterSave((status) => {
      if (status === 'saved') {
        const next = { ...sent, summary: '' };
        setDraft(next);
        record.adopt(next);
      }
    });
  };
  const partyItems = counterparties.map((item) =>
    selectItem(item.ref.resourceId, item.party.title ?? item.ref.resourceId),
  );
  const taskItems = tasks.map((item) => selectItem(item.ref.resourceId, item.title));
  return {
    card,
    counterpartyId,
    findCounterparty,
    guard,
    handleSave,
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
    setCounterpartyId,
    setQuery,
    setSummary,
    setTaskId,
    showCard,
    summary,
    t,
    taskId,
    taskItems,
  };
};

const RecordsPageContent = ({ input }: { readonly input: ActivitiesInput }) => {
  const {
    card,
    counterpartyId,
    findCounterparty,
    guard,
    handleSave,
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
    setCounterpartyId,
    setQuery,
    setSummary,
    setTaskId,
    showCard,
    summary,
    t,
    taskId,
    taskItems,
  } = useRelationshipsRecords(input);
  return (
    <>
      <UltramodernRouteHead />
      <section
        aria-labelledby="records-heading"
        className="crmactivities:w-full crmactivities:min-w-0 crmactivities:max-w-none crmactivities:p-0 crmactivities:space-y-6 crmactivities:text-(--color-page-fg)"
      >
        <header className="crmactivities:flex crmactivities:flex-wrap crmactivities:items-center crmactivities:justify-between crmactivities:gap-4">
          <div className="crmactivities:space-y-1">
            <h1 className="crmactivities:text-3xl crmactivities:font-semibold" id="records-heading">
              {t(`${key}.title`)}
            </h1>
            <p className="crmactivities:text-sm crmactivities:text-(--color-fg-secondary)">{t(`${key}.intro`)}</p>
          </div>
        </header>
        <output aria-live="polite" className="crmactivities:block crmactivities:text-sm">
          {message}
        </output>
        {loadFailed && (
          <Button disabled={pending} onClick={retry} size="sm" theme="outlined" variant="secondary">
            {t(`${key}.retry`)}
          </Button>
        )}
        {records !== undefined && (
          <>
            <div className="crmactivities:overflow-x-auto">
              <Table size="sm" variant="line">
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
                      <Table.Cell className="crmactivities:whitespace-nowrap crmactivities:text-(--color-fg-secondary)">
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
                          size="sm"
                          variant={Match.value(activity.kind).pipe(
                            Match.when('CALL', () => 'info' as const),
                            Match.when('EMAIL', () => 'warning' as const),
                            Match.when('MEETING', () => 'success' as const),
                            Match.when('NOTE', () => 'outline' as const),
                            Match.exhaustive,
                          )}
                        >
                          {t(`${key}.kinds.${activity.kind}`)}
                        </Badge>
                      </Table.Cell>
                      <Table.Cell className="crmactivities:font-medium">{activity.summary}</Table.Cell>
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
                            disabled={pending}
                            onClick={() => showCard(activity)}
                            size="sm"
                            theme="borderless"
                            variant="secondary"
                          >
                            {t(`${key}.contact`)}
                          </Button>
                        )}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                  {records.items.length === 0 && (
                    <Table.Row>
                      <Table.Cell
                        className="crmactivities:py-8 crmactivities:text-center crmactivities:text-(--color-fg-secondary)"
                        colSpan={5}
                      >
                        {t(`${key}.empty`)}
                      </Table.Cell>
                    </Table.Row>
                  )}
                </Table.Body>
              </Table>
            </div>
            <div className="crmactivities:grid crmactivities:items-start crmactivities:gap-6 crmactivities:lg:grid-cols-2">
              {card !== undefined && (
                <article
                  aria-label={t(`${key}.contact`)}
                  className="ontos-card rounded-lg border border-border-primary/60 bg-base [&_.ontos-card]:border-0 [&_.ontos-card]:bg-transparent [&_.ontos-card]:p-0 crmactivities:min-w-0 crmactivities:space-y-5 crmactivities:p-5"
                >
                  <div className="crmactivities:space-y-1">
                    <p className="crmactivities:text-sm crmactivities:text-(--color-fg-secondary)">
                      {t(`${key}.contact`)}
                    </p>
                    <h2 className="crmactivities:text-xl crmactivities:font-semibold">
                      {card.party.displayName ?? t(`${key}.unnamed`)}
                    </h2>
                  </div>
                  <dl className="ontos-tile rounded-lg bg-surface [&_.ontos-tile]:bg-base crmactivities:grid crmactivities:gap-4 crmactivities:p-4 crmactivities:text-sm">
                    <div className="crmactivities:space-y-1">
                      <dt className="crmactivities:text-(--color-fg-secondary)">{t(`${key}.partyType`)}</dt>
                      <dd>{t(`${key}.partyTypes.${card.party.partyType}`)}</dd>
                    </div>
                    <div className="crmactivities:space-y-2">
                      <dt className="crmactivities:text-(--color-fg-secondary)">{t(`${key}.roles`)}</dt>
                      <dd className="crmactivities:flex crmactivities:flex-wrap crmactivities:gap-2">
                        {card.currentRoles.map((role) => (
                          <Badge key={role.roleType} size="sm" variant="outline">
                            {t(`${key}.roleTypes.${role.roleType}`)}
                          </Badge>
                        ))}
                      </dd>
                    </div>
                  </dl>
                </article>
              )}
              {records.canWrite && (
                <form
                  className={`ontos-card rounded-lg border border-border-primary/60 bg-base [&_.ontos-card]:border-0 [&_.ontos-card]:bg-transparent [&_.ontos-card]:p-0 crmactivities:min-w-0 crmactivities:space-y-5 crmactivities:p-5 ${card === undefined ? 'crmactivities:lg:col-span-2' : ''}`}
                  // Enter never records the activity: only Uložit does.
                  onSubmit={(event) => event.preventDefault()}
                >
                  <h2 className="crmactivities:text-xl crmactivities:font-semibold">{t(`${key}.record`)}</h2>
                  <div className="crmactivities:grid crmactivities:items-start crmactivities:gap-4 crmactivities:md:grid-cols-2">
                    <div className="ontos-tile rounded-lg bg-surface [&_.ontos-tile]:bg-base crmactivities:space-y-4 crmactivities:p-4">
                      <div className="crmactivities:flex crmactivities:flex-wrap crmactivities:items-end crmactivities:gap-3">
                        <div className="crmactivities:min-w-0 crmactivities:flex-1">
                          <FormInput
                            id="counterparty-query"
                            label={t(`${key}.query`)}
                            onChange={(event) => setQuery(event.target.value)}
                            value={query}
                          />
                        </div>
                        <Button
                          disabled={pending || query.trim() === ''}
                          onClick={findCounterparty}
                          size="sm"
                          theme="outlined"
                          type="button"
                          variant="secondary"
                        >
                          {t(`${key}.find`)}
                        </Button>
                      </div>
                      <Select
                        items={withNativeLabels(partyItems)}
                        onValueChange={({ value }) => setCounterpartyId(value)}
                        value={[...counterpartyId]}
                      >
                        <Select.Label>{t(`${key}.contact`)}</Select.Label>
                        <Select.Control>
                          <Select.Trigger>
                            <Select.ValueText placeholder={t(`${key}.choose`)} />
                          </Select.Trigger>
                        </Select.Control>
                        <Select.Positioner>
                          <Select.Content>
                            {partyItems.map((item) => (
                              <Select.Item item={item} key={item.value}>
                                <Select.ItemText>{item.label}</Select.ItemText>
                              </Select.Item>
                            ))}
                          </Select.Content>
                        </Select.Positioner>
                      </Select>
                    </div>
                    <div className="ontos-tile rounded-lg bg-surface [&_.ontos-tile]:bg-base crmactivities:space-y-4 crmactivities:p-4">
                      <Select items={taskItems} onValueChange={({ value }) => setTaskId(value)} value={[...taskId]}>
                        <Select.Label>{t(`${key}.followUp`)}</Select.Label>
                        <Select.Control>
                          <Select.Trigger>
                            <Select.ValueText placeholder={t(`${key}.choose`)} />
                          </Select.Trigger>
                        </Select.Control>
                        <Select.Positioner>
                          <Select.Content>
                            {taskItems.map((item) => (
                              <Select.Item item={item} key={item.value}>
                                <Select.ItemText>{item.label}</Select.ItemText>
                              </Select.Item>
                            ))}
                          </Select.Content>
                        </Select.Positioner>
                      </Select>
                    </div>
                  </div>
                  <FormInput
                    id="activity-summary"
                    label={t(`${key}.summary`)}
                    maxLength={2000}
                    onChange={(event) => setSummary(event.target.value)}
                    required
                    value={summary}
                  />
                  <div className="crmactivities:border-t border-border-primary/60 crmactivities:pt-4">
                    <SaveBar
                      labels={saveLabelsFor(language)}
                      onReloadLatest={constVoid}
                      onSave={handleSave}
                      size="sm"
                      status={record.status}
                    />
                  </div>
                  <UnsavedChangesDialog labels={saveLabelsFor(language)} prompt={guard.prompt} />
                </form>
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
  const location = useRouterState({ select: (state) => state.location.href });
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
