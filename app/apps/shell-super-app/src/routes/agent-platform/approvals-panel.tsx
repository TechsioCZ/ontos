import { ChoiceField, EntryTextField, FormBuilder, FormReact, FormRoot, useAtomValue } from '@app/core-runtime/ui/form';
import { Link as LocalizedLink, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Accordion } from '@techsio/ui-kit/molecules/accordion';
import {
  AgentBatchKeySchema,
  AgentItemKeySchema,
  AgentModuleKeySchema,
  agentItemStatusLabel,
  agentRiskLabel,
} from '@app/shared-contracts/agent-proposals';
import type {
  AgentQueueBatch,
  AgentQueueItem,
  AgentQueueRequest,
  AgentPageCursor,
  AgentDecideRequest,
  AgentRevertRequest,
  AgentDecideResponse,
  AgentQueueResponse,
} from '@app/shared-contracts/agent-proposals';
import { pageDataPending } from '@app/shared-contracts/page-data';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Effect, Match, Option, Result, Schema } from 'effect';
import { Url } from 'effect/http';
import type { HttpClient } from 'effect/http';
import type { ComponentProps } from 'react';

import { browserAtomRuntime, browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { ModulePageSkeleton } from '../module-page-skeleton.tsx';
import {
  agentMutationIntent,
  agentMutationUncertain,
  decideAgentItems,
  formatAgentTime,
  revertAgentBatch,
} from './agent-platform-client.ts';
import type { AgentMutationIntent } from './agent-platform-client.ts';
import { agentQueueData } from './platform-page-data.ts';
import { AgentReviewSearchQuerySchema, batchKeyFromSearch, itemKeyFromSearch } from './batch-link.ts';

type Decision = AgentDecideRequest['decision'];
type ReviewIntent =
  | { readonly kind: 'decide'; readonly request: AgentMutationIntent<AgentDecideRequest> }
  | { readonly kind: 'revert'; readonly request: AgentMutationIntent<AgentRevertRequest> };

/** The module the queue shows; `""` is every module. It applies at once, so the form never submits. */
const queueModuleForm = FormReact.make(FormBuilder.empty.addField('moduleKey', Schema.String), {
  fields: { moduleKey: ChoiceField },
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});
const moduleKeyValue = queueModuleForm.getFieldAtoms(queueModuleForm.fields.moduleKey).value;

/**
 * The reviewer's note per batch, keyed by batch key; the decision buttons send it, so the form never submits.
 * Every batch card renders its own entry of the one form.
 */
const batchNotesForm = FormReact.make(
  FormBuilder.empty.addField('notes', Schema.Record(Schema.String, Schema.String)),
  { fields: { notes: EntryTextField }, onSubmit: () => Effect.void, runtime: browserAtomRuntime },
);
const notesValue = batchNotesForm.getFieldAtoms(batchNotesForm.fields.notes).value;
const noNotes: Readonly<Record<string, string>> = {};

/** Neutral outline for settled items; the theme's secondary badge is the brand green and reads as success. */
const itemBadgeVariants = {
  applied: 'success',
  failed: 'danger',
  pending: 'warning',
  rejected: 'neutral',
  revert_failed: 'danger',
  reverted: 'neutral',
} satisfies Readonly<Record<AgentQueueItem['status'], ComponentProps<typeof Badge>['severity']>>;
const queueFailureText = (httpStatus: number): string => {
  if (httpStatus === 401) {
    return 'Přihlaste se prosím znovu.';
  }
  if (httpStatus === 403) {
    return 'Tato stránka je dostupná jen lidem, kteří schvalují změny.';
  }
  return 'Seznam návrhů se nepodařilo načíst.';
};

const commandJson = Schema.encodeResult(Schema.fromJsonString(Schema.Json));
const commandValue = (value: Schema.Json): string =>
  Schema.is(Schema.String)(value)
    ? value
    : Result.match(commandJson(value), {
        onFailure: () => 'Příkaz nelze zobrazit.',
        onSuccess: (text) => text,
      });

/** The exact command an approval runs; open by default when the lines above are only the agent's description. */
const CommandDetails = ({
  command,
  open,
}: {
  readonly command: NonNullable<AgentQueueItem['command']>;
  readonly open: boolean;
}) => (
  <Accordion appearance="ghost" className="text-xs" collapsible defaultValue={open ? ['command'] : []} size="sm">
    <Accordion.Item value="command">
      <Accordion.Header aria-level={4}>
        <Accordion.Title className="text-fg-secondary">Přesný příkaz pro modul</Accordion.Title>
        <Accordion.Indicator />
      </Accordion.Header>
      <Accordion.Content>
        <dl className="mt-2 grid gap-1 text-xs">
          {Object.entries(command)
            .toSorted(([left], [right]) => Number(right === '_tag') - Number(left === '_tag'))
            .map(([field, value]) => (
              <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]" key={field}>
                <dt className="text-fg-secondary">{field === '_tag' ? 'Příkaz' : field}</dt>
                <dd className="font-mono wrap-anywhere">{commandValue(value)}</dd>
              </div>
            ))}
        </dl>
      </Accordion.Content>
    </Accordion.Item>
  </Accordion>
);

