import { ActivityRefSchema } from '../../../../../shared/resources/activity.ts';
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import type { Types } from 'effect';
import type { ActivityCommand } from '../../../../../shared/actions/apply-command.ts';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Table } from '@techsio/ui-kit/organisms/table';
import { Select } from '@techsio/ui-kit/molecules/select';
import { DateTime, Effect, Match, Option, Random, Schema } from 'effect';
import { useState } from 'react';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { loadCounterpartiesClient, executeCounterpartyRead } from '@app/party-registry/api/client';
import { executeRecords as executeWorkRecords } from '@app/siampark-work/clients/records';
import { executeRecords } from '../../../../api/records-client.ts';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import type { Activity, RecordsResponse } from '../../../../../shared/apis/records.ts';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import csResource from '../../../../../locales/cs/siampark-relationships.json';
import enResource from '../../../../../locales/en/siampark-relationships.json';
import '../../../index.css';

const searchSchema = Schema.Struct({
  resourceId: Schema.optional(ActivityRefSchema.fields.resourceId.check(Schema.isUUID())),
});
const siamparkRelationshipsI18nResources = {
  cs: { 'siampark-relationships': csResource },
  en: { 'siampark-relationships': enResource },
} as const;

type FollowUpFields = Types.Mutable<Pick<ActivityCommand, 'followUpTaskRef'>>;
type Counterparties = Effect.Success<ReturnType<typeof loadCounterpartiesClient>>;
type Tasks = Effect.Success<ReturnType<typeof executeWorkRecords>>['items'];
type Card = Effect.Success<ReturnType<typeof executeCounterpartyRead>>;
const useRelationshipsRecords = () => {
  const { language, t } = useModernI18n();
  const search = Schema.decodeUnknownOption(searchSchema)(useRouterState().location.search);
  const resourceId = Option.getOrUndefined(search)?.resourceId;
  const key = 'siampark-relationships.pages.records';
  const [records, setRecords] = useState<RecordsResponse>();
  const [summary, setSummary] = useState('');
  const [query, setQuery] = useState('');
  const [counterparties, setCounterparties] = useState<Counterparties>([]);
  const [tasks, setTasks] = useState<Tasks>([]);
  const [counterpartyId, setCounterpartyId] = useState<string[]>([]);
  const [taskId, setTaskId] = useState<string[]>([]);
  const [card, setCard] = useState<Card>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const requestId = Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }).pipe(
    Effect.map(([first, second]) => `siampark-relationships:${first}:${second}`),
  );
  const refresh = () => {
    setPending(true);
    void browserRuntime.runPromise(
      requestId.pipe(
        Effect.flatMap((id) => executeRecords(resourceId === undefined ? {} : { resourceId }, id)),
        Effect.match({
          onFailure: (error) => {
            setRecords(undefined);
            setCard(undefined);
            setCounterparties([]);
            setTasks([]);
            setCounterpartyId([]);
            setTaskId([]);
            setPending(false);
            setMessage(
              Match.value(error).pipe(
                Match.tag('RecordsForbiddenProblem', () => t(`${key}.forbidden`)),
                Match.orElse(() => t(`${key}.unavailable`)),
              ),
            );
          },
          onSuccess: (result) => {
            setRecords(result);
            setPending(false);
            setMessage('');
          },
        }),
      ),
    );
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
  const loadTasks = () => {
    setPending(true);
    void browserRuntime.runPromise(
      requestId.pipe(
        Effect.flatMap((id) => executeWorkRecords({}, id)),
        Effect.match({
          onFailure: (error) => {
            setTasks([]);
            setTaskId([]);
            setPending(false);
            setMessage(
              Match.value(error).pipe(
                Match.tag('RecordsForbiddenProblem', () => t(`${key}.forbidden`)),
                Match.orElse(() => t(`${key}.unavailable`)),
              ),
            );
          },
          onSuccess: (result) => {
            setTasks(result.items);
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
  const save = () => {
    if (records === undefined) {
      return;
    }
    const counterparty = counterparties.find((item) => item.ref.resourceId === counterpartyId[0]);
    const task = tasks.find((item) => item.ref.resourceId === taskId[0]);
    if (counterparty === undefined) {
      return;
    }
    setPending(true);
    const taskFields: FollowUpFields = {};
    if (task !== undefined) {
      taskFields.followUpTaskRef = task.ref;
    }
    void browserRuntime.runPromise(
      Effect.all(
        {
          id: requestId,
          referenceCredentials: makeReferenceGatewayCredentials([
            'party-registry',
            ...(taskFields.followUpTaskRef === undefined ? [] : ['siampark-work']),
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
                summary,
                ...taskFields,
              },
              expectedRevision: records.revision,
            },
            id,
            { idempotencyKey: id, referenceCredentials },
          ),
        ),
        Effect.flatMap(() => requestId.pipe(Effect.flatMap((id) => executeRecords({}, id)))),
        Effect.match({
          onFailure: (error) => {
            setPending(false);
            setMessage(
              Match.value(error).pipe(
                Match.tag('ApplyCommandActionForbiddenProblem', () => t(`${key}.forbidden`)),
                Match.orElse(() => t(`${key}.invalid`)),
              ),
            );
          },
          onSuccess: (result) => {
            setRecords(result);
            setSummary('');
            setPending(false);
            setMessage(t(`${key}.saved`));
          },
        }),
      ),
    );
  };
  const partyItems = counterparties.map((item) => ({ label: item.party.title, value: item.ref.resourceId }));
  const taskItems = tasks.map((item) => ({ label: item.title, value: item.ref.resourceId }));
  return {
    card,
    counterpartyId,
    findCounterparty,
    key,
    language,
    loadTasks,
    message,
    partyItems,
    pending,
    query,
    records,
    refresh,
    save,
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

const RecordsPageContent = () => {
  const {
    card,
    counterpartyId,
    findCounterparty,
    key,
    language,
    loadTasks,
    message,
    partyItems,
    pending,
    query,
    records,
    refresh,
    save,
    setCounterpartyId,
    setQuery,
    setSummary,
    setTaskId,
    showCard,
    summary,
    t,
    taskId,
    taskItems,
  } = useRelationshipsRecords();
  return (
    <>
      <UltramodernRouteHead />
      <section
        aria-labelledby="records-heading"
        className="siamparkrelationships:w-full siamparkrelationships:min-w-0 siamparkrelationships:max-w-none siamparkrelationships:p-0 siamparkrelationships:space-y-6 siamparkrelationships:text-(--color-page-fg)"
      >
        <header className="siamparkrelationships:flex siamparkrelationships:flex-wrap siamparkrelationships:items-center siamparkrelationships:justify-between siamparkrelationships:gap-4">
          <div className="siamparkrelationships:space-y-1">
            <h1 className="siamparkrelationships:text-3xl siamparkrelationships:font-semibold" id="records-heading">
              {t(`${key}.title`)}
            </h1>
            <p className="siamparkrelationships:text-sm siamparkrelationships:text-(--color-fg-secondary)">
              {t(`${key}.intro`)}
            </p>
          </div>
          <Button disabled={pending} onClick={refresh} size="sm" theme="outlined" variant="secondary">
            {t(`${key}.refresh`)}
          </Button>
        </header>
        <output aria-live="polite" className="siamparkrelationships:block siamparkrelationships:text-sm">
          {message}
        </output>
        {records !== undefined && (
          <>
            <div className="siamparkrelationships:overflow-x-auto siamparkrelationships:rounded-lg siamparkrelationships:border siamparkrelationships:border-(--color-border-muted) siamparkrelationships:bg-(--color-surface)">
              <Table size="sm" variant="outline">
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
                      <Table.Cell className="siamparkrelationships:whitespace-nowrap siamparkrelationships:text-(--color-fg-secondary)">
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
                      <Table.Cell className="siamparkrelationships:font-medium">{activity.summary}</Table.Cell>
                      <Table.Cell>
                        {activity.followUpTaskRef === undefined ? (
                          '—'
                        ) : (
                          <Link
                            href={`/${language ?? 'cs'}/siampark/work?resourceId=${encodeURIComponent(activity.followUpTaskRef.resourceId)}`}
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
                        className="siamparkrelationships:py-8 siamparkrelationships:text-center siamparkrelationships:text-(--color-fg-secondary)"
                        colSpan={5}
                      >
                        {t(`${key}.empty`)}
                      </Table.Cell>
                    </Table.Row>
                  )}
                </Table.Body>
              </Table>
            </div>
            <div className="siamparkrelationships:grid siamparkrelationships:items-start siamparkrelationships:gap-6 siamparkrelationships:lg:grid-cols-2">
              {card !== undefined && (
                <article
                  aria-label={t(`${key}.contact`)}
                  className="siamparkrelationships:min-w-0 siamparkrelationships:space-y-5 siamparkrelationships:rounded-lg siamparkrelationships:border siamparkrelationships:border-(--color-border-muted) siamparkrelationships:bg-(--color-surface) siamparkrelationships:p-5"
                >
                  <div className="siamparkrelationships:space-y-1">
                    <p className="siamparkrelationships:text-sm siamparkrelationships:text-(--color-fg-secondary)">
                      {t(`${key}.contact`)}
                    </p>
                    <h2 className="siamparkrelationships:text-xl siamparkrelationships:font-semibold">
                      {card.party.displayName ?? t(`${key}.unnamed`)}
                    </h2>
                  </div>
                  <dl className="siamparkrelationships:grid siamparkrelationships:gap-4 siamparkrelationships:rounded-lg siamparkrelationships:bg-(--color-surface-subtle) siamparkrelationships:p-4 siamparkrelationships:text-sm">
                    <div className="siamparkrelationships:space-y-1">
                      <dt className="siamparkrelationships:text-(--color-fg-secondary)">{t(`${key}.partyType`)}</dt>
                      <dd>{card.party.partyType}</dd>
                    </div>
                    <div className="siamparkrelationships:space-y-2">
                      <dt className="siamparkrelationships:text-(--color-fg-secondary)">{t(`${key}.roles`)}</dt>
                      <dd className="siamparkrelationships:flex siamparkrelationships:flex-wrap siamparkrelationships:gap-2">
                        {card.currentRoles.map((role) => (
                          <Badge key={role.roleType} size="sm" variant="outline">
                            {role.roleType}
                          </Badge>
                        ))}
                      </dd>
                    </div>
                  </dl>
                </article>
              )}
              {records.canWrite && (
                <form
                  className={`siamparkrelationships:min-w-0 siamparkrelationships:space-y-5 siamparkrelationships:rounded-lg siamparkrelationships:border siamparkrelationships:border-(--color-border-muted) siamparkrelationships:bg-(--color-surface) siamparkrelationships:p-5 ${card === undefined ? 'siamparkrelationships:lg:col-span-2' : ''}`}
                  onSubmit={(event) => {
                    event.preventDefault();
                    save();
                  }}
                >
                  <h2 className="siamparkrelationships:text-xl siamparkrelationships:font-semibold">
                    {t(`${key}.record`)}
                  </h2>
                  <div className="siamparkrelationships:grid siamparkrelationships:items-start siamparkrelationships:gap-4 siamparkrelationships:md:grid-cols-2">
                    <div className="siamparkrelationships:space-y-4 siamparkrelationships:rounded-lg siamparkrelationships:bg-(--color-surface-subtle) siamparkrelationships:p-4">
                      <div className="siamparkrelationships:flex siamparkrelationships:flex-wrap siamparkrelationships:items-end siamparkrelationships:gap-3">
                        <div className="siamparkrelationships:min-w-0 siamparkrelationships:flex-1">
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
                        items={partyItems}
                        onValueChange={({ value }) => setCounterpartyId(value)}
                        value={counterpartyId}
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
                    <div className="siamparkrelationships:space-y-4 siamparkrelationships:rounded-lg siamparkrelationships:bg-(--color-surface-subtle) siamparkrelationships:p-4">
                      <Button
                        disabled={pending}
                        onClick={loadTasks}
                        size="sm"
                        theme="outlined"
                        type="button"
                        variant="secondary"
                      >
                        {t(`${key}.loadTasks`)}
                      </Button>
                      <Select items={taskItems} onValueChange={({ value }) => setTaskId(value)} value={taskId}>
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
                  <div className="siamparkrelationships:flex siamparkrelationships:flex-wrap siamparkrelationships:gap-2 siamparkrelationships:border-t siamparkrelationships:border-(--color-border-muted) siamparkrelationships:pt-4">
                    <Button
                      disabled={pending || summary.trim() === '' || counterpartyId.length === 0}
                      size="sm"
                      type="submit"
                      variant="warning"
                    >
                      {t(`${key}.save`)}
                    </Button>
                  </div>
                </form>
              )}
            </div>
          </>
        )}
      </section>
    </>
  );
};

export const RecordsPage = () => {
  const location = useRouterState({ select: (state) => state.location.href });
  return (
    <FederatedI18nBoundary
      defaultNamespace="siampark-relationships"
      fallbackLanguage="en"
      resources={siamparkRelationshipsI18nResources}
      supportedLanguages={['en', 'cs']}
    >
      <RecordsPageContent key={location} />
    </FederatedI18nBoundary>
  );
};

export default RecordsPage;
