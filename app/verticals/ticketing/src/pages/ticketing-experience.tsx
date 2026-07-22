// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off globalFetch:off
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { toaster } from '@techsio/ui-kit/molecules/toast';
import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  Effect,
  getTaskPropertyDeletionImpact,
  getTaskPropertyDefinitionEditCapability,
  executeCoreReference,
  getTaskPropertyEditCapability,
  getTaskCollection,
  runCreateDatePropertyDefinitionAction,
  runCreateDateRangePropertyDefinitionAction,
  runConfigureDateRangeTimeSupportAction,
  getTaskPropertyWorkspace,
  runCreateCheckboxPropertyDefinitionAction,
  runCreateEmailPropertyDefinitionAction,
  runCreateNumberPropertyDefinitionAction,
  runCreatePhonePropertyDefinitionAction,
  runCreateIntrinsicPropertyDefinitionAction,
  runCreateTextPropertyDefinitionAction,
  runCreateTaskAction,
  runCreateTaskCollectionAction,
  runCreateUrlPropertyDefinitionAction,
  runDeleteTaskPropertyDefinitionAction,
  runDuplicateTaskPropertyDefinitionAction,
  runEffectRequest,
  runRetainTextCoreReferenceLabelAction,
  runUpdateCheckboxPropertyValueAction,
  runUpdateDatePropertyValueAction,
  runUpdateDateRangePropertyValueAction,
  runUpdateEmailPropertyValueAction,
  runUpdateNumberPropertyValueAction,
  runUpdatePhonePropertyValueAction,
  runUpdateTextPropertyValueAction,
  runUpdateUrlPropertyValueAction,
} from '../api/ticketing-client';
import { ultramodernUiMarker } from '../ultramodern-build';
import { CheckboxPropertyEditor } from '../components/checkbox-property-editor';
import { DatePropertyEditor } from '../components/date-property-editor';
import {
  DateRangePropertyEditor,
  DateRangeTimeSupportControl,
} from '../components/date-range-property-editor';
import { EmailPropertyEditor } from '../components/email-property-editor';
import { NumberPropertyEditor } from '../components/number-property-editor';
import { PhonePropertyEditor } from '../components/phone-property-editor';
import {
  CreatedByPresentation,
  CreatedTimePresentation,
  LastEditedByPresentation,
  LastEditedTimePresentation,
} from '../components/intrinsic-property-presentation';
import { TextPropertyEditor } from '../components/text-property-editor';
import { TaskPropertyDefinitionActions } from '../components/task-property-definition-actions';
import { TaskPropertyDefinitionForm } from '../components/task-property-definition-form';
import type {
  CreatableTaskPropertyDatatype,
  TaskPropertyDefinitionDraft,
} from '../components/task-property-definition-form';
import { UrlPropertyEditor } from '../components/url-property-editor';
import type { CreateTaskActionFailure } from '../../shared/actions/create-task';
import type { CreateTaskCollectionActionFailure } from '../../shared/actions/create-task-collection';
import type { DeleteTaskPropertyDefinitionActionPayload } from '../../shared/actions/delete-task-property-definition';
import type { DuplicateTaskPropertyDefinitionActionPayload } from '../../shared/actions/duplicate-task-property-definition';
import type { TaskCollectionAggregate, TaskCollectionCreation } from '../../shared/task-collection';
import { getTaskPropertyDefinitionValueCopyPolicy } from '../../shared/task-property-definition-value-copy-policy';
import type { TaskPropertyWorkspace } from '../../shared/task-property-workspace';
import type { DatePropertyLocale } from '../components/date-property-editor';

interface ShellOperationContextResponse {
  readonly verticalGatewayTokens?: Readonly<Record<string, string>>;
}

const datePropertyLocaleByLanguage: Readonly<Record<string, DatePropertyLocale>> = {
  cs: 'cs-CZ',
  en: 'en-GB',
};
const defaultDatePropertyLocale: DatePropertyLocale = 'en-GB';

const createDefinitionIdempotencyKeys = (): Record<CreatableTaskPropertyDatatype, string> => ({
  checkbox: crypto.randomUUID(),
  created_by: crypto.randomUUID(),
  created_time: crypto.randomUUID(),
  date: crypto.randomUUID(),
  date_range: crypto.randomUUID(),
  email: crypto.randomUUID(),
  last_edited_by: crypto.randomUUID(),
  last_edited_time: crypto.randomUUID(),
  number: crypto.randomUUID(),
  phone: crypto.randomUUID(),
  text: crypto.randomUUID(),
  url: crypto.randomUUID(),
});

const loadTicketingOperationContextToken = async (): Promise<string> => {
  const response = await fetch('/shell-super-app-api/operation-context', {
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`Shell operation context request failed with status ${response.status}.`);
  }

  const body = (await response.json()) as ShellOperationContextResponse;
  const token = body.verticalGatewayTokens?.['ticketing'];
  if (token === undefined || token.trim().length === 0) {
    throw new Error('Shell operation context is missing a ticketing gateway token.');
  }

  return token;
};

const isCreateActionFailure = (
  error: unknown,
): error is CreateTaskActionFailure | CreateTaskCollectionActionFailure =>
  typeof error === 'object' &&
  error !== null &&
  'ok' in error &&
  error.ok === false &&
  'message' in error &&
  typeof error.message === 'string';

