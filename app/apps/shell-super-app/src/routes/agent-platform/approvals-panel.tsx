import { Link as LocalizedLink } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { agentItemStatusLabel, agentRiskLabel } from '@app/shared-contracts/agent-proposals';
import type { AgentQueueBatch, AgentQueueItem } from '@app/shared-contracts/agent-proposals';
import { pageDataPending } from '@app/shared-contracts/page-data';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { browserRuntime } from '../../runtime/browser-effect-runtime.ts';
import { ModulePageSkeleton } from '../module-page-skeleton.tsx';
import { decideAgentItems, formatAgentTime, revertAgentBatch } from './agent-platform-client.ts';
import { agentQueueData } from './platform-page-data.ts';
import { batchKeyFromSearch, itemKeyFromSearch } from './batch-link.ts';

type Decision = 'approve' | 'reject';

/** Batches shown per step in „Všechny dávky“. */
const HISTORY_PAGE = 12;

/** Neutral outline for settled items; the theme's secondary badge is the brand green and reads as success. */
const itemBadgeVariant = (status: AgentQueueItem['status']) =>
  status === 'pending'
    ? 'warning'
    : status === 'applied'
      ? 'success'
      : status === 'failed' || status === 'revert_failed'
        ? 'danger'
        : 'outline';
const queueFailureText = (httpStatus: number): string => {
  if (httpStatus === 401) {
    return 'Přihlaste se prosím znovu.';
  }
  if (httpStatus === 403) {
    return 'Tato stránka je dostupná jen lidem, kteří schvalují změny.';
  }
  return 'Seznam návrhů se nepodařilo načíst.';
};

const commandValue = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

