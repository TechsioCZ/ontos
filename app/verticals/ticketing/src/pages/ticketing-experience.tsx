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
  runCreateTicketAction,
  runEffectRequest,
} from '../api/ticketing-client';
import { ultramodernUiMarker } from '../ultramodern-build';
import type { CreateTicketActionFailure } from '../../shared/actions/create-ticket';
import type { TaskCollectionAggregate } from '../../shared/task-collection';

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

const isCreateTicketActionFailure = (error: unknown): error is CreateTicketActionFailure =>
  typeof error === 'object' &&
  error !== null &&
  'ok' in error &&
  error.ok === false &&
  'message' in error &&
  typeof error.message === 'string';

export const TicketingExperience = () => {
  const { language, supportedLanguages, t } = useModernI18n();
  const [createTaskCollectionIntentId, setCreateTaskCollectionIntentId] = useState(() =>
    crypto.randomUUID(),
  );
  const [openedTaskCollection, setOpenedTaskCollection] = useState<TaskCollectionAggregate>();
  const [isCreatingTicket, setIsCreatingTicket] = useState(false);

  const handleCreateTicket = async () => {
    setIsCreatingTicket(true);

    try {
      const operationContextToken = await loadTicketingOperationContextToken();
      const headers = {
        'x-ontos-operation-context': operationContextToken,
      };
      await runEffectRequest(
        runCreateTicketAction(
          {
            collectionId: createTaskCollectionIntentId,
          },
          {
            headers,
            idempotencyKey: createTaskCollectionIntentId,
          },
        ).pipe(
          Effect.flatMap((outcome) =>
            getTaskCollection(outcome.response.collection.collectionId, { headers }),
          ),
          Effect.match({
            onFailure: (error) => {
              toaster.create(
                isCreateTicketActionFailure(error)
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
              setCreateTaskCollectionIntentId(crypto.randomUUID());
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
      setIsCreatingTicket(false);
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
          isLoading={isCreatingTicket}
          loadingText={t('ticketing.taskCollection.creating')}
          onClick={() => void handleCreateTicket()}
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
        </section>
      )}
    </main>
  );
};
