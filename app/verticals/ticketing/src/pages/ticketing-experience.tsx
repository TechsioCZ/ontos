// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off globalFetch:off
// oxlint-disable eslint/complexity -- The integration-base datatype renderer is already above the generic threshold; Date follows the same dispatch seam.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { toaster } from '@techsio/ui-kit/molecules/toast';
import { useState } from 'react';
import {
  Effect,
  getTaskPropertyEditCapability,
  getTaskCollection,
  runCreateDatePropertyDefinitionAction,
  runCreateCheckboxPropertyDefinitionAction,
  runCreateEmailPropertyDefinitionAction,
  runCreateNumberPropertyDefinitionAction,
  runCreatePhonePropertyDefinitionAction,
  runCreateTextPropertyDefinitionAction,
  runCreateTaskAction,
  runCreateTaskCollectionAction,
  runCreateUrlPropertyDefinitionAction,
  runDuplicateTaskPropertyDefinitionAction,
  runEffectRequest,
  runUpdateCheckboxPropertyValueAction,
  runUpdateDatePropertyValueAction,
  runUpdateEmailPropertyValueAction,
  runUpdateNumberPropertyValueAction,
  runUpdatePhonePropertyValueAction,
  runUpdateTextPropertyValueAction,
  runUpdateUrlPropertyValueAction,
} from '../api/ticketing-client';
import { ultramodernUiMarker } from '../ultramodern-build';
import { CheckboxPropertyEditor } from '../components/checkbox-property-editor';
import { DatePropertyEditor } from '../components/date-property-editor';
import { EmailPropertyEditor } from '../components/email-property-editor';
import { NumberPropertyEditor } from '../components/number-property-editor';
import { PhonePropertyEditor } from '../components/phone-property-editor';
import { TextPropertyEditor } from '../components/text-property-editor';
import { TextPropertyDuplication } from '../components/text-property-duplication';
import { UrlPropertyEditor } from '../components/url-property-editor';
import type { CreateTaskActionFailure } from '../../shared/actions/create-task';
import type { CreateTaskCollectionActionFailure } from '../../shared/actions/create-task-collection';
import type { TaskCollectionAggregate, TaskCollectionCreation } from '../../shared/task-collection';
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
  const [dateDefinitionName, setDateDefinitionName] = useState('');
  const [dateDefinitionIdempotencyKey, setDateDefinitionIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  );
  const [isCreatingDateDefinition, setIsCreatingDateDefinition] = useState(false);
  const [emailDefinitionName, setEmailDefinitionName] = useState('');
  const [emailDefinitionIdempotencyKey, setEmailDefinitionIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  );
  const [isCreatingEmailDefinition, setIsCreatingEmailDefinition] = useState(false);
  const [canEditTaskPropertyValues, setCanEditTaskPropertyValues] = useState(false);
  const [textDefinitionName, setTextDefinitionName] = useState('');
  const [textDefinitionIdempotencyKey, setTextDefinitionIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  );
  const [isCreatingTextDefinition, setIsCreatingTextDefinition] = useState(false);
  const [numberDefinitionName, setNumberDefinitionName] = useState('');
  const [numberDefinitionIdempotencyKey, setNumberDefinitionIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  );
  const [isCreatingNumberDefinition, setIsCreatingNumberDefinition] = useState(false);
  const [phoneDefinitionName, setPhoneDefinitionName] = useState('');
  const [phoneDefinitionIdempotencyKey, setPhoneDefinitionIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  );
  const [isCreatingPhoneDefinition, setIsCreatingPhoneDefinition] = useState(false);
  const [urlDefinitionName, setUrlDefinitionName] = useState('');
  const [urlDefinitionIdempotencyKey, setUrlDefinitionIdempotencyKey] = useState(() =>
    crypto.randomUUID(),
  );
  const [isCreatingUrlDefinition, setIsCreatingUrlDefinition] = useState(false);

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
              setDateDefinitionName('');
              setDateDefinitionIdempotencyKey(crypto.randomUUID());
              setEmailDefinitionName('');
              setEmailDefinitionIdempotencyKey(crypto.randomUUID());
              setNumberDefinitionName('');
              setNumberDefinitionIdempotencyKey(crypto.randomUUID());
              setPhoneDefinitionName('');
              setPhoneDefinitionIdempotencyKey(crypto.randomUUID());
              setUrlDefinitionName('');
              setUrlDefinitionIdempotencyKey(crypto.randomUUID());
              setOpenedTaskPropertyWorkspace({
                collectionId: taskCollection.collection.collectionId,
                propertyDefinitions: [],
                tasks: [
                  {
                    checkboxValues: [],
                    dateValues: [],
                    emailValues: [],
                    numberValues: [],
                    phoneValues: [],
                    selectValues: [],
                    taskId: taskCollection.task.taskId,
                    taskRevision: taskCollection.task.revision,
                    title: taskCollection.task.title,
                    urlValues: [],
                  },
                ],
              });
              setPendingTaskCollection(undefined);
              setPendingTaskCollectionReadId(undefined);
              setFormIdempotencyKey(crypto.randomUUID());
              void runEffectRequest(
                getTaskPropertyEditCapability(taskCollection.collection.collectionId, { headers }),
              )
                .then(({ canEdit }) => setCanEditTaskPropertyValues(canEdit))
                .catch(() => setCanEditTaskPropertyValues(false));
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

  const handleCreateEmailDefinition = async () => {
    if (openedTaskPropertyWorkspace === undefined || emailDefinitionName.trim().length === 0) {
      return;
    }
    setIsCreatingEmailDefinition(true);
    try {
      const operationContextToken = await loadTicketingOperationContextToken();
      const outcome = await runEffectRequest(
        runCreateEmailPropertyDefinitionAction(
          {
            collectionId: openedTaskPropertyWorkspace.collectionId,
            mandatory: false,
            name: emailDefinitionName,
          },
          {
            headers: { 'x-ontos-operation-context': operationContextToken },
            idempotencyKey: emailDefinitionIdempotencyKey,
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
      setEmailDefinitionName('');
      setEmailDefinitionIdempotencyKey(crypto.randomUUID());
    } catch (error) {
      toaster.create({
        description:
          error instanceof Error
            ? error.message
            : t('ticketing.email.definitionCreateFailedDescription'),
        title: t('ticketing.email.definitionCreateFailedTitle'),
        type: 'error',
      });
    } finally {
      setIsCreatingEmailDefinition(false);
    }
  };

  const handleCreateTextDefinition = async () => {
    if (openedTaskPropertyWorkspace === undefined || textDefinitionName.trim().length === 0) {
      return;
    }
    setIsCreatingTextDefinition(true);

    try {
      const operationContextToken = await loadTicketingOperationContextToken();
      const outcome = await runEffectRequest(
        runCreateTextPropertyDefinitionAction(
          {
            collectionId: openedTaskPropertyWorkspace.collectionId,
            mandatory: false,
            name: textDefinitionName,
          },
          {
            headers: { 'x-ontos-operation-context': operationContextToken },
            idempotencyKey: textDefinitionIdempotencyKey,
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
      setTextDefinitionName('');
      setTextDefinitionIdempotencyKey(crypto.randomUUID());
    } catch (error) {
      toaster.create({
        description:
          error instanceof Error
            ? error.message
            : t('ticketing.text.definitionCreateFailedDescription'),
        title: t('ticketing.text.definitionCreateFailedTitle'),
        type: 'error',
      });
    } finally {
      setIsCreatingTextDefinition(false);
    }
  };

  const handleCreateNumberDefinition = async () => {
    if (openedTaskPropertyWorkspace === undefined || numberDefinitionName.trim().length === 0) {
      return;
    }
    setIsCreatingNumberDefinition(true);

    try {
      const operationContextToken = await loadTicketingOperationContextToken();
      const outcome = await runEffectRequest(
        runCreateNumberPropertyDefinitionAction(
          {
            collectionId: openedTaskPropertyWorkspace.collectionId,
            mandatory: false,
            name: numberDefinitionName,
          },
          {
            headers: { 'x-ontos-operation-context': operationContextToken },
            idempotencyKey: numberDefinitionIdempotencyKey,
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
      setNumberDefinitionName('');
      setNumberDefinitionIdempotencyKey(crypto.randomUUID());
    } catch (error) {
      toaster.create({
        description:
          error instanceof Error
            ? error.message
            : t('ticketing.number.definitionCreateFailedDescription'),
        title: t('ticketing.number.definitionCreateFailedTitle'),
        type: 'error',
      });
    } finally {
      setIsCreatingNumberDefinition(false);
    }
  };

  const handleCreateUrlDefinition = async () => {
    if (openedTaskPropertyWorkspace === undefined || urlDefinitionName.trim().length === 0) {
      return;
    }
    setIsCreatingUrlDefinition(true);

    try {
      const operationContextToken = await loadTicketingOperationContextToken();
      const outcome = await runEffectRequest(
        runCreateUrlPropertyDefinitionAction(
          {
            collectionId: openedTaskPropertyWorkspace.collectionId,
            mandatory: false,
            name: urlDefinitionName,
          },
          {
            headers: { 'x-ontos-operation-context': operationContextToken },
            idempotencyKey: urlDefinitionIdempotencyKey,
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
      setUrlDefinitionName('');
      setUrlDefinitionIdempotencyKey(crypto.randomUUID());
    } catch (error) {
      toaster.create({
        description:
          error instanceof Error
            ? error.message
            : t('ticketing.url.definitionCreateFailedDescription'),
        title: t('ticketing.url.definitionCreateFailedTitle'),
        type: 'error',
      });
    } finally {
      setIsCreatingUrlDefinition(false);
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

  const handleCreateDateDefinition = async () => {
    if (openedTaskPropertyWorkspace === undefined || dateDefinitionName.trim().length === 0) {
      return;
    }
    setIsCreatingDateDefinition(true);

    try {
      const operationContextToken = await loadTicketingOperationContextToken();
      const outcome = await runEffectRequest(
        runCreateDatePropertyDefinitionAction(
          {
            collectionId: openedTaskPropertyWorkspace.collectionId,
            mandatory: false,
            name: dateDefinitionName,
          },
          {
            headers: { 'x-ontos-operation-context': operationContextToken },
            idempotencyKey: dateDefinitionIdempotencyKey,
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
      setDateDefinitionName('');
      setDateDefinitionIdempotencyKey(crypto.randomUUID());
    } catch (error) {
      toaster.create({
        description:
          error instanceof Error
            ? error.message
            : t('ticketing.date.definitionCreateFailedDescription'),
        title: t('ticketing.date.definitionCreateFailedTitle'),
        type: 'error',
      });
    } finally {
      setIsCreatingDateDefinition(false);
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
              id="date-property-name"
              label={t('ticketing.date.definitionName')}
              name="date-property-name"
              onChange={(event) => setDateDefinitionName(event.currentTarget.value)}
              value={dateDefinitionName}
            />
            <Button
              disabled={dateDefinitionName.trim().length === 0}
              isLoading={isCreatingDateDefinition}
              loadingText={t('ticketing.date.definitionCreating')}
              onClick={() => void handleCreateDateDefinition()}
              type="button"
              variant="secondary"
            >
              {t('ticketing.date.definitionCreate')}
            </Button>
            <FormInput
              id="email-property-name"
              label={t('ticketing.email.definitionName')}
              name="email-property-name"
              onChange={(event) => setEmailDefinitionName(event.currentTarget.value)}
              value={emailDefinitionName}
            />
            <Button
              disabled={emailDefinitionName.trim().length === 0}
              isLoading={isCreatingEmailDefinition}
              loadingText={t('ticketing.email.definitionCreating')}
              onClick={() => void handleCreateEmailDefinition()}
              type="button"
              variant="secondary"
            >
              {t('ticketing.email.definitionCreate')}
            </Button>
            <FormInput
              id="text-property-name"
              label={t('ticketing.text.definitionName')}
              name="text-property-name"
              onChange={(event) => setTextDefinitionName(event.currentTarget.value)}
              value={textDefinitionName}
            />
            <Button
              disabled={textDefinitionName.trim().length === 0}
              isLoading={isCreatingTextDefinition}
              loadingText={t('ticketing.text.definitionCreating')}
              onClick={() => void handleCreateTextDefinition()}
              type="button"
              variant="secondary"
            >
              {t('ticketing.text.definitionCreate')}
            </Button>
            <FormInput
              id="number-property-name"
              label={t('ticketing.number.definitionName')}
              name="number-property-name"
              onChange={(event) => setNumberDefinitionName(event.currentTarget.value)}
              value={numberDefinitionName}
            />
            <Button
              disabled={numberDefinitionName.trim().length === 0}
              isLoading={isCreatingNumberDefinition}
              loadingText={t('ticketing.number.definitionCreating')}
              onClick={() => void handleCreateNumberDefinition()}
              type="button"
              variant="secondary"
            >
              {t('ticketing.number.definitionCreate')}
            </Button>
            <FormInput
              id="url-property-name"
              label={t('ticketing.url.definitionName')}
              name="url-property-name"
              onChange={(event) => setUrlDefinitionName(event.currentTarget.value)}
              value={urlDefinitionName}
            />
            <Button
              disabled={urlDefinitionName.trim().length === 0}
              isLoading={isCreatingUrlDefinition}
              loadingText={t('ticketing.url.definitionCreating')}
              onClick={() => void handleCreateUrlDefinition()}
              type="button"
              variant="secondary"
            >
              {t('ticketing.url.definitionCreate')}
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
                if (definition.datatype === 'date') {
                  const value = task.dateValues.find(
                    (candidate) =>
                      candidate.propertyDefinitionId === definition.propertyDefinitionId,
                  );
                  return (
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
                      revision={value?.revision ?? 0}
                      taskId={task.taskId}
                      value={value?.value ?? null}
                    />
                  );
                }
                if (definition.datatype === 'phone') {
                  const phoneValue = task.phoneValues.find(
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
                    />
                  );
                }
                if (definition.datatype === 'email') {
                  const emailValue = task.emailValues.find(
                    (candidate) =>
                      candidate.propertyDefinitionId === definition.propertyDefinitionId,
                  );
                  return (
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
                    />
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
                  return (
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
                    />
                  );
                }
                if (definition.datatype === 'text') {
                  const value = task?.textValues?.find(
                    (candidate) =>
                      candidate.propertyDefinitionId === definition.propertyDefinitionId,
                  );
                  return value === undefined ? null : (
                    <div
                      className="ticketing:grid ticketing:gap-2"
                      key={definition.propertyDefinitionId}
                    >
                      <TextPropertyEditor
                        collectionId={openedTaskPropertyWorkspace.collectionId}
                        document={value.document}
                        label={definition.name}
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
                      <TextPropertyDuplication
                        collectionId={openedTaskPropertyWorkspace.collectionId}
                        label={definition.name}
                        onConfirm={async (draft, idempotencyKey) => {
                          const operationContextToken = await loadTicketingOperationContextToken();
                          const outcome = await runEffectRequest(
                            runDuplicateTaskPropertyDefinitionAction(draft, {
                              headers: { 'x-ontos-operation-context': operationContextToken },
                              idempotencyKey,
                            }),
                          );
                          setOpenedTaskPropertyWorkspace((current) =>
                            current === undefined
                              ? current
                              : {
                                  ...current,
                                  propertyDefinitions: [
                                    ...current.propertyDefinitions,
                                    outcome.response.definition,
                                  ],
                                  tasks: current.tasks.map((candidate) => ({
                                    ...candidate,
                                    textValues: [
                                      ...(candidate.textValues ?? []),
                                      {
                                        document: null,
                                        propertyDefinitionId:
                                          outcome.response.definition.propertyDefinitionId,
                                        readableText: null,
                                        revision: 1,
                                      },
                                    ],
                                  })),
                                },
                          );
                        }}
                        propertyDefinitionId={definition.propertyDefinitionId}
                        revision={definition.revision}
                      />
                    </div>
                  );
                }
                if (definition.datatype === 'url') {
                  const value = task?.urlValues?.find(
                    (candidate) =>
                      candidate.propertyDefinitionId === definition.propertyDefinitionId,
                  );
                  return value === undefined ? null : (
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
                    readOnly={!canEditTaskPropertyValues}
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