/** The exact command an approval runs; open by default when the lines above are only the agent's description. */
const CommandDetails = ({
  command,
  open,
}: {
  readonly command: Readonly<Record<string, unknown>>;
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

const ChangeCard = ({
  item,
  busy,
  decide,
  highlighted,
}: {
  readonly highlighted: boolean;
  readonly item: AgentQueueItem;
  readonly busy: boolean;
  readonly decide: (keys: readonly string[], decision: Decision) => void;
}) => (
  <article
    aria-current={highlighted ? 'true' : undefined}
    tabIndex={highlighted ? -1 : undefined}
    className="ai-review-change"
    data-item-key={item.key}
  >
    <div className="ai-review-heading">
      <div>
        <h3 className="font-semibold text-sm">{item.summary}</h3>
        {item.targetLabel !== item.summary && <p className="text-fg-secondary text-sm">{item.targetLabel}</p>}
      </div>
      <div className="ai-review-actions">
        <Badge variant={itemBadgeVariant(item.status)}>{agentItemStatusLabel[item.status]}</Badge>
        <span className="text-fg-secondary text-xs">{agentRiskLabel[item.risk]}</span>
        <span className="text-fg-secondary text-xs">{item.moduleLabel}</span>
      </div>
    </div>
    <p className="ai-review-reason">
      <span className="font-medium">Důvod návrhu: </span>
      {item.reason}
    </p>
    <div className="ai-review-diff" role="table" aria-label={`Porovnání: ${item.summary}`}>
      <div className="ai-review-diff-head" role="row">
        <span role="columnheader">Údaj</span>
        <span role="columnheader">Před změnou</span>
        <span role="columnheader">Po schválení</span>
      </div>
      {item.diff.map((line) => (
        <div className="ai-review-diff-row" role="row" key={line.field}>
          <span className="font-medium" role="cell">
            {line.label}
          </span>
          <span className="ai-review-before" role="cell">
            {line.before ?? '—'}
          </span>
          <span className="ai-review-after" role="cell">
            {line.after ?? 'Vymazáno'}
          </span>
        </div>
      ))}
    </div>
    {item.diffSource === 'agent' ? (
      <StatusText showIcon size="sm" status="warning">
        Tento popis změny napsal agent a platforma ho neumí ověřit. Schválení provede přesně příkaz níže.
      </StatusText>
    ) : item.diffSource === 'command' ? (
      <p className="text-fg-secondary text-xs">
        Hodnoty „Po schválení“ sestavila platforma z uloženého příkazu. Původní hodnoty tento modul platformě
        neposkytuje.
      </p>
    ) : (
      item.diffSource === 'platform' && (
        <p className="text-fg-secondary text-xs">
          {item.status === 'pending'
            ? 'Hodnoty sestavila platforma z příkazu a aktuálního stavu záznamu.'
            : 'Hodnoty sestavila platforma z provedeného příkazu.'}
        </p>
      )
    )}
    {item.command !== undefined && <CommandDetails command={item.command} open={item.diffSource === 'agent'} />}
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

const BatchCard = ({
  batch,
  busy,
  highlighted,
  targetItemKey,
  onDecide,
  onRevert,
}: {
  readonly batch: AgentQueueBatch;
  readonly busy: boolean;
  readonly highlighted: boolean;
  readonly targetItemKey: string | undefined;
  readonly onDecide: (batch: AgentQueueBatch, keys: readonly string[], decision: Decision, note: string) => void;
  readonly onRevert: (batch: AgentQueueBatch, note: string) => void;
}) => {
  const [note, setNote] = useState('');
  const [confirmRevert, setConfirmRevert] = useState(false);
  const pending = batch.items.filter((item) => item.status === 'pending');
  const decidable = pending.filter((item) => item.canDecide);
  const applied = batch.items.filter((item) => item.status === 'applied');
  const trimmedNote = note.trim();
  const decide = (keys: readonly string[], decision: Decision) => onDecide(batch, keys, decision, trimmedNote);
  // Modules with their own AI change engine declare the page that shows these batches too.
  const { modulePage } = batch;
  const badge =
    batch.revertedAt !== undefined
      ? { label: 'Dávka vrácena', variant: 'outline' as const }
      : pending.length > 0
        ? { label: `${pending.length} ke schválení`, variant: 'warning' as const }
        : applied.length > 0
          ? { label: 'Změny provedeny', variant: 'success' as const }
          : { label: 'Vyřízeno', variant: 'outline' as const };
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
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
        {decidable.length > 0 && (
          <>
            <FormInput
              id={`note-${batch.key}`}
              size="sm"
              label="Poznámka k rozhodnutí (nepovinná)"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Např. ověřeno s obchodníkem"
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
            {`Vráceno ${formatAgentTime(batch.revertedAt)} · ${batch.revertedByName ?? 'Neznámý uživatel'}${batch.revertNote === undefined ? '' : ` · ${batch.revertNote}`}`}
          </p>
        )}
      </header>
      <div className="ai-review-changes">
        {batch.items.map((item) => (
          <ChangeCard highlighted={item.key === targetItemKey} busy={busy} decide={decide} item={item} key={item.key} />
        ))}
      </div>
    </section>
  );
};

/** Reloads the queue in place: the current batches stay on screen until the new list arrives. */
const refresh = () => {
  browserRuntime.runFork(agentQueueData.refresh('queue'));
};

export const ApprovalsPanel = () => {
  // The Shell prepared the queue before it revealed the page.
  const queue = useSyncExternalStore(
    agentQueueData.subscribe,
    () => agentQueueData.snapshot('queue'),
    () => pageDataPending,
  );
  const [filter, setFilter] = useState<'all' | 'pending'>('pending');
  const [shownCount, setShownCount] = useState(HISTORY_PAGE);
  const [moduleFilter, setModuleFilter] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  /** Batches decided or reverted on this visit stay in „Čeká na schválení“ so the result and Vrátit vše stay visible. */
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const touch = (batchKey: string) => setTouched((previous) => new Set([...previous, batchKey]));

  useEffect(() => agentQueueData.ensure('queue'), []);

  /** `?davka=<batchId>` from an MCP review link: show that batch, scroll to it once and highlight it. */
  const search = useRouterState({ select: (routerState) => routerState.location.searchStr });
  const targetKey = batchKeyFromSearch(search);
  const targetItemKey = itemKeyFromSearch(search);
  const scrolledTo = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (queue.state !== 'ready' || targetKey === undefined || scrolledTo.current === targetKey) {
      return;
    }
    const index = queue.value.batches.findIndex((batch) => batch.key === targetKey);
    const target = queue.value.batches[index];
    if (target === undefined) {
      return;
    }
    if (moduleFilter !== '') {
      setModuleFilter('');
      return;
    }
    const pendingHere = target.items.some((item) => item.status === 'pending');
    if (!pendingHere && filter !== 'all') {
      setFilter('all');
      return;
    }
    if (filter === 'all' && shownCount < index + 1) {
      setShownCount(index + 1);
      return;
    }
    const batchElement = document.querySelector<HTMLElement>(`[data-batch-key="${CSS.escape(targetKey)}"]`);
    const element =
      targetItemKey === undefined
        ? batchElement
        : batchElement?.querySelector<HTMLElement>(`[data-item-key="${CSS.escape(targetItemKey)}"]`);
    if (element != null && targetItemKey !== undefined) {
      element.focus({ preventScroll: true });
    }
    if (element != null) {
      scrolledTo.current = targetKey;
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [queue, targetKey, targetItemKey, filter, moduleFilter, shownCount]);

  const finish = (text: string) => {
    setMessage(text);
    setBusy(false);
    refresh();
  };

  const onDecide = (batch: AgentQueueBatch, keys: readonly string[], decision: Decision, note: string) => {
    setBusy(true);
    touch(batch.key);
    void decideAgentItems({
      batchKey: batch.key,
      decision,
      itemKeys: [...keys],
      ...(note === '' ? {} : { note }),
    }).then((result) => {
      if (result.status !== 'ok') {
        finish('Rozhodnutí se nepodařilo uložit. Zkuste to prosím znovu.');
        return;
      }
      const settled = result.value.results.every(
        (entry) => entry.outcome === 'applied' || entry.outcome === 'rejected',
      );
      if (settled) {
        finish(
          decision === 'approve'
            ? 'Rozhodnutí uloženo. Výsledek vidíte u jednotlivých změn.'
            : 'Návrhy zamítnuty. Data zůstala beze změny.',
        );
        return;
      }
      const messages = result.value.results
        .map((entry) => entry.message)
        .filter((text): text is string => text !== undefined && text !== '');
      finish(`Některé změny se nepodařilo provést: ${messages.join(' ')}`);
    });
  };

  const onRevert = (batch: AgentQueueBatch, note: string) => {
    setBusy(true);
    touch(batch.key);
    void revertAgentBatch({ batchKey: batch.key, ...(note === '' ? {} : { note }) }).then((result) => {
      finish(result.status === 'ok' ? result.value.message : 'Dávku se nepodařilo vrátit. Zkuste to prosím znovu.');
    });
  };

  if (queue.state === 'pending') {
    return <ModulePageSkeleton />;
  }
  if (queue.state === 'failed') {
    return (
      <div className="ai-review">
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
  const moduleLabels = Array.from(new Set(response.batches.flatMap((batch) => batch.moduleLabels)));
  const visibleBatches = response.batches.filter(
    (batch) =>
      (filter === 'all' || touched.has(batch.key) || batch.items.some((item) => item.status === 'pending')) &&
      (moduleFilter === '' || batch.moduleLabels.includes(moduleFilter)),
  );
  // „Všechny dávky“ shows the newest batches first and older history on request.
  const shownBatches = filter === 'all' ? visibleBatches.slice(0, shownCount) : visibleBatches;
  const hiddenCount = visibleBatches.length - shownBatches.length;
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
        <Button disabled={busy} onClick={refresh} size="sm" theme="outlined" variant="secondary">
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
      <div className="ai-review-actions agent-filters" role="group" aria-label="Zobrazení dávek">
        <Button
          aria-pressed={filter === 'pending'}
          onClick={() => setFilter('pending')}
          size="sm"
          theme={filter === 'pending' ? 'solid' : 'outlined'}
          variant={filter === 'pending' ? 'primary' : 'secondary'}
        >
          Čeká na schválení
        </Button>
        <Button
          aria-pressed={filter === 'all'}
          onClick={() => setFilter('all')}
          size="sm"
          theme={filter === 'all' ? 'solid' : 'outlined'}
          variant={filter === 'all' ? 'primary' : 'secondary'}
        >
          Všechny dávky
        </Button>
        <label>
          <span>Modul</span>
          <select onChange={(event) => setModuleFilter(event.target.value)} value={moduleFilter}>
            <option value="">Všechny moduly</option>
            {moduleLabels.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {message !== '' && (
        <StatusText aria-live="polite" size="sm" status="default">
          {message}
        </StatusText>
      )}
      {missingTarget && (
        <StatusText aria-live="polite" showIcon size="sm" status="warning">
          Návrh z odkazu tu nevidíte. Možná patří jiné firmě, byl odstraněn, nebo k němu nemáte přístup.
        </StatusText>
      )}
      {visibleBatches.length === 0 ? (
        filter === 'pending' ? (
          <div>
            <h2 className="font-semibold text-sm">Nic nečeká na schválení</h2>
            <p className="text-fg-secondary text-sm">Jakmile AI agent pošle návrh změny, objeví se tady.</p>
          </div>
        ) : (
          <p className="text-fg-secondary text-sm">Zatím tu nejsou žádné dávky návrhů.</p>
        )
      ) : (
        shownBatches.map((batch) => (
          <BatchCard
            batch={batch}
            busy={busy}
            highlighted={batch.key === targetKey}
            targetItemKey={targetItemKey}
            key={batch.key}
            onDecide={onDecide}
            onRevert={onRevert}
          />
        ))
      )}
      {hiddenCount > 0 && (
        <div>
          <Button
            onClick={() => setShownCount((count) => count + HISTORY_PAGE)}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {`Zobrazit starší dávky (${hiddenCount})`}
          </Button>
        </div>
      )}
      <div>
        <LinkButton as={LocalizedLink} size="sm" theme="outlined" to="/sprava/aktivita-agentu" variant="primary">
          Zobrazit aktivitu agentů
        </LinkButton>
      </div>
    </div>
  );
};
