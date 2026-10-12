import { TaskRefSchema } from '../../../../../shared/resources/task.ts';
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Select } from '@techsio/ui-kit/molecules/select';
import { executeRecords as executePropertyRecords } from '@app/siampark-property/clients/records';
import { Table } from '@techsio/ui-kit/organisms/table';
import { DateTime, Effect, Match, Option, Random, Schema } from 'effect';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import type { Types } from 'effect';
import { useState } from 'react';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { executeRecords } from '../../../../api/records-client.ts';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import type { WorkCommand } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse, Task } from '../../../../../shared/apis/records.ts';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import csResource from '../../../../../locales/cs/siampark-work.json';
import enResource from '../../../../../locales/en/siampark-work.json';
import '../../../index.css';

const searchSchema = Schema.Struct({
  resourceId: Schema.optional(TaskRefSchema.fields.resourceId.check(Schema.isUUID())),
});
const siamparkWorkI18nResources = {
  cs: { 'siampark-work': csResource },
  en: { 'siampark-work': enResource },
} as const;

type EditFields = Types.Mutable<
  Pick<Extract<WorkCommand, { readonly _tag: 'CreateTask' }>, 'title' | 'description' | 'priority' | 'dueDate'>
>;
type Units = Effect.Success<ReturnType<typeof executePropertyRecords>>['units'];
const useWorkRecords = () => {
  const { language, t } = useModernI18n();
  const search = Schema.decodeOption(searchSchema)(useRouterState().location.search);
  const resourceId = Option.getOrUndefined(search)?.resourceId;
  const [records, setRecords] = useState<RecordsResponse>();
  const [selected, setSelected] = useState<Task>();
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [description, setDescription] = useState('');
  const [units, setUnits] = useState<Units>([]);
  const [unitId, setUnitId] = useState<string[]>([]);
  const [priority, setPriority] = useState<Task['priority']>('NORMAL');
  const [filter, setFilter] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const key = 'siampark-work.pages.records';
  const requestId = Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }).pipe(
    Effect.map(([first, second]) => `siampark-work:${first}:${second}`),
  );
  const refresh = () => {
    setPending(true);
    void browserRuntime.runPromise(
      requestId.pipe(
        Effect.flatMap((id) => executeRecords(resourceId === undefined ? {} : { resourceId }, id)),
        Effect.match({
          onFailure: (error) => {
            setRecords(undefined);
            setSelected(undefined);
            setUnits([]);
            setUnitId([]);
            setTitle('');
            setDescription('');
            setDueDate('');
            setFilter('');
            setPriority('NORMAL');
            setMessage(
              Match.value(error).pipe(
                Match.tag('RecordsForbiddenProblem', () => t(`${key}.forbidden`)),
                Match.orElse(() => t(`${key}.unavailable`)),
              ),
            );
            setPending(false);
          },
          onSuccess: (result) => {
            setRecords(result);
            setSelected(result.items.find((task) => task.ref.resourceId === resourceId));
            setMessage('');
            setPending(false);
          },
        }),
      ),
    );
  };
  const mutate = (command: WorkCommand) => {
    if (records === undefined) {
      return;
    }
    setPending(true);
    void browserRuntime.runPromise(
      Effect.all(
        {
          id: requestId,
          referenceCredentials: makeReferenceGatewayCredentials(
            Match.value(command).pipe(
              Match.tag('CreateTask', ({ contextRefs = [] }) => contextRefs.map(() => 'siampark-property')),
              Match.tag('UpdateTask', 'AssignTask', 'ChangeTaskState', () => []),
              Match.exhaustive,
            ),
          ),
        },
        { concurrency: 1 },
      ).pipe(
        Effect.flatMap(({ id, referenceCredentials }) =>
          executeApplyCommand({ command, expectedRevision: records.revision }, id, {
            idempotencyKey: id,
            referenceCredentials,
          }),
        ),
        Effect.flatMap((outcome) =>
          requestId.pipe(
            Effect.flatMap((id) => executeRecords(resourceId === undefined ? {} : { resourceId }, id)),
            Effect.map((freshRecords) => ({ changedTaskRef: outcome.task.ref, freshRecords })),
          ),
        ),
        Effect.match({
          onFailure: (error) => {
            setUnits([]);
            setUnitId([]);
            if (Schema.is(Schema.Struct({ status: Schema.Literal(403) }))(error)) {
              setRecords(undefined);
              setSelected(undefined);
            }
            setPending(false);
            setMessage(
              Match.value(error).pipe(
                Match.tag('ApplyCommandActionConflictProblem', () => t(`${key}.conflict`)),
                Match.tag('ApplyCommandActionForbiddenProblem', 'RecordsForbiddenProblem', () => t(`${key}.forbidden`)),
                Match.orElse(() => t(`${key}.invalid`)),
              ),
            );
          },
          onSuccess: ({ changedTaskRef, freshRecords }) => {
            const task = freshRecords.items.find((item) => item.ref.resourceId === changedTaskRef.resourceId);
            setRecords(freshRecords);
            setSelected(task);
            setTitle(task?.title ?? '');
            setDueDate(task?.dueDate ?? '');
            setDescription(task?.description ?? '');
            setPriority(task?.priority ?? 'NORMAL');
            setMessage(t(`${key}.saved`));
            setPending(false);
          },
        }),
      ),
    );
  };
  const loadUnits = () => {
    setPending(true);
    void browserRuntime.runPromise(
      requestId.pipe(
        Effect.flatMap((id) => executePropertyRecords({}, id)),
        Effect.match({
          onFailure: (error) => {
            setUnits([]);
            setUnitId([]);
            setMessage(
              Match.value(error).pipe(
                Match.tag('RecordsForbiddenProblem', () => t(`${key}.forbidden`)),
                Match.orElse(() => t(`${key}.unavailable`)),
              ),
            );
            setPending(false);
          },
          onSuccess: (result) => {
            setUnits(result.units);
            setPending(false);
          },
        }),
      ),
    );
  };
  const choose = (task: Task) => {
    setSelected(task);
    setTitle(task.title);
    setDueDate(task.dueDate ?? '');
    setDescription(task.description ?? '');
    setPriority(task.priority);
  };
  const editable = records?.canWrite === true && selected?.state !== 'DONE' && selected?.state !== 'CANCELLED';
  const save = () => {
    const fields: EditFields = {
      description,
      priority,
      title,
    };
    if (dueDate !== '') {
      fields.dueDate = dueDate;
    }
    const unit = units.find((item) => item.unitRef.resourceId === unitId[0]);
    mutate(
      selected === undefined
        ? { _tag: 'CreateTask', ...fields, contextRefs: unit === undefined ? [] : [unit.unitRef] }
        : { _tag: 'UpdateTask', ...fields, taskRef: selected.ref },
    );
  };
  const nextStates =
    selected === undefined
      ? []
      : Match.value(selected.state).pipe(
          Match.when('NEW', () => ['IN_PROGRESS', 'CANCELLED'] as const),
          Match.when('IN_PROGRESS', () => ['WAITING', 'DONE', 'CANCELLED'] as const),
          Match.when('WAITING', () => ['IN_PROGRESS', 'DONE', 'CANCELLED'] as const),
          Match.whenOr('DONE', 'CANCELLED', () => []),
          Match.exhaustive,
        );
  return {
    choose,
    description,
    dueDate,
    editable,
    filter,
    key,
    language,
    loadUnits,
    message,
    mutate,
    nextStates,
    pending,
    priority,
    records,
    refresh,
    save,
    selected,
    setDescription,
    setDueDate,
    setFilter,
    setPriority,
    setSelected,
    setTitle,
    setUnitId,
    t,
    title,
    unitId,
    units,
  };
};

