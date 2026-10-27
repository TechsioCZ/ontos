import { Link as LocalizedLink } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
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

import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
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

/** Neutral outline for settled items; the theme's secondary badge is the brand green and reads as success. */
const itemBadgeVariants = {
  applied: 'success',
  failed: 'danger',
  pending: 'warning',
  rejected: 'outline',
  revert_failed: 'danger',
  reverted: 'outline',
} satisfies Readonly<Record<AgentQueueItem['status'], ComponentProps<typeof Badge>['variant']>>;
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
  <details className="ai-review-command" open={open}>
    <summary>Přesný příkaz pro modul</summary>
    <dl>
      {Object.entries(command)
        .toSorted(([left], [right]) => Number(right === '_tag') - Number(left === '_tag'))
        .map(([field, value]) => (
          <div key={field}>
            <dt>{field === '_tag' ? 'Příkaz' : field}</dt>
            <dd>{commandValue(value)}</dd>
          </div>
        ))}
    </dl>
  </details>
);

const ChangeDiff = ({ item }: { readonly item: AgentQueueItem }) => (
  <table aria-label={`Porovnání: ${item.summary}`} className="ai-review-diff block w-full">
    <thead className="block">
      <tr className="ai-review-diff-head">
        <th className="px-75 py-50 text-left" scope="col">
          Údaj
        </th>
        <th className="px-75 py-50 text-left" scope="col">
          Před změnou
        </th>
        <th className="px-75 py-50 text-left" scope="col">
          Po schválení
        </th>
      </tr>
    </thead>
    <tbody className="block">
      {item.diff.map((line) => (
        <tr className="ai-review-diff-row" key={line.field}>
          <th className="px-75 py-50 text-left font-medium" scope="row">
            {line.label}
          </th>
          <td className="ai-review-before px-75 py-50">{line.before ?? '—'}</td>
          <td className="ai-review-after px-75 py-50">{line.after ?? 'Vymazáno'}</td>
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
      <Badge title={item.revertUnavailableReason} variant="outline">
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
    className="ai-review-change"
    data-item-key={item.key}
    tabIndex={highlighted ? -1 : undefined}
  >
    <div className="ai-review-heading">
      <div>
        <h3 className="font-semibold text-sm">{item.summary}</h3>
        {item.targetLabel !== item.summary && <p className="text-fg-secondary text-sm">{item.targetLabel}</p>}
      </div>
      <div className="ai-review-actions">
        <Badge variant={itemBadgeVariants[item.status]}>{agentItemStatusLabel[item.status]}</Badge>
        <span className="text-fg-secondary text-xs">{agentRiskLabel[item.risk]}</span>
        <span className="text-fg-secondary text-xs">{item.moduleLabel}</span>
      </div>
    </div>
    <p className="ai-review-reason">
      <span className="font-medium">Důvod návrhu: </span>
      {item.reason}
    </p>
    <ChangeDiff item={item} />
    <ChangeEvidence item={item} />
    {item.command !== undefined && <CommandDetails command={item.command} open={item.diffSource === 'agent'} />}
    <ChangeHistory item={item} />
    {item.status === 'pending' && item.canDecide && (
      <div className="ai-review-actions ai-review-end">
        <Button
          disabled={busy}
          onClick={() => decide([item.key], 'reject')}
          size="sm"
          theme="outlined"
          variant="secondary"
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
    return <Badge variant="outline">Dávka vrácena</Badge>;
  }
  const pending = batch.items.filter((item) => item.status === 'pending');
  if (pending.length > 0) {
    return <Badge variant="warning">{`${pending.length} ke schválení`}</Badge>;
  }
  if (batch.items.some((item) => item.status === 'applied')) {
    return <Badge variant="success">Změny provedeny</Badge>;
  }
  return <Badge variant="outline">Vyřízeno</Badge>;
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
  const [note, setNote] = useState('');
  const [confirmRevert, setConfirmRevert] = useState(false);
  const pending = batch.items.filter((item) => item.status === 'pending');
  const decidable = pending.filter((item) => item.canDecide);
  const trimmedNote = note.trim();
  const decide = (keys: readonly string[], decision: Decision) => onDecide(batch, keys, decision, trimmedNote);
  // Modules with their own AI change engine declare the page that shows these batches too.
  const { modulePage } = batch;
  const revertNote = batch.revertNote === undefined ? '' : ` · ${batch.revertNote}`;
  return (
    <section
      aria-current={highlighted ? 'true' : undefined}
      className={highlighted ? 'ai-review-batch ai-review-batch-target' : 'ai-review-batch'}
      data-batch-key={batch.key}
    >
      <header className="ai-review-batch-header">
        <div className="ai-review-heading">
          <div>
            <p className="text-fg-secondary text-xs">{`${formatAgentTime(batch.createdAt)} · ${batch.agentLabel}`}</p>
            <h2 className="ai-review-instruction">{batch.instruction}</h2>
            <div className="ai-review-actions">
              {batch.moduleLabels.map((label) => (
                <Badge key={label} size="sm" variant="outline">
                  {label}
                </Badge>
              ))}
              {modulePage !== undefined && (
                <LinkButton as={LocalizedLink} size="sm" theme="outlined" to={modulePage.path} variant="primary">
                  {modulePage.label.cs}
                </LinkButton>
              )}
            </div>
          </div>
          <BatchStatus batch={batch} />
        </div>
        {decidable.length > 0 && (
          <>
            <FormInput
              id={`note-${batch.key}`}
              label="Poznámka k rozhodnutí (nepovinná)"
              onChange={(event) => setNote(event.target.value)}
              placeholder="Např. ověřeno s obchodníkem"
              size="sm"
              value={note}
            />
            <div className="ai-review-actions">
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
                disabled={busy}
                onClick={() =>
                  decide(
                    decidable.map((item) => item.key),
                    'reject',
                  )
                }
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                Zamítnout dávku
              </Button>
            </div>
          </>
        )}
        {batch.canRevertAll && (
          <div className="ai-review-revert">
            <Button
              disabled={busy}
              onClick={() => setConfirmRevert(!confirmRevert)}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              Vrátit vše
            </Button>
            <span className="text-fg-secondary text-xs">
              Obnoví původní údaje provedených změn dávky. Změny, které nejde vrátit automaticky, jsou označené.
            </span>
            {confirmRevert && (
              <div className="ai-review-confirm" role="alert">
                <p>Vrátit všechny provedené změny této dávky? Historie zůstane zachována.</p>
                <div className="ai-review-actions">
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
                  <Button onClick={() => setConfirmRevert(false)} size="sm" theme="outlined" variant="secondary">
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
      <div className="ai-review-changes">
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
      <Button disabled={actions.busy} onClick={actions.handleRetry} size="sm" theme="outlined" variant="secondary">
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
  moduleFilter,
  modules,
  onFilter,
  onModuleFilter,
}: {
  readonly filter: 'all' | 'pending';
  readonly moduleFilter: string;
  readonly modules: NonNullable<AgentQueueResponse['modules']>;
  readonly onFilter: (filter: 'all' | 'pending') => void;
  readonly onModuleFilter: (moduleKey: string) => void;
}) => (
  <fieldset aria-label="Zobrazení dávek" className="ai-review-actions agent-filters">
    <Button
      aria-pressed={filter === 'pending'}
      onClick={() => onFilter('pending')}
      size="sm"
      theme={filter === 'pending' ? 'solid' : 'outlined'}
      variant={filter === 'pending' ? 'primary' : 'secondary'}
    >
      Čeká na schválení
    </Button>
    <Button
      aria-pressed={filter === 'all'}
      onClick={() => onFilter('all')}
      size="sm"
      theme={filter === 'all' ? 'solid' : 'outlined'}
      variant={filter === 'all' ? 'primary' : 'secondary'}
    >
      Všechny dávky
    </Button>
    <label>
      <span>Modul</span>
      <select onChange={(event) => onModuleFilter(event.target.value)} value={moduleFilter}>
        <option value="">Všechny moduly</option>
        {modules.map((module) => (
          <option key={module.moduleKey} value={module.moduleKey}>
            {module.label}
          </option>
        ))}
      </select>
    </label>
  </fieldset>
);

const ApprovalsQueue = ({
  targetItemKey,
  targetKey,
}: {
  readonly targetItemKey: string | undefined;
  readonly targetKey: string | undefined;
}) => {
  const [selectedFilter, setSelectedFilter] = useState<'all' | 'pending'>('pending');
  const [moduleFilter, setModuleFilter] = useState('');
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
      <div className="ai-review">
        <ReviewStatus actions={actions} />
        <StatusText aria-live="polite" showIcon status="error">
          {queueFailureText(queue.error.httpStatus)}
        </StatusText>
        {queue.error.httpStatus !== 401 && queue.error.httpStatus !== 403 && (
          <Button onClick={refresh} size="sm" theme="outlined" variant="secondary">
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
    <div className="ai-review">
      <div className="ai-review-heading">
        <p className="text-fg-secondary text-sm">
          Návrhy změn od AI agentů ze všech modulů. Bez souhlasu člověka se nic nezmění.
        </p>
        <Button disabled={actions.busy} onClick={refresh} size="sm" theme="outlined" variant="secondary">
          Obnovit seznam
        </Button>
      </div>
      <div className="ai-review-safety">
        <span aria-hidden className="icon-[mdi--shield-check-outline] size-250" />
        <p>
          <strong>Pod kontrolou člověka.</strong> Agent smí změny jen navrhnout. Schválením je provedete svým jménem a s
          vlastními oprávněními; každé rozhodnutí má autora, čas a výsledek.
        </p>
      </div>
      {response.unavailableModules.length > 0 && (
        <StatusText aria-live="polite" showIcon status="warning">
          {`Návrhy z modulů ${response.unavailableModules.join(', ')} se teď nepodařilo načíst. Obnovte prosím stránku za chvíli.`}
        </StatusText>
      )}
      <QueueFilters
        filter={filter}
        moduleFilter={moduleFilter}
        modules={moduleOptions}
        onFilter={(next) => {
          setBrowse(true);
          setSelectedFilter(next);
        }}
        onModuleFilter={setModuleFilter}
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
          disabled={actions.busy}
          onClick={() => {
            if (response.nextCursor !== undefined) {
              setPage({ cursor: response.nextCursor, filter: filterKey });
            }
          }}
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          Načíst další
        </Button>
      )}
      <div>
        <LinkButton as={LocalizedLink} size="sm" theme="outlined" to="/sprava/aktivita-agentu" variant="primary">
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
  return <ApprovalsQueue targetItemKey={itemKeyFromSearch(search)} targetKey={batchKeyFromSearch(search)} />;
};