export const TicketingExperience = () => {
  const { language, supportedLanguages, t } = useModernI18n();
  const [collectionName, setCollectionName] = useState('');
  const [formIdempotencyKey, setFormIdempotencyKey] = useState(() => crypto.randomUUID());
  const [pendingTaskCollection, setPendingTaskCollection] = useState<TaskCollectionCreation>();
  const [pendingTaskCollectionReadId, setPendingTaskCollectionReadId] = useState<string>();
  const [openedTaskCollection, setOpenedTaskCollection] = useState<TaskCollectionAggregate>();
  const [openedTaskPropertyWorkspace, setOpenedTaskPropertyWorkspace] =
    useState<TaskPropertyWorkspace>();
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [definitionIdempotencyKeys, setDefinitionIdempotencyKeys] = useState(
    createDefinitionIdempotencyKeys,
  );
  const [canEditTaskPropertyValues, setCanEditTaskPropertyValues] = useState(false);
  const [canEditTaskPropertyDefinitions, setCanEditTaskPropertyDefinitions] = useState(false);

  const rotateDefinitionIdempotencyKey = (datatype: CreatableTaskPropertyDatatype) =>
    setDefinitionIdempotencyKeys((current) => ({
      ...current,
      [datatype]: crypto.randomUUID(),
    }));

  const handleCreateTask = async () => {
    if (pendingTaskCollection === undefined && collectionName.trim().length === 0) {
      return;
    }
    setIsCreatingTask(true);

    try {
      const operationContextToken = await loadTicketingOperationContextToken();
      const headers = {
        'x-ontos-operation-context': operationContextToken,
      };
      const runTaskCreation = (taskCollection: TaskCollectionCreation) =>
        runCreateTaskAction(
          { collectionId: taskCollection.collection.collectionId },
          { headers, idempotencyKey: formIdempotencyKey },
        );
      const taskCollectionEffect =
        pendingTaskCollectionReadId === undefined
          ? (pendingTaskCollection === undefined
              ? runCreateTaskCollectionAction(
                  { name: collectionName },
                  {
                    headers,
                    idempotencyKey: formIdempotencyKey,
                  },
                ).pipe(
                  Effect.flatMap((outcome) => {
                    setPendingTaskCollection(outcome.response);
                    return runTaskCreation(outcome.response);
                  }),
                )
              : runTaskCreation(pendingTaskCollection)
            ).pipe(
              Effect.flatMap((outcome) => {
                const { collectionId } = outcome.response.task;
                setPendingTaskCollectionReadId(collectionId);
                return getTaskCollection(collectionId, { headers });
              }),
            )
          : getTaskCollection(pendingTaskCollectionReadId, { headers });
      await runEffectRequest(
        taskCollectionEffect.pipe(
          Effect.match({
            onFailure: (error) => {
              toaster.create(
                isCreateActionFailure(error)
                  ? {
                      description: error.message,
                      title: t('ticketing.taskCollection.createRejected'),
                      type: 'error',
                    }
                  : {
                      description:
                        error instanceof Error
                          ? error.message
                          : t('ticketing.taskCollection.createRequestFailed'),
                      title: t('ticketing.taskCollection.createFailed'),
                      type: 'error',
                    },
              );
            },
            onSuccess: (taskCollection) => {
              setOpenedTaskCollection(taskCollection);
              setDefinitionIdempotencyKeys(createDefinitionIdempotencyKeys());
              setOpenedTaskPropertyWorkspace({
                collectionId: taskCollection.collection.collectionId,
                idGroups: [],
                propertyDefinitions: [],
                tasks: [
                  {
                    canvas: {},
                    checkboxValues: [],
                    dateRangeValues: [],
                    dateValues: [],
                    emailValues: [],
                    filesMediaItems: [],
                    numberValues: [],
                    personValues: [],
                    phoneValues: [],
                    selectValues: [],
                    statusValues: [],
                    taskId: taskCollection.task.taskId,
                    taskRevision: taskCollection.task.revision,
                    title: taskCollection.task.title,
                    urlValues: [],
                  },
                ],
              });
              setPendingTaskCollection(undefined);
              setPendingTaskCollectionReadId(undefined);
              setCollectionName('');
              setFormIdempotencyKey(crypto.randomUUID());
              void runEffectRequest(
                getTaskPropertyEditCapability(taskCollection.collection.collectionId, { headers }),
              )
                .then(({ canEdit }) => setCanEditTaskPropertyValues(canEdit))
                .catch(() => setCanEditTaskPropertyValues(false));
              void runEffectRequest(
                getTaskPropertyDefinitionEditCapability(taskCollection.collection.collectionId, {
                  headers,
                }),
              )
                .then(({ canEditDefinitions }) =>
                  setCanEditTaskPropertyDefinitions(canEditDefinitions),
                )
                .catch(() => setCanEditTaskPropertyDefinitions(false));
              toaster.create({
                description: t('ticketing.taskCollection.createdDescription'),
                title: t('ticketing.taskCollection.createdTitle'),
                type: 'success',
              });
            },
          }),
        ),
      );
    } catch (error) {
      toaster.create({
        description:
          error instanceof Error
            ? error.message
            : t('ticketing.taskCollection.createRequestFailed'),
        title: t('ticketing.taskCollection.createFailed'),
        type: 'error',
      });
    } finally {
      setIsCreatingTask(false);
    }
  };

  const handleCreateCheckboxDefinition = async ({
    mandatory,
    name,
  }: TaskPropertyDefinitionDraft) => {
    if (openedTaskPropertyWorkspace === undefined) {
      return;
    }
    const operationContextToken = await loadTicketingOperationContextToken();
    const outcome = await runEffectRequest(
      runCreateCheckboxPropertyDefinitionAction(
        {
          collectionId: openedTaskPropertyWorkspace.collectionId,
          mandatory,
          name,
        },
        {
          headers: { 'x-ontos-operation-context': operationContextToken },
          idempotencyKey: definitionIdempotencyKeys.checkbox,
        },
      ),
    );
    setOpenedTaskPropertyWorkspace((current) =>
      current === undefined
        ? current
        : {
            ...current,
            propertyDefinitions: [...current.propertyDefinitions, outcome.response.definition],
            tasks: current.tasks.map((task) => ({
              ...task,
              checkboxValues: [
                ...task.checkboxValues,
                {
                  propertyDefinitionId: outcome.response.definition.propertyDefinitionId,
                  revision: 1,
                  value: false,
                },
              ],
            })),
          },
    );
    rotateDefinitionIdempotencyKey('checkbox');
  };

  const handleCreateEmailDefinition = async ({ mandatory, name }: TaskPropertyDefinitionDraft) => {
    if (openedTaskPropertyWorkspace === undefined) {
      return;
    }
    const operationContextToken = await loadTicketingOperationContextToken();
    const outcome = await runEffectRequest(
      runCreateEmailPropertyDefinitionAction(
        {
          collectionId: openedTaskPropertyWorkspace.collectionId,
          mandatory,
          name,
        },
        {
          headers: { 'x-ontos-operation-context': operationContextToken },
          idempotencyKey: definitionIdempotencyKeys.email,
        },
      ),
    );
    setOpenedTaskPropertyWorkspace((current) =>
      current === undefined
        ? current
        : {
            ...current,
            propertyDefinitions: [...current.propertyDefinitions, outcome.response.definition],
          },
    );
    rotateDefinitionIdempotencyKey('email');
  };

  const handleCreateTextDefinition = async ({ mandatory, name }: TaskPropertyDefinitionDraft) => {
    if (openedTaskPropertyWorkspace === undefined) {
      return;
    }
    const operationContextToken = await loadTicketingOperationContextToken();
    const outcome = await runEffectRequest(
      runCreateTextPropertyDefinitionAction(
        {
          collectionId: openedTaskPropertyWorkspace.collectionId,
          mandatory,
          name,
        },
        {
          headers: { 'x-ontos-operation-context': operationContextToken },
          idempotencyKey: definitionIdempotencyKeys.text,
        },
      ),
    );
    setOpenedTaskPropertyWorkspace((current) =>
      current === undefined
        ? current
        : {
            ...current,
            propertyDefinitions: [...current.propertyDefinitions, outcome.response.definition],
            tasks: current.tasks.map((task) => ({
              ...task,
              textValues: [
                ...(task.textValues ?? []),
                {
                  document: null,
                  propertyDefinitionId: outcome.response.definition.propertyDefinitionId,
                  readableText: null,
                  revision: 1,
                },
              ],
            })),
          },
    );
    rotateDefinitionIdempotencyKey('text');
  };

  const handleCreateNumberDefinition = async ({ mandatory, name }: TaskPropertyDefinitionDraft) => {
    if (openedTaskPropertyWorkspace === undefined) {
      return;
    }
    const operationContextToken = await loadTicketingOperationContextToken();
    const outcome = await runEffectRequest(
      runCreateNumberPropertyDefinitionAction(
        {
          collectionId: openedTaskPropertyWorkspace.collectionId,
          mandatory,
          name,
        },
        {
          headers: { 'x-ontos-operation-context': operationContextToken },
          idempotencyKey: definitionIdempotencyKeys.number,
        },
      ),
    );
    setOpenedTaskPropertyWorkspace((current) =>
      current === undefined
        ? current
        : {
            ...current,
            propertyDefinitions: [...current.propertyDefinitions, outcome.response.definition],
          },
    );
    rotateDefinitionIdempotencyKey('number');
  };

  const handleCreateUrlDefinition = async ({ mandatory, name }: TaskPropertyDefinitionDraft) => {
    if (openedTaskPropertyWorkspace === undefined) {
      return;
    }
    const operationContextToken = await loadTicketingOperationContextToken();
    const outcome = await runEffectRequest(
      runCreateUrlPropertyDefinitionAction(
        {
          collectionId: openedTaskPropertyWorkspace.collectionId,
          mandatory,
          name,
        },
        {
          headers: { 'x-ontos-operation-context': operationContextToken },
          idempotencyKey: definitionIdempotencyKeys.url,
        },
      ),
    );
    setOpenedTaskPropertyWorkspace((current) =>
      current === undefined
        ? current
        : {
            ...current,
            propertyDefinitions: [...current.propertyDefinitions, outcome.response.definition],
            tasks: current.tasks.map((task) => ({
              ...task,
              urlValues: [
                ...(task.urlValues ?? []),
                {
                  propertyDefinitionId: outcome.response.definition.propertyDefinitionId,
                  revision: 0,
                  value: null,
                },
              ],
            })),
          },
    );
    rotateDefinitionIdempotencyKey('url');
  };

  const handleCreatePhoneDefinition = async ({ mandatory, name }: TaskPropertyDefinitionDraft) => {
    if (openedTaskPropertyWorkspace === undefined) {
      return;
    }
    const operationContextToken = await loadTicketingOperationContextToken();
    const outcome = await runEffectRequest(
      runCreatePhonePropertyDefinitionAction(
        {
          collectionId: openedTaskPropertyWorkspace.collectionId,
          mandatory,
          name,
        },
        {
          headers: { 'x-ontos-operation-context': operationContextToken },
          idempotencyKey: definitionIdempotencyKeys.phone,
        },
      ),
    );
    setOpenedTaskPropertyWorkspace((current) =>
      current === undefined
        ? current
        : {
            ...current,
            propertyDefinitions: [...current.propertyDefinitions, outcome.response.definition],
          },
    );
    rotateDefinitionIdempotencyKey('phone');
  };

  const handleCreateDateDefinition = async ({ mandatory, name }: TaskPropertyDefinitionDraft) => {
    if (openedTaskPropertyWorkspace === undefined) {
      return;
    }
    const operationContextToken = await loadTicketingOperationContextToken();
    const outcome = await runEffectRequest(
      runCreateDatePropertyDefinitionAction(
        {
          collectionId: openedTaskPropertyWorkspace.collectionId,
          mandatory,
          name,
        },
        {
          headers: { 'x-ontos-operation-context': operationContextToken },
          idempotencyKey: definitionIdempotencyKeys.date,
        },
      ),
    );
    setOpenedTaskPropertyWorkspace((current) =>
      current === undefined
        ? current
        : {
            ...current,
            propertyDefinitions: [...current.propertyDefinitions, outcome.response.definition],
          },
    );
    rotateDefinitionIdempotencyKey('date');
  };

  const handleCreateDateRangeDefinition = async ({
    mandatory,
    name,
  }: TaskPropertyDefinitionDraft) => {
    if (openedTaskPropertyWorkspace === undefined) {
      return;
    }
    const operationContextToken = await loadTicketingOperationContextToken();
    const outcome = await runEffectRequest(
      runCreateDateRangePropertyDefinitionAction(
        {
          collectionId: openedTaskPropertyWorkspace.collectionId,
          mandatory,
          name,
        },
        {
          headers: { 'x-ontos-operation-context': operationContextToken },
          idempotencyKey: definitionIdempotencyKeys.date_range,
        },
      ),
    );
    setOpenedTaskPropertyWorkspace((current) =>
      current === undefined
        ? current
        : {
            ...current,
            propertyDefinitions: [...current.propertyDefinitions, outcome.response.definition],
          },
    );
    rotateDefinitionIdempotencyKey('date_range');
  };

  const handleCreateIntrinsicDefinition = async ({
    datatype,
    mandatory,
    name,
  }: TaskPropertyDefinitionDraft) => {
    if (openedTaskPropertyWorkspace === undefined) {
      return;
    }

    if (
      datatype !== 'created_by' &&
      datatype !== 'created_time' &&
      datatype !== 'last_edited_time' &&
      datatype !== 'last_edited_by'
    ) {
      return;
    }

    const operationContextToken = await loadTicketingOperationContextToken();
    const headers = { 'x-ontos-operation-context': operationContextToken };
    await runEffectRequest(
      runCreateIntrinsicPropertyDefinitionAction(
        {
          collectionId: openedTaskPropertyWorkspace.collectionId,
          datatype,
          mandatory,
          name,
        },
        { headers, idempotencyKey: definitionIdempotencyKeys[datatype] },
      ),
    );
    const workspace = await runEffectRequest(
      getTaskPropertyWorkspace(openedTaskPropertyWorkspace.collectionId, {
        browserTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        headers,
      }),
    );
    setOpenedTaskPropertyWorkspace(workspace);
    rotateDefinitionIdempotencyKey(datatype);
  };

  const handleCreatePropertyDefinition = (draft: TaskPropertyDefinitionDraft): Promise<void> => {
    const handlers = {
      checkbox: handleCreateCheckboxDefinition,
      created_by: handleCreateIntrinsicDefinition,
      created_time: handleCreateIntrinsicDefinition,
      date: handleCreateDateDefinition,
      date_range: handleCreateDateRangeDefinition,
      email: handleCreateEmailDefinition,
      last_edited_by: handleCreateIntrinsicDefinition,
      last_edited_time: handleCreateIntrinsicDefinition,
      number: handleCreateNumberDefinition,
      phone: handleCreatePhoneDefinition,
      text: handleCreateTextDefinition,
      url: handleCreateUrlDefinition,
    } satisfies Record<
      TaskPropertyDefinitionDraft['datatype'],
      (input: TaskPropertyDefinitionDraft) => Promise<void>
    >;

    return handlers[draft.datatype](draft);
  };

  const refreshTaskPropertyWorkspace = async (
    collectionId: string,
    headers: Readonly<Record<string, string>>,
  ) => {
    const workspace = await runEffectRequest(
      getTaskPropertyWorkspace(collectionId, {
        browserTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        headers,
      }),
    );
    setOpenedTaskPropertyWorkspace(workspace);
  };

  const handleDuplicatePropertyDefinition = async (
    draft: DuplicateTaskPropertyDefinitionActionPayload,
    idempotencyKey: string,
  ) => {
    const operationContextToken = await loadTicketingOperationContextToken();
    const headers = { 'x-ontos-operation-context': operationContextToken };
    await runEffectRequest(
      runDuplicateTaskPropertyDefinitionAction(draft, { headers, idempotencyKey }),
    );
    await refreshTaskPropertyWorkspace(draft.collectionId, headers);
  };

  const handleLoadPropertyDeletionImpact = async (
    collectionId: string,
    propertyDefinitionId: string,
  ) => {
    const operationContextToken = await loadTicketingOperationContextToken();
    return runEffectRequest(
      getTaskPropertyDeletionImpact(collectionId, propertyDefinitionId, {
        headers: { 'x-ontos-operation-context': operationContextToken },
      }),
    );
  };

  const handleDeletePropertyDefinition = async (
    draft: DeleteTaskPropertyDefinitionActionPayload,
    idempotencyKey: string,
  ) => {
    const operationContextToken = await loadTicketingOperationContextToken();
    const headers = { 'x-ontos-operation-context': operationContextToken };
    await runEffectRequest(
      runDeleteTaskPropertyDefinitionAction(draft, { headers, idempotencyKey }),
    );
    await refreshTaskPropertyWorkspace(draft.collectionId, headers);
  };

  return (
    <main className="ticketing:min-h-screen ticketing:bg-um-canvas ticketing:px-4 ticketing:py-6 ticketing:text-um-foreground ticketing:sm:px-8">
      <nav aria-label={t('ticketing.language.switcher')} className="ticketing:flex ticketing:gap-3">
        {supportedLanguages.map((code) => (
          <Link
            aria-current={language === code ? 'page' : undefined}
            className="ticketing:rounded-full ticketing:border ticketing:border-stone-900/15 ticketing:bg-white ticketing:px-4 ticketing:py-2 ticketing:text-sm ticketing:font-bold ticketing:text-stone-950 ticketing:no-underline"
            key={code}
            params={{ lang: code }}
            to="/$lang"
          >
            {t(`ticketing.language.${code}`)}
          </Link>
        ))}
      </nav>
      <h1 className="ticketing:mt-10 ticketing:text-5xl ticketing:font-black">
        {t('ticketing.title')}
      </h1>
      <p
        className="ticketing:mt-3 ticketing:text-lg ticketing:text-stone-600"
        data-modern-mf-role="vertical"
      >
        {t('ticketing.role')}
      </p>
      <p
        className="ticketing:sr-only"
        data-build-marker={ultramodernUiMarker.build}
        data-testid="ultramodern-ui-marker"
      >
        {ultramodernUiMarker.appId}:{ultramodernUiMarker.version}
      </p>
      <form
        className="ticketing:mt-8 ticketing:grid ticketing:max-w-md ticketing:gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void handleCreateTask();
        }}
      >
        <FormInput
          disabled={
            isCreatingTask ||
            pendingTaskCollection !== undefined ||
            pendingTaskCollectionReadId !== undefined
          }
          helpText={t('ticketing.taskCollection.nameHelp')}
          id="task-collection-name"
          label={t('ticketing.taskCollection.name')}
          name="task-collection-name"
          onChange={(event) => {
            setCollectionName(event.target.value);
            setFormIdempotencyKey(crypto.randomUUID());
          }}
          required
          value={collectionName}
        />
        <Button
          disabled={collectionName.trim().length === 0 || isCreatingTask}
          isLoading={isCreatingTask}
          loadingText={t('ticketing.taskCollection.creating')}
          type="submit"
        >
          {t('ticketing.taskCollection.create')}
        </Button>
      </form>
      {openedTaskCollection === undefined ? null : (
        <section
          aria-label={t('ticketing.taskCollection.openedTask')}
          className="ticketing:mt-8 ticketing:max-w-2xl ticketing:rounded-2xl ticketing:bg-white ticketing:p-6 ticketing:shadow-xl ticketing:shadow-stone-900/10"
        >
          <h2 className="ticketing:mb-6 ticketing:text-2xl ticketing:font-bold">
            {openedTaskCollection.collection.name}
          </h2>
          <FormInput
            disabled
            id={`task-title-${openedTaskCollection.task.taskId}`}
            label={t('ticketing.taskCollection.title')}
            name="title"
            value={openedTaskCollection.task.title}
          />
          <div className="ticketing:mt-6">
            <TaskPropertyDefinitionForm onCreate={handleCreatePropertyDefinition} />
          </div>
          {openedTaskPropertyWorkspace === undefined ? null : (
            <div className="ticketing:mt-6 ticketing:grid ticketing:gap-4">
              {/* oxlint-disable eslint/complexity -- The integration-base datatype renderer is already above the generic threshold; Date follows the same dispatch seam. */}
              {openedTaskPropertyWorkspace.propertyDefinitions.map((definition) => {
                if (definition.hidden) {
                  return null;
                }
                const [task] = openedTaskPropertyWorkspace.tasks;
                if (task === undefined) {
                  return null;
                }
                const withDefinitionActions = (editor: ReactNode) => (
                  <div
                    className="ticketing:grid ticketing:gap-2"
                    key={definition.propertyDefinitionId}
                  >
                    {editor ?? (
                      <p>
                        <span className="ticketing:font-bold">{definition.name}</span>{' '}
                        <span>
                          ({t(`ticketing.propertyDefinition.types.${definition.datatype}`)})
                        </span>
                      </p>
                    )}
                    <TaskPropertyDefinitionActions
                      canDuplicate={definition.datatype !== 'id'}
                      collectionId={openedTaskPropertyWorkspace.collectionId}
                      disabled={!canEditTaskPropertyDefinitions}
                      label={definition.name}
                      onDelete={handleDeletePropertyDefinition}
                      onDuplicate={handleDuplicatePropertyDefinition}
                      onLoadDeletionImpact={() =>
                        handleLoadPropertyDeletionImpact(
                          openedTaskPropertyWorkspace.collectionId,
                          definition.propertyDefinitionId,
                        )
                      }
                      propertyDefinitionId={definition.propertyDefinitionId}
                      revision={definition.revision}
                      valueCopyPolicy={getTaskPropertyDefinitionValueCopyPolicy(
                        definition.datatype,
                      )}
                    />
                  </div>
                );
                if (definition.datatype === 'date') {
                  const value = task.dateValues.find(
                    (candidate) =>
                      candidate.propertyDefinitionId === definition.propertyDefinitionId,
                  );
                  return withDefinitionActions(
                    <DatePropertyEditor
                      collectionId={openedTaskPropertyWorkspace.collectionId}
                      key={definition.propertyDefinitionId}
                      label={definition.name}
                      locale={datePropertyLocaleByLanguage[language] ?? defaultDatePropertyLocale}
                      onSave={async (draft, idempotencyKey) => {
                        const operationContextToken = await loadTicketingOperationContextToken();
                        const outcome = await runEffectRequest(
                          runUpdateDatePropertyValueAction(draft, {
                            headers: { 'x-ontos-operation-context': operationContextToken },
                            idempotencyKey,
                          }),
                        );
                        setOpenedTaskPropertyWorkspace((current) =>
                          current === undefined
                            ? current
                            : {
                                ...current,
                                tasks: current.tasks.map((candidate) => {
                                  if (candidate.taskId !== draft.taskId) {
                                    return candidate;
                                  }
                                  const withoutCurrent = candidate.dateValues.filter(
                                    (dateValue) =>
                                      dateValue.propertyDefinitionId !== draft.propertyDefinitionId,
                                  );
                                  return {
                                    ...candidate,
                                    dateValues:
                                      outcome.response.value === null
                                        ? withoutCurrent
                                        : [...withoutCurrent, outcome.response.value],
                                    taskRevision: outcome.response.taskRevision,
                                  };
                                }),
                              },
                        );
                        return outcome.response;
                      }}
                      propertyDefinitionId={definition.propertyDefinitionId}
                      readOnly={!canEditTaskPropertyValues}
                      revision={value?.revision ?? 0}
                      taskId={task.taskId}
                      value={value?.value ?? null}
                    />,
                  );
                }
                if (definition.datatype === 'date_range') {
                  const value = task.dateRangeValues.find(
                    (candidate) =>
                      candidate.propertyDefinitionId === definition.propertyDefinitionId,
                  );
                  const affectedValueCount = openedTaskPropertyWorkspace.tasks.filter(
                    (candidate) => {
                      const range = candidate.dateRangeValues.find(
                        (dateRangeValue) =>
                          dateRangeValue.propertyDefinitionId === definition.propertyDefinitionId,
                      )?.value;
                      return range?.startTime !== null && range?.startTime !== undefined;
                    },
                  ).length;
                  return withDefinitionActions(
                    <div key={definition.propertyDefinitionId}>
                      <DateRangeTimeSupportControl
                        affectedValueCount={affectedValueCount}
                        disabled={!canEditTaskPropertyDefinitions}
                        onConfigure={async (timeEnabled, confirmed, expectedAffectedValueCount) => {
                          const operationContextToken = await loadTicketingOperationContextToken();
                          const headers = {
                            'x-ontos-operation-context': operationContextToken,
                          };
                          await runEffectRequest(
                            runConfigureDateRangeTimeSupportAction(
                              {
                                collectionId: openedTaskPropertyWorkspace.collectionId,
                                confirmed,
                                expectedAffectedValueCount,
                                expectedRevision: definition.revision,
                                propertyDefinitionId: definition.propertyDefinitionId,
                                timeEnabled,
                              },
                              { headers, idempotencyKey: crypto.randomUUID() },
                            ),
                          );
                          setOpenedTaskPropertyWorkspace(
                            await runEffectRequest(
                              getTaskPropertyWorkspace(openedTaskPropertyWorkspace.collectionId, {
                                headers,
                              }),
                            ),
                          );
                        }}
                        timeEnabled={definition.timeEnabled}
                      />
                      <DateRangePropertyEditor
                        collectionId={openedTaskPropertyWorkspace.collectionId}
                        label={definition.name}
                        onSave={async (draft, idempotencyKey) => {
                          const operationContextToken = await loadTicketingOperationContextToken();
                          const outcome = await runEffectRequest(
                            runUpdateDateRangePropertyValueAction(draft, {
                              headers: { 'x-ontos-operation-context': operationContextToken },
                              idempotencyKey,
                            }),
                          );
                          setOpenedTaskPropertyWorkspace((current) =>
                            current === undefined
                              ? current
                              : {
                                  ...current,
                                  tasks: current.tasks.map((candidate) => {
                                    if (candidate.taskId !== draft.taskId) {
                                      return candidate;
                                    }
                                    const withoutCurrent = candidate.dateRangeValues.filter(
                                      (dateRangeValue) =>
                                        dateRangeValue.propertyDefinitionId !==
                                        draft.propertyDefinitionId,
                                    );
                                    return {
                                      ...candidate,
                                      dateRangeValues:
                                        outcome.response.value === null
                                          ? withoutCurrent
                                          : [...withoutCurrent, outcome.response.value],
                                      taskRevision: outcome.response.taskRevision,
                                    };
                                  }),
                                },
                          );
                          return outcome.response;
                        }}
                        propertyDefinitionId={definition.propertyDefinitionId}
                        readOnly={!canEditTaskPropertyValues}
                        revision={value?.revision ?? 0}
                        taskId={task.taskId}
                        timeEnabled={definition.timeEnabled}
                        value={value?.value ?? null}
                      />
                    </div>,
                  );
                }
                if (definition.datatype === 'created_time') {
                  return withDefinitionActions(
                    task.createdAt === undefined ||
                      openedTaskPropertyWorkspace.effectiveTimeZone === undefined ? null : (
                      <div key={definition.propertyDefinitionId}>
                        <span className="ticketing:font-bold">{definition.name}: </span>
                        <CreatedTimePresentation
                          detail={false}
                          instant={task.createdAt}
                          locale={language}
                          timeZone={openedTaskPropertyWorkspace.effectiveTimeZone.timeZone}
                        />
                        <details>
                          <summary>{t('ticketing.intrinsic.created_time.details')}</summary>
                          <CreatedTimePresentation
                            detail
                            instant={task.createdAt}
                            locale={language}
                            timeZone={openedTaskPropertyWorkspace.effectiveTimeZone.timeZone}
                          />
                        </details>
                      </div>
                    ),
                  );
                }
                if (definition.datatype === 'created_by') {
                  return withDefinitionActions(
                    task.createdBy === undefined ? null : (
                      <div key={definition.propertyDefinitionId}>
                        <span className="ticketing:font-bold">{definition.name}: </span>
                        <CreatedByPresentation
                          displayName={task.createdBy.displayName}
                          inactive={task.createdBy.inactive}
                          inactiveLabel={t('ticketing.intrinsic.inactive')}
                        />
                      </div>
                    ),
                  );
                }
                if (definition.datatype === 'last_edited_time') {
                  return withDefinitionActions(
                    task.lastEditedAt === undefined ||
                      openedTaskPropertyWorkspace.effectiveTimeZone === undefined ? null : (
                      <div key={definition.propertyDefinitionId}>
                        <span className="ticketing:font-bold">{definition.name}: </span>
                        <LastEditedTimePresentation
                          detail={false}
                          instant={task.lastEditedAt}
                          locale={language}
                          timeZone={openedTaskPropertyWorkspace.effectiveTimeZone.timeZone}
                        />
                        <details>
                          <summary>{t('ticketing.intrinsic.last_edited_time.details')}</summary>
                          <LastEditedTimePresentation
                            detail
                            instant={task.lastEditedAt}
                            locale={language}
                            timeZone={openedTaskPropertyWorkspace.effectiveTimeZone.timeZone}
                          />
                        </details>
                      </div>
                    ),
                  );
                }
                if (definition.datatype === 'last_edited_by') {
                  return withDefinitionActions(
                    task.lastEditedBy === undefined ? null : (
                      <div key={definition.propertyDefinitionId}>
                        <span className="ticketing:font-bold">{definition.name}: </span>
                        <LastEditedByPresentation
                          displayName={task.lastEditedBy.displayName}
                          inactive={task.lastEditedBy.inactive}
                          inactiveLabel={t('ticketing.intrinsic.inactive')}
                        />
                      </div>
                    ),
                  );
                }
                if (definition.datatype === 'phone') {
                  const phoneValue = task.phoneValues.find(
                    (candidate) =>
                      candidate.propertyDefinitionId === definition.propertyDefinitionId,
                  );
                  return withDefinitionActions(
                    <PhonePropertyEditor
                      collectionId={openedTaskPropertyWorkspace.collectionId}
                      key={definition.propertyDefinitionId}
                      label={definition.name}
                      onSave={async (draft, idempotencyKey) => {
                        const operationContextToken = await loadTicketingOperationContextToken();
                        const outcome = await runEffectRequest(
                          runUpdatePhonePropertyValueAction(draft, {
                            headers: { 'x-ontos-operation-context': operationContextToken },
                            idempotencyKey,
                          }),
                        );
                        setOpenedTaskPropertyWorkspace((current) =>
                          current === undefined
                            ? current
                            : {
                                ...current,
                                tasks: current.tasks.map((candidate) => {
                                  if (candidate.taskId !== draft.taskId) {
                                    return candidate;
                                  }
                                  const otherValues = candidate.phoneValues.filter(
                                    (value) =>
                                      value.propertyDefinitionId !== draft.propertyDefinitionId,
                                  );
                                  return {
                                    ...candidate,
                                    phoneValues:
                                      outcome.response.value === null
                                        ? otherValues
                                        : [...otherValues, outcome.response.value],
                                    taskRevision: outcome.response.taskRevision,
                                  };
                                }),
                              },
                        );
                        return outcome.response;
                      }}
                      propertyDefinitionId={definition.propertyDefinitionId}
                      readOnly={!canEditTaskPropertyValues}
                      revision={phoneValue?.revision ?? 0}
                      taskId={task.taskId}
                      value={phoneValue?.value ?? null}
                    />,
                  );
                }
                if (definition.datatype === 'email') {
                  const emailValue = task.emailValues.find(
                    (candidate) =>
                      candidate.propertyDefinitionId === definition.propertyDefinitionId,
                  );
                  return withDefinitionActions(
                    <EmailPropertyEditor
                      collectionId={openedTaskPropertyWorkspace.collectionId}
                      key={definition.propertyDefinitionId}
                      label={definition.name}
                      onSave={async (draft, idempotencyKey) => {
                        const operationContextToken = await loadTicketingOperationContextToken();
                        const outcome = await runEffectRequest(
                          runUpdateEmailPropertyValueAction(draft, {
                            headers: { 'x-ontos-operation-context': operationContextToken },
                            idempotencyKey,
                          }),
                        );
                        setOpenedTaskPropertyWorkspace((current) =>
                          current === undefined
                            ? current
                            : {
                                ...current,
                                tasks: current.tasks.map((candidate) =>
                                  candidate.taskId === draft.taskId
                                    ? {
                                        ...candidate,
                                        emailValues: [
                                          ...candidate.emailValues.filter(
                                            ({ propertyDefinitionId }) =>
                                              propertyDefinitionId !== draft.propertyDefinitionId,
                                          ),
                                          outcome.response.value,
                                        ],
                                        taskRevision: outcome.response.taskRevision,
                                      }
                                    : candidate,
                                ),
                              },
                        );
                        return outcome.response;
                      }}
                      propertyDefinitionId={definition.propertyDefinitionId}
                      readOnly={!canEditTaskPropertyValues}
                      revision={emailValue?.revision ?? 0}
                      taskId={task.taskId}
                      value={emailValue?.value ?? null}
                    />,
                  );
                }
                if (definition.datatype === 'number') {
                  const value = (task.numberValues ?? []).find(
                    (candidate) =>
                      candidate.propertyDefinitionId === definition.propertyDefinitionId,
                  ) ?? {
                    propertyDefinitionId: definition.propertyDefinitionId,
                    revision: 0,
                    value: null,
                  };
                  return withDefinitionActions(
                    <NumberPropertyEditor
                      collectionId={openedTaskPropertyWorkspace.collectionId}
                      format={definition.format}
                      key={definition.propertyDefinitionId}
                      label={definition.name}
                      locale={language}
                      onSave={async (draft, idempotencyKey) => {
                        const operationContextToken = await loadTicketingOperationContextToken();
                        const outcome = await runEffectRequest(
                          runUpdateNumberPropertyValueAction(draft, {
                            headers: { 'x-ontos-operation-context': operationContextToken },
                            idempotencyKey,
                          }),
                        );
                        setOpenedTaskPropertyWorkspace((current) =>
                          current === undefined
                            ? current
                            : {
                                ...current,
                                tasks: current.tasks.map((candidate) =>
                                  candidate.taskId === draft.taskId
                                    ? {
                                        ...candidate,
                                        numberValues: [
                                          ...(candidate.numberValues ?? []).filter(
                                            (numberValue) =>
                                              numberValue.propertyDefinitionId !==
                                              draft.propertyDefinitionId,
                                          ),
                                          outcome.response.value,
                                        ],
                                        taskRevision: outcome.response.taskRevision,
                                      }
                                    : candidate,
                                ),
                              },
                        );
                        return outcome.response;
                      }}
                      propertyDefinitionId={definition.propertyDefinitionId}
                      readOnly={!canEditTaskPropertyValues}
                      revision={value.revision}
                      taskId={task.taskId}
                      value={value.value}
                    />,
                  );
                }
                if (definition.datatype === 'text') {
                  const value = task?.textValues?.find(
                    (candidate) =>
                      candidate.propertyDefinitionId === definition.propertyDefinitionId,
                  );
                  return withDefinitionActions(
                    value === undefined ? null : (
                      <TextPropertyEditor
                        collectionId={openedTaskPropertyWorkspace.collectionId}
                        document={value.document}
                        label={definition.name}
                        onDiscoverReferences={async (query) => {
                          const operationContextToken = await loadTicketingOperationContextToken();
                          const response = await runEffectRequest(
                            executeCoreReference(
                              { operation: 'discover', query },
                              {
                                headers: {
                                  'x-ontos-operation-context': operationContextToken,
                                },
                              },
                            ),
                          );
                          return response.operation === 'discover' ? response.references : [];
                        }}
                        onInsertReference={async ({ kind, source }) => {
                          const operationContextToken = await loadTicketingOperationContextToken();
                          const response = await runEffectRequest(
                            executeCoreReference(
                              { kind, operation: 'insert', source },
                              {
                                headers: {
                                  'x-ontos-operation-context': operationContextToken,
                                },
                              },
                            ),
                          );
                          if (response.operation !== 'insert') {
                            throw new Error(
                              'Core Reference insertion returned an invalid response.',
                            );
                          }
                          return response.result;
                        }}
                        onOpenReference={async (reference) => {
                          const operationContextToken = await loadTicketingOperationContextToken();
                          const response = await runEffectRequest(
                            executeCoreReference(
                              { operation: 'open', reference },
                              {
                                headers: {
                                  'x-ontos-operation-context': operationContextToken,
                                },
                              },
                            ),
                          );
                          if (response.operation !== 'open') {
                            throw new Error('Core Reference open returned an invalid response.');
                          }
                          return response.result;
                        }}
                        onResolveReference={async (reference) => {
                          const operationContextToken = await loadTicketingOperationContextToken();
                          const response = await runEffectRequest(
                            executeCoreReference(
                              { operation: 'resolve', reference },
                              {
                                headers: {
                                  'x-ontos-operation-context': operationContextToken,
                                },
                              },
                            ),
                          );
                          if (response.operation !== 'resolve') {
                            throw new Error(
                              'Core Reference resolution returned an invalid response.',
                            );
                          }
                          if (
                            response.result._tag === 'CoreReferenceActive' &&
                            response.result.reference.lastResolvedLabel !==
                              reference.lastResolvedLabel
                          ) {
                            await runEffectRequest(
                              runRetainTextCoreReferenceLabelAction(
                                {
                                  collectionId: openedTaskPropertyWorkspace.collectionId,
                                  propertyDefinitionId: definition.propertyDefinitionId,
                                  reference,
                                  taskId: task.taskId,
                                },
                                {
                                  headers: {
                                    'x-ontos-operation-context': operationContextToken,
                                  },
                                },
                              ),
                            );
                          }
                          return response.result;
                        }}
                        onSave={async (draft, idempotencyKey) => {
                          const operationContextToken = await loadTicketingOperationContextToken();
                          const outcome = await runEffectRequest(
                            runUpdateTextPropertyValueAction(draft, {
                              headers: { 'x-ontos-operation-context': operationContextToken },
                              idempotencyKey,
                            }),
                          );
                          setOpenedTaskPropertyWorkspace((current) =>
                            current === undefined
                              ? current
                              : {
                                  ...current,
                                  tasks: current.tasks.map((candidate) =>
                                    candidate.taskId === draft.taskId
                                      ? {
                                          ...candidate,
                                          taskRevision: outcome.response.taskRevision,
                                          textValues: (candidate.textValues ?? []).map(
                                            (textValue) =>
                                              textValue.propertyDefinitionId ===
                                              draft.propertyDefinitionId
                                                ? outcome.response.value
                                                : textValue,
                                          ),
                                        }
                                      : candidate,
                                  ),
                                },
                          );
                          return outcome.response;
                        }}
                        propertyDefinitionId={definition.propertyDefinitionId}
                        readOnly={!canEditTaskPropertyValues}
                        revision={value.revision}
                        taskId={task.taskId}
                      />
                    ),
                  );
                }
                if (definition.datatype === 'url') {
                  const value = task?.urlValues?.find(
                    (candidate) =>
                      candidate.propertyDefinitionId === definition.propertyDefinitionId,
                  );
                  return withDefinitionActions(
                    value === undefined ? null : (
                      <UrlPropertyEditor
                        collectionId={openedTaskPropertyWorkspace.collectionId}
                        key={definition.propertyDefinitionId}
                        label={definition.name}
                        mandatory={definition.mandatory}
                        onSave={async (draft, idempotencyKey) => {
                          const operationContextToken = await loadTicketingOperationContextToken();
                          const outcome = await runEffectRequest(
                            runUpdateUrlPropertyValueAction(draft, {
                              headers: { 'x-ontos-operation-context': operationContextToken },
                              idempotencyKey,
                            }),
                          );
                          setOpenedTaskPropertyWorkspace((current) =>
                            current === undefined
                              ? current
                              : {
                                  ...current,
                                  tasks: current.tasks.map((candidate) =>
                                    candidate.taskId === draft.taskId
                                      ? {
                                          ...candidate,
                                          taskRevision: outcome.response.taskRevision,
                                          urlValues: candidate.urlValues?.map((urlValue) =>
                                            urlValue.propertyDefinitionId ===
                                            draft.propertyDefinitionId
                                              ? outcome.response.value
                                              : urlValue,
                                          ),
                                        }
                                      : candidate,
                                  ),
                                },
                          );
                          return outcome.response;
                        }}
                        propertyDefinitionId={definition.propertyDefinitionId}
                        readOnly={!canEditTaskPropertyValues}
                        revision={value.revision}
                        taskId={task.taskId}
                        value={value.value}
                      />
                    ),
                  );
                }
                if (definition.datatype !== 'checkbox') {
                  return withDefinitionActions(null);
                }
                const value = task?.checkboxValues.find(
                  (candidate) => candidate.propertyDefinitionId === definition.propertyDefinitionId,
                );
                return withDefinitionActions(
                  value === undefined ? null : (
                    <CheckboxPropertyEditor
                      collectionId={openedTaskPropertyWorkspace.collectionId}
                      key={definition.propertyDefinitionId}
                      label={definition.name}
                      onSave={async (draft, idempotencyKey) => {
                        const operationContextToken = await loadTicketingOperationContextToken();
                        const outcome = await runEffectRequest(
                          runUpdateCheckboxPropertyValueAction(draft, {
                            headers: { 'x-ontos-operation-context': operationContextToken },
                            idempotencyKey,
                          }),
                        );
                        setOpenedTaskPropertyWorkspace((current) =>
                          current === undefined
                            ? current
                            : {
                                ...current,
                                tasks: current.tasks.map((candidate) =>
                                  candidate.taskId === draft.taskId
                                    ? {
                                        ...candidate,
                                        checkboxValues: candidate.checkboxValues.map(
                                          (checkboxValue) =>
                                            checkboxValue.propertyDefinitionId ===
                                            draft.propertyDefinitionId
                                              ? outcome.response.value
                                              : checkboxValue,
                                        ),
                                        taskRevision: outcome.response.taskRevision,
                                      }
                                    : candidate,
                                ),
                              },
                        );
                        return outcome.response;
                      }}
                      propertyDefinitionId={definition.propertyDefinitionId}
                      readOnly={!canEditTaskPropertyValues}
                      revision={value.revision}
                      taskId={task.taskId}
                      value={value.value}
                    />
                  ),
                );
              })}
              {/* oxlint-enable eslint/complexity */}
            </div>
          )}
        </section>
      )}
    </main>
  );
};
