import { Link as LocalizedLink } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { agentItemStatusLabel, agentRiskLabel } from '@app/shared-contracts/agent-proposals';
import type { AgentQueueBatch, AgentQueueItem, AgentQueueResponse } from '@app/shared-contracts/agent-proposals';
import { useCallback, useEffect, useState } from 'react';

import { decideAgentItems, formatAgentTime, loadAgentQueue, revertAgentBatch } from './agent-platform-client.ts';

/** In-module AI approval pages that keep showing their own batches next to this platform page. */
const moduleApprovalPage: Readonly<Record<string, { readonly label: string; readonly path: string }>> = {
  crm: { label: 'Otevřít v CRM', path: '/crm/schvalovani-ai' },
  merchandise: { label: 'Otevřít v Prodeji', path: '/prodej/schvalovani-ai' },
  'sales-pipeline': { label: 'Otevřít v Prodeji', path: '/prodej/schvalovani-ai' },
};

const moduleApprovalPageFor = (batch: AgentQueueBatch) =>
  batch.source === 'legacy' ? moduleApprovalPage[batch.key.split(':')[1] ?? ''] : undefined;

type Decision = 'approve' | 'reject';
type QueueState =
  | { readonly status: 'loading' }
  | { readonly response: AgentQueueResponse; readonly status: 'ready' }
  | { readonly httpStatus: number; readonly status: 'failed' };

const queueFailureText = (httpStatus: number): string => {
  if (httpStatus === 401) {
    return 'Přihlaste se prosím znovu.';
  }
  if (httpStatus === 403) {
    return 'Tato stránka je dostupná jen lidem, kteří schvalují změny.';
  }
  return 'Seznam návrhů se nepodařilo načíst.';
};

const ChangeCard = ({
  item,
  busy,
  decide,
}: {
  readonly item: AgentQueueItem;
  readonly busy: boolean;
  readonly decide: (keys: readonly string[], decision: Decision) => void;
}) => (
  <article className="ai-review-change" data-item-key={item.key}>
    <div className="ai-review-heading">
      <div>
        <h3 className="font-semibold text-sm">{item.summary}</h3>
        <p className="text-fg-secondary text-sm">{item.targetLabel}</p>
      </div>
      <div className="ai-review-actions">
        <Badge variant={item.status === 'pending' ? 'warning' : item.status === 'applied' ? 'success' : 'secondary'}>
          {agentItemStatusLabel[item.status]}
        </Badge>
        <span className="text-fg-secondary text-xs">{agentRiskLabel[item.risk]}</span>
        <span className="text-fg-secondary text-xs">{item.moduleLabel}</span>
      </div>
    </div>
    <p className="ai-review-reason">
      <span className="font-medium">Proč AI změnu navrhuje: </span>
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
            {line.before ?? 'Neuvedeno'}
          </span>
          <span className="ai-review-after" role="cell">
            {line.after ?? 'Vymazáno'}
          </span>
        </div>
      ))}
    </div>
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
        {`${agentItemStatusLabel[item.status]} · ${item.decidedByName ?? 'Neznámý uživatel'} · ${formatAgentTime(item.decidedAt)}`}
      </p>
    )}
    {item.status === 'applied' && item.revertUnavailableReason !== undefined && (
      <Badge title={item.revertUnavailableReason} variant="secondary">
        Nelze automaticky vrátit
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
        {`Tuto změnu může schválit jen člověk s oprávněním k zápisu v modulu ${item.moduleLabel}.`}
      </p>
    )}
  </article>
);

const BatchCard = ({
  batch,
  busy,
  onDecide,
  onRevert,
}: {
  readonly batch: AgentQueueBatch;
  readonly busy: boolean;
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
  const modulePage = moduleApprovalPageFor(batch);
  const badge =
    batch.revertedAt !== undefined
      ? { label: 'Dávka vrácena', variant: 'secondary' as const }
      : pending.length > 0
        ? { label: `${pending.length} ke schválení`, variant: 'warning' as const }
        : applied.length > 0
          ? { label: 'Změny provedeny', variant: 'success' as const }
          : { label: 'Vyřízeno', variant: 'secondary' as const };
  return (
    <section className="ai-review-batch" data-batch-key={batch.key}>
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
                <LinkButton as={LocalizedLink} size="sm" to={modulePage.path} variant="secondary">
                  {modulePage.label}
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
          <ChangeCard busy={busy} decide={decide} item={item} key={item.key} />
        ))}
      </div>
    </section>
  );
};

export const ApprovalsPanel = () => {
  const [queue, setQueue] = useState<QueueState>({ status: 'loading' });
  const [filter, setFilter] = useState<'all' | 'pending'>('pending');
  const [moduleFilter, setModuleFilter] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setQueue((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }));
    void loadAgentQueue().then((result) => {
      setQueue(
        result.status === 'ok'
          ? { response: result.value, status: 'ready' }
          : { httpStatus: result.httpStatus, status: 'failed' },
      );
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const finish = (text: string) => {
    setMessage(text);
    setBusy(false);
    refresh();
  };

  const onDecide = (batch: AgentQueueBatch, keys: readonly string[], decision: Decision, note: string) => {
    setBusy(true);
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
    void revertAgentBatch({ batchKey: batch.key, ...(note === '' ? {} : { note }) }).then((result) => {
      finish(result.status === 'ok' ? result.value.message : 'Dávku se nepodařilo vrátit. Zkuste to prosím znovu.');
    });
  };

  if (queue.status === 'loading') {
    return <StatusText status="default">Načítání návrhů…</StatusText>;
  }
  if (queue.status === 'failed') {
    return (
      <div className="ai-review">
        <StatusText aria-live="polite" showIcon status="error">
          {queueFailureText(queue.httpStatus)}
        </StatusText>
        {queue.httpStatus !== 401 && queue.httpStatus !== 403 && (
          <Button onClick={refresh} size="sm" theme="outlined" variant="secondary">
            Zkusit znovu
          </Button>
        )}
      </div>
    );
  }

  const { response } = queue;
  const moduleLabels = Array.from(new Set(response.batches.flatMap((batch) => batch.moduleLabels)));
  const visibleBatches = response.batches.filter(
    (batch) =>
      (filter === 'all' || batch.items.some((item) => item.status === 'pending')) &&
      (moduleFilter === '' || batch.moduleLabels.includes(moduleFilter)),
  );

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
          {`Návrhy z modulů ${response.unavailableModules.join(', ')} se teď nepodařilo načíst.`}
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
        <StatusText aria-live="polite" status="default">
          {message}
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
        visibleBatches.map((batch) => (
          <BatchCard batch={batch} busy={busy} key={batch.key} onDecide={onDecide} onRevert={onRevert} />
        ))
      )}
      <div>
        <LinkButton as={LocalizedLink} to="/sprava/aktivita-agentu" variant="secondary">
          Zobrazit aktivitu agentů
        </LinkButton>
      </div>
    </div>
  );
};