const RecordsPageContent = () => {
  const model = useWorkRecords();
  const { key, language, loadUnits: handleLoadUnits, records, refresh: handleRefresh, selected, t } = model;
  const formatDateTime = (timestamp: DateTime.Utc) =>
    DateTime.format(timestamp, {
      day: '2-digit',
      fractionalSecondDigits: 3,
      hour: '2-digit',
      locale: language,
      minute: '2-digit',
      month: '2-digit',
      second: '2-digit',
      timeZone: 'Europe/Prague',
      timeZoneName: 'short',
      year: 'numeric',
    });
  return (
    <>
      <UltramodernRouteHead />
      <section
        aria-labelledby="records-heading"
        className="siamparkwork:w-full siamparkwork:min-w-0 siamparkwork:max-w-none siamparkwork:p-0 siamparkwork:space-y-6 siamparkwork:text-(--color-page-fg)"
      >
        <header className="siamparkwork:flex siamparkwork:flex-wrap siamparkwork:items-center siamparkwork:justify-between siamparkwork:gap-4">
          <h1 className="siamparkwork:text-3xl siamparkwork:font-semibold" id="records-heading">
            {t(`${key}.title`)}
          </h1>
          <Button disabled={model.pending} onClick={handleRefresh} size="sm" theme="outlined" variant="secondary">
            {t(`${key}.refresh`)}
          </Button>
        </header>
        <output aria-live="polite" className="siamparkwork:block siamparkwork:text-sm">
          {model.message}
        </output>
        {records !== undefined && (
          <>
            <p className="siamparkwork:rounded-lg siamparkwork:border siamparkwork:border-(--color-border-muted) siamparkwork:bg-(--color-surface-subtle) siamparkwork:p-4 siamparkwork:text-sm siamparkwork:text-(--color-fg-secondary)">
              {t(`${key}.indicators`, {
                date: records.referenceDate,
                open: records.indicators.open,
                overdue: records.indicators.overdue,
              })}
            </p>
            <FormInput
              id="task-filter"
              label={t(`${key}.filter`)}
              onChange={(event) => model.setFilter(event.target.value)}
              value={model.filter}
            />
            <div className="siamparkwork:overflow-x-auto siamparkwork:rounded-lg siamparkwork:border siamparkwork:border-(--color-border-muted) siamparkwork:bg-(--color-surface)">
              <Table size="sm" variant="outline">
                <Table.Caption>{records.collection.title}</Table.Caption>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader>{t(`${key}.taskTitle`)}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t(`${key}.state`)}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t(`${key}.dueDate`)}</Table.ColumnHeader>
                    <Table.ColumnHeader>{t(`${key}.detail`)}</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {records.items.map((task) =>
                    task.title.toLocaleLowerCase().includes(model.filter.toLocaleLowerCase()) ? (
                      <Table.Row key={task.ref.resourceId} selected={selected?.ref.resourceId === task.ref.resourceId}>
                        <Table.Cell className="siamparkwork:font-medium">{task.title}</Table.Cell>
                        <Table.Cell>
                          <Badge
                            size="sm"
                            variant={
                              (
                                {
                                  CANCELLED: 'outline',
                                  DONE: 'success',
                                  IN_PROGRESS: 'primary',
                                  NEW: 'info',
                                  WAITING: 'warning',
                                } as const
                              )[task.state]
                            }
                          >
                            {t(`${key}.states.${task.state}`)}
                          </Badge>
                        </Table.Cell>
                        <Table.Cell>{task.dueDate ?? '—'}</Table.Cell>
                        <Table.Cell>
                          <Button onClick={() => model.choose(task)} size="sm" theme="borderless" variant="secondary">
                            {t(`${key}.detail`)}
                          </Button>
                        </Table.Cell>
                      </Table.Row>
                    ) : null,
                  )}
                  {!records.items.some((task) =>
                    task.title.toLocaleLowerCase().includes(model.filter.toLocaleLowerCase()),
                  ) && (
                    <Table.Row>
                      <Table.Cell
                        className="siamparkwork:py-8 siamparkwork:text-center siamparkwork:text-(--color-fg-secondary)"
                        colSpan={4}
                      >
                        {t(`${key}.empty`)}
                      </Table.Cell>
                    </Table.Row>
                  )}
                </Table.Body>
              </Table>
            </div>
            {selected !== undefined && (
              <article className="siamparkwork:space-y-4 siamparkwork:rounded-lg siamparkwork:border siamparkwork:border-(--color-border-muted) siamparkwork:bg-(--color-surface) siamparkwork:p-5 siamparkwork:text-sm">
                <h2 className="siamparkwork:text-xl siamparkwork:font-semibold">{selected.title}</h2>
                <p className="siamparkwork:text-(--color-fg-secondary)">{selected.description}</p>
                <p>
                  {t(`${key}.createdAt`)}:{' '}
                  <time dateTime={DateTime.formatIso(selected.createdAt)}>{formatDateTime(selected.createdAt)}</time>
                </p>
                <p>
                  {t(`${key}.updatedAt`)}:{' '}
                  <time dateTime={DateTime.formatIso(selected.updatedAt)}>{formatDateTime(selected.updatedAt)}</time>
                </p>
                <p>
                  {t(`${key}.priority`)}:{' '}
                  <Badge
                    size="sm"
                    variant={({ HIGH: 'danger', LOW: 'outline', NORMAL: 'secondary' } as const)[selected.priority]}
                  >
                    {t(`${key}.priorities.${selected.priority}`)}
                  </Badge>
                </p>
                <p>
                  {t(`${key}.owner`)}: {selected.ownerPrincipalRef?.principalId ?? t(`${key}.unassigned`)}
                </p>
                <ul className="siamparkwork:space-y-2 siamparkwork:break-all siamparkwork:text-(--color-fg-secondary)">
                  {selected.contextRefs.map((ref) => (
                    <li key={`${ref.resourceType}:${ref.resourceId}`}>
                      {ref.resourceType}: {ref.resourceId}
                    </li>
                  ))}
                </ul>
              </article>
            )}
            {records.canWrite && (
              <form
                className="siamparkwork:grid siamparkwork:gap-4 siamparkwork:rounded-lg siamparkwork:border siamparkwork:border-(--color-border-muted) siamparkwork:bg-(--color-surface) siamparkwork:p-5 siamparkwork:md:grid-cols-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  model.save();
                }}
              >
                <h2 className="siamparkwork:text-xl siamparkwork:font-semibold siamparkwork:md:col-span-2">
                  {t(selected === undefined ? `${key}.create` : `${key}.edit`)}
                </h2>
                <FormInput
                  disabled={!model.editable || model.pending}
                  id="task-title"
                  label={t(`${key}.taskTitle`)}
                  maxLength={200}
                  onChange={(event) => model.setTitle(event.target.value)}
                  required
                  value={model.title}
                />
                <FormInput
                  disabled={!model.editable || model.pending}
                  id="task-description"
                  label={t(`${key}.description`)}
                  maxLength={2000}
                  onChange={(event) => model.setDescription(event.target.value)}
                  value={model.description}
                />
                <FormInput
                  disabled={!model.editable || model.pending}
                  id="task-due"
                  label={t(`${key}.dueDate`)}
                  onChange={(event) => model.setDueDate(event.target.value)}
                  type="date"
                  value={model.dueDate}
                />
                <div className="siamparkwork:flex siamparkwork:flex-wrap siamparkwork:items-end siamparkwork:gap-2">
                  {(['LOW', 'NORMAL', 'HIGH'] as const).map((value) => (
                    <Button
                      aria-pressed={model.priority === value}
                      disabled={!model.editable || model.pending}
                      key={value}
                      onClick={() => model.setPriority(value)}
                      size="sm"
                      theme="outlined"
                      type="button"
                      variant="secondary"
                    >
                      {t(`${key}.priorities.${value}`)}
                    </Button>
                  ))}
                </div>
                {selected === undefined && (
                  <>
                    <Button
                      disabled={model.pending}
                      onClick={handleLoadUnits}
                      size="sm"
                      theme="outlined"
                      type="button"
                      variant="secondary"
                    >
                      {t(`${key}.loadUnits`)}
                    </Button>
                    <Select
                      items={model.units.map((unit) => ({ label: unit.code, value: unit.unitRef.resourceId }))}
                      onValueChange={({ value }) => model.setUnitId(value)}
                      value={model.unitId}
                    >
                      <Select.Label>{t(`${key}.unit`)}</Select.Label>
                      <Select.Control>
                        <Select.Trigger>
                          <Select.ValueText placeholder={t(`${key}.selectUnit`)} />
                        </Select.Trigger>
                      </Select.Control>
                      <Select.Positioner>
                        <Select.Content>
                          {model.units.map((unit) => (
                            <Select.Item
                              item={{ label: unit.code, value: unit.unitRef.resourceId }}
                              key={unit.unitRef.resourceId}
                            >
                              <Select.ItemText>
                                {unit.code} · {unit.name}
                              </Select.ItemText>
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Positioner>
                    </Select>
                  </>
                )}
                <Button
                  disabled={!model.editable || model.pending || model.title.trim() === ''}
                  size="sm"
                  type="submit"
                  variant="warning"
                >
                  {t(`${key}.save`)}
                </Button>
                <Button
                  onClick={() => {
                    model.setSelected(undefined);
                    model.setTitle('');
                    model.setDueDate('');
                    model.setDescription('');
                  }}
                  size="sm"
                  type="button"
                  variant="warning"
                >
                  {t(`${key}.new`)}
                </Button>
                {selected !== undefined && model.editable && (
                  <>
                    <Button
                      disabled={model.pending}
                      onClick={() =>
                        model.mutate({
                          _tag: 'AssignTask',
                          ownerPrincipalRef: records.actorPrincipalRef,
                          taskRef: selected.ref,
                        })
                      }
                      size="sm"
                      theme="outlined"
                      type="button"
                      variant="secondary"
                    >
                      {t(`${key}.assignMe`)}
                    </Button>
                    {model.nextStates.map((state) => (
                      <Button
                        disabled={model.pending}
                        key={state}
                        onClick={() => model.mutate({ _tag: 'ChangeTaskState', state, taskRef: selected.ref })}
                        size="sm"
                        theme="outlined"
                        type="button"
                        variant="secondary"
                      >
                        {t(`${key}.states.${state}`)}
                      </Button>
                    ))}
                  </>
                )}
              </form>
            )}
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
      defaultNamespace="siampark-work"
      fallbackLanguage="en"
      resources={siamparkWorkI18nResources}
      supportedLanguages={['en', 'cs']}
    >
      <RecordsPageContent key={location} />
    </FederatedI18nBoundary>
  );
};

export default RecordsPage;