const ChangeDiff = ({ item }: { readonly item: AgentQueueItem }) => (
  <table aria-label={`Porovnání: ${item.summary}`} className="block w-full overflow-hidden rounded-md bg-base">
    <thead className="block">
      <tr className="grid grid-cols-[minmax(4.5rem,0.75fr)_minmax(0,1fr)_minmax(0,1fr)] sm:grid-cols-[minmax(7rem,0.75fr)_minmax(0,1fr)_minmax(0,1fr)] bg-fill-base font-medium text-fg-secondary text-xs leading-normal">
        <th className="min-w-0 px-1.5 py-2 text-start wrap-anywhere sm:px-3 sm:py-2.5" scope="col">
          Údaj
        </th>
        <th className="min-w-0 px-1.5 py-2 text-start wrap-anywhere sm:px-3 sm:py-2.5" scope="col">
          Před změnou
        </th>
        <th className="min-w-0 px-1.5 py-2 text-start wrap-anywhere sm:px-3 sm:py-2.5" scope="col">
          Po schválení
        </th>
      </tr>
    </thead>
    <tbody className="block">
      {item.diff.map((line) => (
        <tr
          className="grid grid-cols-[minmax(4.5rem,0.75fr)_minmax(0,1fr)_minmax(0,1fr)] sm:grid-cols-[minmax(7rem,0.75fr)_minmax(0,1fr)_minmax(0,1fr)] border-border-primary/60 border-t text-xs leading-normal sm:text-sm"
          key={line.field}
        >
          <th
            className="min-w-0 px-1.5 py-2 text-start wrap-anywhere sm:px-3 sm:py-2.5 font-medium text-fg-primary"
            scope="row"
          >
            {line.label}
          </th>
          <td className="min-w-0 px-1.5 py-2 text-start wrap-anywhere sm:px-3 sm:py-2.5 bg-danger-light text-danger-fg">
            {line.before ?? '—'}
          </td>
          <td className="min-w-0 px-1.5 py-2 text-start wrap-anywhere sm:px-3 sm:py-2.5 bg-success-light text-success-fg">
            {line.after ?? 'Vymazáno'}
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);

const ChangeEvidence = ({ item }: { readonly item: AgentQueueItem }) =>
  Match.value(item.diffSource).pipe(
    Match.when('agent', () => (
      <StatusText showIcon size="sm" status="warning">
        Tento popis změny napsal agent a platforma ho neumí ověřit. Schválení provede přesně příkaz níže.
      </StatusText>
    )),
    Match.when('command', () => (
      <p className="text-fg-secondary text-xs">
        Hodnoty „Po schválení“ sestavila platforma z uloženého příkazu. Původní hodnoty tento modul platformě
        neposkytuje.
      </p>
    )),
    Match.when('platform', () => (
      <p className="text-fg-secondary text-xs">
        {item.status === 'pending'
          ? 'Hodnoty sestavila platforma z příkazu a aktuálního stavu záznamu.'
          : 'Hodnoty sestavila platforma z provedeného příkazu.'}
      </p>
    )),
    Match.when(undefined, () => null),
    Match.exhaustive,
  );

const ChangeHistory = ({ item }: { readonly item: AgentQueueItem }) => (
  <>
    {item.failure !== undefined && (
      <p className="text-sm" role="alert">
        Změnu nelze provést: {item.failure}
      </p>
    )}
    {item.decisionNote !== undefined && (
      <p className="text-fg-secondary text-sm">Poznámka schvalovatele: {item.decisionNote}</p>
    )}
    {item.decidedAt !== undefined && (
      <p className="text-fg-secondary text-xs">
        {`${item.status === 'rejected' ? 'Zamítnuto' : 'Schváleno'} · ${item.decidedByName ?? 'Neznámý uživatel'} · ${formatAgentTime(item.decidedAt)}`}
      </p>
    )}
    {(item.status === 'applied' || item.status === 'pending') && item.revertUnavailableReason !== undefined && (
      <Badge appearance="outline" severity="neutral" title={item.revertUnavailableReason}>
        {item.status === 'pending' ? 'Po schválení nelze automaticky vrátit' : 'Nelze automaticky vrátit'}
      </Badge>
    )}
  </>
);

const ChangeCard = ({
  busy,
  decide,
  highlighted,
  item,
}: {
  readonly busy: boolean;
  readonly decide: (keys: readonly string[], decision: Decision) => void;
  readonly highlighted: boolean;
  readonly item: AgentQueueItem;
}) => (
  <article
    aria-current={highlighted ? 'true' : undefined}
    className={`flex min-w-0 flex-col gap-3.5 rounded-lg bg-surface p-3 sm:p-4 ${highlighted ? 'scroll-mt-20 outline-2 outline-primary' : ''}`}
    data-item-key={item.key}
    tabIndex={highlighted ? -1 : undefined}
  >
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 grow basis-64">
        <h3 className="font-semibold text-sm">{item.summary}</h3>
        {item.targetLabel !== item.summary && <p className="text-fg-secondary text-sm">{item.targetLabel}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge severity={itemBadgeVariants[item.status]}>{agentItemStatusLabel[item.status]}</Badge>
        <span className="text-fg-secondary text-xs">{agentRiskLabel[item.risk]}</span>
        <span className="text-fg-secondary text-xs">{item.moduleLabel}</span>
      </div>
    </div>
    <p className="max-w-[80ch] text-sm leading-normal wrap-anywhere">
      <span className="font-medium">Důvod návrhu: </span>
      {item.reason}
    </p>
    <ChangeDiff item={item} />
    <ChangeEvidence item={item} />
    {item.command !== undefined && <CommandDetails command={item.command} open={item.diffSource === 'agent'} />}
    <ChangeHistory item={item} />
    {item.status === 'pending' && item.canDecide && (
      <div className="flex flex-wrap items-center gap-2 justify-end">
        <Button
          appearance="outline"
          disabled={busy}
          onClick={() => decide([item.key], 'reject')}
          severity="secondary"
          size="sm"
        >
          Zamítnout změnu
        </Button>
        <Button disabled={busy} onClick={() => decide([item.key], 'approve')} size="sm">
          Schválit změnu
        </Button>
      </div>
    )}
    {item.status === 'pending' && !item.canDecide && (
      <p className="text-fg-secondary text-sm">
        {item.cannotDecideReason ??
          `Tuto změnu může schválit jen člověk s oprávněním k zápisu v modulu ${item.moduleLabel}.`}
      </p>
    )}
  </article>
);

const BatchStatus = ({ batch }: { readonly batch: AgentQueueBatch }) => {
  if (batch.revertedAt !== undefined) {
    return (
      <Badge appearance="outline" severity="neutral">
        Dávka vrácena
      </Badge>
    );
  }
  const pending = batch.items.filter((item) => item.status === 'pending');
  if (pending.length > 0) {
    return <Badge severity="warning">{`${pending.length} ke schválení`}</Badge>;
  }
  if (batch.items.some((item) => item.status === 'applied')) {
    return <Badge severity="success">Změny provedeny</Badge>;
  }
  return (
    <Badge appearance="outline" severity="neutral">
      Vyřízeno
    </Badge>
  );
};

const BatchCard = ({
  batch,
  busy,
  highlighted,
  onDecide,
  onRevert,
  targetItemKey,
}: {
  readonly batch: AgentQueueBatch;
  readonly busy: boolean;
  readonly highlighted: boolean;
  readonly onDecide: (batch: AgentQueueBatch, keys: readonly string[], decision: Decision, note: string) => void;
  readonly onRevert: (batch: AgentQueueBatch, note: string) => void;
  readonly targetItemKey: string | undefined;
}) => {
  const { t } = useModernI18n();
  const notes = Option.getOrElse(useAtomValue(notesValue), () => noNotes);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const pending = batch.items.filter((item) => item.status === 'pending');
  const decidable = pending.filter((item) => item.canDecide);
  const trimmedNote = (notes[batch.key] ?? '').trim();
  const decide = (keys: readonly string[], decision: Decision) => onDecide(batch, keys, decision, trimmedNote);
  // Modules with their own AI change engine declare the page that shows these batches too.
  const { modulePage } = batch;
  const revertNote = batch.revertNote === undefined ? '' : ` · ${batch.revertNote}`;
  return (
    <section
      aria-current={highlighted ? 'true' : undefined}
      className={`min-w-0 scroll-mt-20 overflow-hidden rounded-lg border ${highlighted ? 'border-primary ring-2 ring-primary-light' : 'border-border-primary/60'}`}
      data-batch-key={batch.key}
    >
      <header className="flex flex-col gap-4 p-3 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 grow basis-64">
            <p className="text-fg-secondary text-xs">{`${formatAgentTime(batch.createdAt)} · ${batch.agentLabel}`}</p>
            <h2 className="mt-1.5 max-w-[75ch] font-semibold text-[1rem] leading-normal wrap-anywhere sm:text-[1.1rem]">
              {batch.instruction}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              {batch.moduleLabels.map((label) => (
                <Badge appearance="outline" key={label} severity="neutral" size="sm">
                  {label}
                </Badge>
              ))}
              {modulePage !== undefined && (
                <LinkButton appearance="outline" as={LocalizedLink} severity="primary" size="sm" to={modulePage.path}>
                  {modulePage.label.cs}
                </LinkButton>
              )}
            </div>
          </div>
          <BatchStatus batch={batch} />
        </div>
        {decidable.length > 0 && (
          <>
            <FormRoot
              defaultValues={{ notes: noNotes }}
              form={batchNotesForm}
              translateMessage={(message) => t(message)}
            >
              <batchNotesForm.notes
                entry={batch.key}
                id={`note-${batch.key}`}
                label={t('shell.agentPlatform.approvals.note')}
                placeholder={t('shell.agentPlatform.approvals.notePlaceholder')}
                size="sm"
              />
            </FormRoot>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={busy}
                onClick={() =>
                  decide(
                    decidable.map((item) => item.key),
                    'approve',
                  )
                }
                size="sm"
              >
                {`Schválit dávku (${decidable.length})`}
              </Button>
              <Button
                appearance="outline"
                disabled={busy}
                onClick={() =>
                  decide(
                    decidable.map((item) => item.key),
                    'reject',
                  )
                }
                severity="secondary"
                size="sm"
              >
                Zamítnout dávku
              </Button>
            </div>
          </>
        )}
        {batch.canRevertAll && (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              appearance="outline"
              disabled={busy}
              onClick={() => setConfirmRevert(!confirmRevert)}
              severity="secondary"
              size="sm"
            >
              Vrátit vše
            </Button>
            <span className="text-fg-secondary text-xs">
              Obnoví původní údaje provedených změn dávky. Změny, které nejde vrátit automaticky, jsou označené.
            </span>
            {confirmRevert && (
              <div className="flex basis-full flex-col gap-3 border-warning border-l-3 p-4 text-sm" role="alert">
                <p>Vrátit všechny provedené změny této dávky? Historie zůstane zachována.</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    disabled={busy}
                    onClick={() => {
                      onRevert(batch, trimmedNote);
                      setConfirmRevert(false);
                    }}
                    size="sm"
                  >
                    Potvrdit vrácení celé dávky
                  </Button>
                  <Button appearance="outline" onClick={() => setConfirmRevert(false)} severity="secondary" size="sm">
                    Zrušit
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        {batch.revertedAt !== undefined && (
          <p className="text-fg-secondary text-xs">
            {`Vráceno ${formatAgentTime(batch.revertedAt)} · ${batch.revertedByName ?? 'Neznámý uživatel'}${revertNote}`}
          </p>
        )}
      </header>
      <div className="flex flex-col gap-4 px-3 pb-3 sm:px-5 sm:pb-5">
        {batch.items.map((item) => (
          <ChangeCard busy={busy} decide={decide} highlighted={item.key === targetItemKey} item={item} key={item.key} />
        ))}
      </div>
    </section>
  );
};

const queueRequest = (
  filter: 'all' | 'pending',
  moduleKey: string,
  cursor: AgentPageCursor | undefined,
  batchKey: string | undefined,
): AgentQueueRequest => {
  let request: AgentQueueRequest = { pendingOnly: filter === 'pending' };
  if (moduleKey !== '') {
    request = { ...request, moduleKey: AgentModuleKeySchema.make(moduleKey) };
  }
  if (cursor !== undefined) {
    request = { ...request, cursor };
  }
  if (batchKey !== undefined) {
    request = { ...request, batchKey: AgentBatchKeySchema.make(batchKey) };
  }
  return request;
};

interface ReviewFeedback {
  readonly message: string;
  readonly uncertain: boolean;
}

const decisionMessage = (request: AgentDecideRequest, response: AgentDecideResponse): string => {
  const settled = response.results.every((entry) => entry.outcome === 'applied' || entry.outcome === 'rejected');
  if (settled) {
    return request.decision === 'approve'
      ? 'Rozhodnutí uloženo. Výsledek vidíte u jednotlivých změn.'
      : 'Návrhy zamítnuty. Data zůstala beze změny.';
  }
  const messages = response.results
    .map((entry) => entry.message)
    .filter((text): text is string => text !== undefined && text !== '');
  return `Některé změny se nepodařilo provést: ${messages.join(' ')}`;
};

const decisionFeedback = (
  intent: AgentMutationIntent<AgentDecideRequest>,
): Effect.Effect<ReviewFeedback, never, HttpClient.HttpClient> =>
  decideAgentItems(intent).pipe(
    Effect.map((result) => ({
      message:
        result.status === 'ok'
          ? decisionMessage(intent.payload, result.value)
          : 'Rozhodnutí se nepodařilo uložit. Zkuste to prosím znovu.',
      uncertain: agentMutationUncertain(result),
    })),
  );

const revertFeedback = (
  intent: AgentMutationIntent<AgentRevertRequest>,
): Effect.Effect<ReviewFeedback, never, HttpClient.HttpClient> =>
  revertAgentBatch(intent).pipe(
    Effect.map((result) => ({
      message: result.status === 'ok' ? result.value.message : 'Dávku se nepodařilo vrátit. Zkuste to prosím znovu.',
      uncertain: agentMutationUncertain(result),
    })),
  );

/** Own the pending intent independently of queue rows, editable notes, and queue refreshes. */
const useReviewActions = (refresh: () => void) => {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [retryIntent, setRetryIntent] = useState<ReviewIntent>();
  const send = (intent: Effect.Effect<ReviewIntent>) => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    browserRuntime.runFork(
      intent.pipe(
        Effect.tap((request) => Effect.sync(() => setRetryIntent(request))),
        Effect.flatMap((request) =>
          request.kind === 'decide' ? decisionFeedback(request.request) : revertFeedback(request.request),
        ),
        Effect.tap((result) =>
          Effect.sync(() => {
            setMessage(result.message);
            if (!result.uncertain) {
              setRetryIntent(undefined);
              refresh();
            }
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            inFlight.current = false;
            setBusy(false);
          }),
        ),
      ),
    );
  };
  const handleDecide = (batch: AgentQueueBatch, keys: readonly string[], decision: Decision, note: string) => {
    let payload: AgentDecideRequest = {
      batchKey: batch.key,
      decision,
      itemKeys: [...keys].toSorted().map((key) => AgentItemKeySchema.make(key)),
    };
    if (note !== '') {
      payload = { ...payload, note };
    }
    send(
      agentMutationIntent(retryIntent?.kind === 'decide' ? retryIntent.request : undefined, payload).pipe(
        Effect.map((request): ReviewIntent => ({ kind: 'decide', request })),
      ),
    );
  };
  const handleRevert = (batch: AgentQueueBatch, note: string) => {
    let payload: AgentRevertRequest = { batchKey: batch.key };
    if (note !== '') {
      payload = { ...payload, note };
    }
    send(
      agentMutationIntent(retryIntent?.kind === 'revert' ? retryIntent.request : undefined, payload).pipe(
        Effect.map((request): ReviewIntent => ({ kind: 'revert', request })),
      ),
    );
  };
  const handleRetry = () => {
    if (retryIntent !== undefined) {
      send(Effect.succeed(retryIntent));
    }
  };
  return { busy, handleDecide, handleRetry, handleRevert, message, retryIntent };
};

type ReviewActions = ReturnType<typeof useReviewActions>;

const ReviewStatus = ({ actions }: { readonly actions: ReviewActions }) => (
  <>
    {actions.message !== '' && (
      <StatusText aria-live="polite" size="sm" status="default">
        {actions.message}
      </StatusText>
    )}
    {actions.retryIntent !== undefined && (
      <Button appearance="outline" disabled={actions.busy} onClick={actions.handleRetry} severity="secondary" size="sm">
        Zopakovat původní požadavek
      </Button>
    )}
  </>
);

const QueueEmpty = ({ pendingOnly }: { readonly pendingOnly: boolean }) =>
  pendingOnly ? (
    <div>
      <h2 className="font-semibold text-sm">Nic nečeká na schválení</h2>
      <p className="text-fg-secondary text-sm">Jakmile AI agent pošle návrh změny, objeví se tady.</p>
    </div>
  ) : (
    <p className="text-fg-secondary text-sm">Zatím tu nejsou žádné dávky návrhů.</p>
  );

const QueueBatches = ({
  actions,
  filter,
  response,
  targetItemKey,
  targetKey,
}: {
  readonly actions: ReviewActions;
  readonly filter: 'all' | 'pending';
  readonly response: AgentQueueResponse;
  readonly targetItemKey: string | undefined;
  readonly targetKey: string | undefined;
}) =>
  response.batches.length === 0 ? (
    <QueueEmpty pendingOnly={filter === 'pending'} />
  ) : (
    response.batches.map((batch) => (
      <BatchCard
        batch={batch}
        busy={actions.busy}
        highlighted={batch.key === targetKey}
        key={batch.key}
        onDecide={actions.handleDecide}
        onRevert={actions.handleRevert}
        targetItemKey={targetItemKey}
      />
    ))
  );

/** Synchronize a review link with the committed DOM, without changing queue filters from an effect. */
const useReviewTarget = (
  queue: ReturnType<typeof agentQueueData.snapshot>,
  targetKey: string | undefined,
  targetItemKey: string | undefined,
) => {
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (queue.state !== 'ready' || targetKey === undefined || scrolledTo.current === (targetItemKey ?? targetKey)) {
      return;
    }
    if (!queue.value.batches.some((batch) => batch.key === targetKey)) {
      return;
    }
    const batchElement = document.querySelector<HTMLElement>(`[data-batch-key="${CSS.escape(targetKey)}"]`);
    const element =
      targetItemKey === undefined
        ? batchElement
        : batchElement?.querySelector<HTMLElement>(`[data-item-key="${CSS.escape(targetItemKey)}"]`);
    if (element === null || element === undefined) {
      return;
    }
    scrolledTo.current = targetItemKey ?? targetKey;
    if (targetItemKey !== undefined) {
      element.focus({ preventScroll: true });
    }
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [queue, targetKey, targetItemKey]);
};

const QueueFilters = ({
  filter,
  modules,
  onFilter,
}: {
  readonly filter: 'all' | 'pending';
  readonly modules: NonNullable<AgentQueueResponse['modules']>;
  readonly onFilter: (filter: 'all' | 'pending') => void;
}) => {
  const { t } = useModernI18n();
  return (
    <fieldset aria-label={t('shell.agentPlatform.approvals.filters')} className="flex flex-wrap items-end gap-3">
      <Button
        appearance={filter === 'pending' ? 'solid' : 'outline'}
        aria-pressed={filter === 'pending'}
        onClick={() => onFilter('pending')}
        severity={filter === 'pending' ? 'primary' : 'secondary'}
        size="sm"
      >
        Čeká na schválení
      </Button>
      <Button
        appearance={filter === 'all' ? 'solid' : 'outline'}
        aria-pressed={filter === 'all'}
        onClick={() => onFilter('all')}
        severity={filter === 'all' ? 'primary' : 'secondary'}
        size="sm"
      >
        Všechny dávky
      </Button>
      <FormRoot defaultValues={{ moduleKey: '' }} form={queueModuleForm} translateMessage={(message) => t(message)}>
        <queueModuleForm.moduleKey
          items={[
            { label: 'Všechny moduly', value: '' },
            ...modules.map((module) => ({ label: module.label, value: module.moduleKey })),
          ]}
          label="Modul"
          placeholder="Všechny moduly"
        />
      </FormRoot>
    </fieldset>
  );
};

const ApprovalsQueue = ({
  targetItemKey,
  targetKey,
}: {
  readonly targetItemKey: string | undefined;
  readonly targetKey: string | undefined;
}) => {
  const [selectedFilter, setSelectedFilter] = useState<'all' | 'pending'>('pending');
  const moduleFilter = Option.getOrElse(useAtomValue(moduleKeyValue), () => '');
  const [browse, setBrowse] = useState(false);
  // A direct review link includes settled batches without resetting React state from an effect.
  const filter = !browse && targetKey !== undefined ? 'all' : selectedFilter;
  const filterKey = [filter, moduleFilter, browse ? '' : (targetKey ?? '')].join('|');
  const [page, setPage] = useState<{ readonly cursor: AgentPageCursor; readonly filter: string }>();
  const cursor = page?.filter === filterKey ? page.cursor : undefined;
  const batchKey = browse ? undefined : targetKey;
  const request = queueRequest(filter, moduleFilter, cursor, batchKey);
  const queue = useSyncExternalStore(
    agentQueueData.subscribe,
    () => agentQueueData.snapshot(request),
    () => pageDataPending,
  );
  useEffect(
    () => agentQueueData.ensure(queueRequest(filter, moduleFilter, cursor, batchKey)),
    [filter, moduleFilter, cursor, batchKey],
  );
  const refresh = () => {
    setPage(undefined);
    const { cursor: _cursor, ...firstPage } = request;
    browserRuntime.runFork(agentQueueData.refresh(firstPage));
  };

  const actions = useReviewActions(refresh);
  useReviewTarget(queue, targetKey, targetItemKey);

  if (queue.state === 'pending') {
    return (
      <>
        <ReviewStatus actions={actions} />
        <ModulePageSkeleton />
      </>
    );
  }
  if (queue.state === 'failed') {
    return (
      <div className="flex min-w-0 flex-col gap-5">
        <ReviewStatus actions={actions} />
        <StatusText aria-live="polite" showIcon status="error">
          {queueFailureText(queue.error.httpStatus)}
        </StatusText>
        {queue.error.httpStatus !== 401 && queue.error.httpStatus !== 403 && (
          <Button appearance="outline" onClick={refresh} severity="secondary" size="sm">
            Zkusit znovu
          </Button>
        )}
      </div>
    );
  }

  const response = queue.value;
  const moduleOptions = response.modules ?? [];
  const targetBatch = response.batches.find((batch) => batch.key === targetKey);
  const missingTarget =
    targetKey !== undefined &&
    (targetBatch === undefined ||
      (targetItemKey !== undefined && !targetBatch.items.some((item) => item.key === targetItemKey)));

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-fg-secondary text-sm">
          Návrhy změn od AI agentů ze všech modulů. Bez souhlasu člověka se nic nezmění.
        </p>
      </div>
      <div className="flex items-start gap-3 rounded-lg border-info border-l-3 bg-surface p-4 text-sm leading-[1.6]">
        <span aria-hidden className="icon-[mdi--shield-check-outline] size-250 shrink-0" />
        <p className="max-w-[80ch]">
          <strong>Pod kontrolou člověka.</strong> Agent smí změny jen navrhnout. Schválením je provedete svým jménem a s
          vlastními oprávněními; každé rozhodnutí má autora, čas a výsledek.
        </p>
      </div>
      {response.unavailableModules.length > 0 && (
        <div className="flex flex-wrap items-center gap-150">
          <StatusText aria-live="polite" showIcon status="warning">
            {`Návrhy z modulů ${response.unavailableModules.join(', ')} se teď nepodařilo načíst.`}
          </StatusText>
          <Button appearance="outline" disabled={actions.busy} onClick={refresh} severity="secondary" size="sm">
            Zkusit znovu
          </Button>
        </div>
      )}
      <QueueFilters
        filter={filter}
        modules={moduleOptions}
        onFilter={(next) => {
          setBrowse(true);
          setSelectedFilter(next);
        }}
      />
      <ReviewStatus actions={actions} />
      {missingTarget && (
        <StatusText aria-live="polite" showIcon size="sm" status="warning">
          Návrh z odkazu tu nevidíte. Možná patří jiné firmě, byl odstraněn, nebo k němu nemáte přístup.
        </StatusText>
      )}
      <QueueBatches
        actions={actions}
        filter={filter}
        response={response}
        targetItemKey={targetItemKey}
        targetKey={targetKey}
      />
      {response.nextCursor !== undefined && (
        <Button
          appearance="outline"
          disabled={actions.busy}
          onClick={() => {
            if (response.nextCursor !== undefined) {
              setPage({ cursor: response.nextCursor, filter: filterKey });
            }
          }}
          severity="secondary"
          size="sm"
        >
          Načíst další
        </Button>
      )}
      <div>
        <LinkButton appearance="outline" as={LocalizedLink} severity="primary" size="sm" to="/sprava/aktivita-agentu">
          Zobrazit aktivitu agentů
        </LinkButton>
      </div>
    </div>
  );
};

export const ApprovalsPanel = () => {
  const searchStr = useRouterState({ select: (routerState) => routerState.location.searchStr });
  const search = Option.getOrElse(
    Schema.decodeOption(AgentReviewSearchQuerySchema)(Url.urlParams(new URL(searchStr, 'https://shell.invalid/'))),
    () => ({}),
  );
  // The queue's filter and notes outlive the queue's loading states, which unmount their controls.
  return (
    <>
      <queueModuleForm.KeepAlive />
      <batchNotesForm.KeepAlive />
      <ApprovalsQueue targetItemKey={itemKeyFromSearch(search)} targetKey={batchKeyFromSearch(search)} />
    </>
  );
};
