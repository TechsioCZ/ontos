// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off globalFetch:off
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { toaster } from '@techsio/ui-kit/molecules/toast';
import { useState } from 'react';
import {
  Effect,
  getTaskCollection,
  runCreateCheckboxPropertyDefinitionAction,
  runCreatePhonePropertyDefinitionAction,
  runCreateTaskAction,
  runCreateTaskCollectionAction,
  runEffectRequest,
  runUpdateCheckboxPropertyValueAction,
  runUpdatePhonePropertyValueAction,
} from '../api/ticketing-client';
import { ultramodernUiMarker } from '../ultramodern-build';
import { CheckboxPropertyEditor } from '../components/checkbox-property-editor';
import { PhonePropertyEditor } from '../components/phone-property-editor';
import type { CreateTaskActionFailure } from '../../shared/actions/create-task';
import type { CreateTaskCollectionActionFailure } from '../../shared/actions/create-task-collection';
import type { TaskCollectionAggregate, TaskCollectionCreation } from '../../shared/task-collection';
import type { TaskPropertyWorkspace } from '../../shared/task-property-workspace';

interface ShellOperationContextResponse {
  readonly verticalGatewayTokens?: Readonly<Record<string, string>>;
}

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
  const [formIdempotencyKey, setFormIdempotencyKey] = useState(() => crypto.randomUUID());
  const [pendingTaskCollection, setPendingTaskCollection] = useState<TaskCollectionCreation>();
  const [pendingTaskCollectionReadId, setPendingTaskCollectionReadId] = useState<string>();
  const [openedTaskCollection, setOpenedTaskCollection] = useState<TaskCollectionAggregate>();
  const [openedTaskPropertyWorkspace, setOpenedTaskPropertyWorkspace] =
    useState<TaskPropertyWorkspace>();
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [checkboxDefinitionName, setCheckboxDefinitionName] = useState('');
  const [checkboxDefinitionIdempotencyKey, setCheckboxDefinitionIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  );
  const [isCreatingCheckboxDefinition, setIsCreatingCheckboxDefinition] = useState(false);
  const [phoneDefinitionName, setPhoneDefinitionName] = useState('');
  const [phoneDefinitionIdempotencyKey, setPhoneDefinitionIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  );
  const [isCreatingPhoneDefinition, setIsCreatingPhoneDefinition] = useState(false);

  const handleCreateTask = async () => {
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
                  {},
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
              setCheckboxDefinitionName('');
              setCheckboxDefinitionIdempotencyKey(crypto.randomUUID());
              setPhoneDefinitionName('');
              setPhoneDefinitionIdempotencyKey(crypto.randomUUID());
              setOpenedTaskPropertyWorkspace({
                collectionId: taskCollection.collection.collectionId,
                propertyDefinitions: [],
                tasks: [
                  {
                    checkboxValues: [],
                    phoneValues: [],
                    taskId: taskCollection.task.taskId,
                    taskRevision: taskCollection.task.revision,
                    title: taskCollection.task.title,
                  },
                ],
              });
              setPendingTaskCollection(undefined);
              setPendingTaskCollectionReadId(undefined);
              setFormIdempotencyKey(crypto.randomUUID());
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

  const handleCreateCheckboxDefinition = async () => {
    if (openedTaskPropertyWorkspace === undefined || checkboxDefinitionName.trim().length === 0) {
      return;
    }
    setIsCreatingCheckboxDefinition(true);

    try {
      const operationContextToken = await loadTicketingOperationContextToken();
      const outcome = await runEffectRequest(
        runCreateCheckboxPropertyDefinitionAction(
          {
            collectionId: openedTaskPropertyWorkspace.collectionId,
            mandatory: false,
            name: checkboxDefinitionName,
          },
          {
            headers: { 'x-ontos-operation-context': operationContextToken },
            idempotencyKey: checkboxDefinitionIdempotencyKey,
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
      setCheckboxDefinitionName('');
      setCheckboxDefinitionIdempotencyKey(crypto.randomUUID());
    } catch (error) {
      toaster.create({
        description:
          error instanceof Error
            ? error.message
            : t('ticketing.checkbox.definitionCreateFailedDescription'),
        title: t('ticketing.checkbox.definitionCreateFailedTitle'),
        type: 'error',
      });
    } finally {
      setIsCreatingCheckboxDefinition(false);
    }
  };

  const handleCreatePhoneDefinition = async () => {
    if (openedTaskPropertyWorkspace === undefined || phoneDefinitionName.trim().length === 0) {
      return;
    }
    setIsCreatingPhoneDefinition(true);

    try {
      const operationContextToken = await loadTicketingOperationContextToken();
      const outcome = await runEffectRequest(
        runCreatePhonePropertyDefinitionAction(
          {
            collectionId: openedTaskPropertyWorkspace.collectionId,
            mandatory: false,
            name: phoneDefinitionName,
          },
          {
            headers: { 'x-ontos-operation-context': operationContextToken },
            idempotencyKey: phoneDefinitionIdempotencyKey,
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
      setPhoneDefinitionName('');
      setPhoneDefinitionIdempotencyKey(crypto.randomUUID());
    } catch (error) {
      toaster.create({
        description:
          error instanceof Error
            ? error.message
            : t('ticketing.phone.definitionCreateFailedDescription'),
        title: t('ticketing.phone.definitionCreateFailedTitle'),
        type: 'error',
      });
    } finally {
      setIsCreatingPhoneDefinition(false);
    }
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
      <div className="ticketing:mt-8">
        <Button
          isLoading={isCreatingTask}
          loadingText={t('ticketing.taskCollection.creating')}
          onClick={() => void handleCreateTask()}
          type="button"
        >
          {t('ticketing.taskCollection.create')}
        </Button>
      </div>
      {openedTaskCollection === undefined ? null : (
        <section
          aria-label={t('ticketing.taskCollection.openedTask')}
          className="ticketing:mt-8 ticketing:max-w-2xl ticketing:rounded-2xl ticketing:bg-white ticketing:p-6 ticketing:shadow-xl ticketing:shadow-stone-900/10"
        >
          <FormInput
            disabled
            id={`task-title-${openedTaskCollection.task.taskId}`}
            label={t('ticketing.taskCollection.title')}
            name="title"
            value={openedTaskCollection.task.title}
          />
          <div className="ticketing:mt-6 ticketing:grid ticketing:gap-4">
            <FormInput
              id="checkbox-property-name"
              label={t('ticketing.checkbox.definitionName')}
              name="checkbox-property-name"
              onChange={(event) => setCheckboxDefinitionName(event.currentTarget.value)}
              value={checkboxDefinitionName}
            />
            <Button
              disabled={checkboxDefinitionName.trim().length === 0}
              isLoading={isCreatingCheckboxDefinition}
              loadingText={t('ticketing.checkbox.definitionCreating')}
              onClick={() => void handleCreateCheckboxDefinition()}
              type="button"
              variant="secondary"
            >
              {t('ticketing.checkbox.definitionCreate')}
            </Button>
            <FormInput
              id="phone-property-name"
              label={t('ticketing.phone.definitionName')}
              name="phone-property-name"
              onChange={(event) => setPhoneDefinitionName(event.currentTarget.value)}
              value={phoneDefinitionName}
            />
            <Button
              disabled={phoneDefinitionName.trim().length === 0}
              isLoading={isCreatingPhoneDefinition}
              loadingText={t('ticketing.phone.definitionCreating')}
              onClick={() => void handleCreatePhoneDefinition()}
              type="button"
              variant="secondary"
            >
              {t('ticketing.phone.definitionCreate')}
            </Button>
          </div>
          {openedTaskPropertyWorkspace === undefined ? null : (
            <div className="ticketing:mt-6 ticketing:grid ticketing:gap-4">
              {openedTaskPropertyWorkspace.propertyDefinitions.map((definition) => {
                const [task] = openedTaskPropertyWorkspace.tasks;
                if (task === undefined) {
                  return null;
                }
                if (definition.datatype === 'phone') {
                  const value = task.phoneValues.find(
                    (candidate) =>
                      candidate.propertyDefinitionId === definition.propertyDefinitionId,
                  );
                  return (
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
                                    (phoneValue) =>
                                      phoneValue.propertyDefinitionId !==
                                      draft.propertyDefinitionId,
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
                      revision={value?.revision ?? 0}
                      taskId={task.taskId}
                      value={value?.value ?? null}
                    />
                  );
                }
                const value = task?.checkboxValues.find(
                  (candidate) => candidate.propertyDefinitionId === definition.propertyDefinitionId,
                );
                return value === undefined ? null : (
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
                    revision={value.revision}
                    taskId={task.taskId}
                    value={value.value}
                  />
                );
              })}
            </div>
          )}
        </section>
      )}
    </main>
  );
};
