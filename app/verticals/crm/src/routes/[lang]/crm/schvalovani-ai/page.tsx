import { EmptyState, PageHeader, SectionCard, formatDateTime } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useState } from 'react';
import type { CrmCommand } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { AiBatch, AiChange } from '../../../../../shared/domain/ai-changes.ts';
import {
  aiRiskLabel,
  aiStatusLabel,
  initialAiChangesSlice,
  newClientContactsDiff,
} from '../../../../../shared/domain/ai-changes.ts';
import { CrmPage } from '../../../../crm/crm-page.tsx';
import type { CrmCommandOutcome } from '../../../../crm/records.ts';
import { useCrmRecords } from '../../../../crm/records.ts';
import { CrmStateGate } from '../../../../crm/ui.tsx';
import './review.css';

type Submit = (command: CrmCommand) => Promise<CrmCommandOutcome>;
// Fixed Hanák demo accounts from scripts/demo/permissions.mts, keyed by their UUIDv5 principal identity.
// Never attribute an unknown account to one of these people; keep its unambiguous account identifier.
const hanakReviewers: Readonly<Record<string, string>> = {
  '849fdb3c-fab6-5c14-b20a-d885dc27313d': 'Karel Hanák · spravce@hanak.demo',
  '8abb7df7-c19d-5d49-836a-2146dbe5064c': 'Lucie Dvořáková · vedouci@hanak.demo',
};
const nameOf = (records: RecordsResponse, principalId: string) => {
  const name =
    records.state.salespeople.find((entry) => entry.principalId === principalId)?.name ??
    hanakReviewers[principalId] ??
    records.state.aiChanges?.batches.find((entry) => entry.agentPrincipalId === principalId)?.agentLabel ??
    `Účet schvalovatele ${principalId}`;
  return records.viewer.principalId === principalId ? `${name} (vy)` : name;
};

const ChangeCard = ({
  change,
  busy,
  decide,
}: {
  readonly change: AiChange;
  readonly busy: boolean;
  readonly decide: (ids: readonly string[], decision: 'approve' | 'reject') => void;
}) => (
  <article className="ai-review-change" data-change-id={change.id}>
    <div className="ai-review-heading">
      <div>
        <h3 className="font-semibold text-sm">{change.summary}</h3>
        <p className="text-fg-secondary text-sm">{change.target.label}</p>
      </div>
      <div className="ai-review-actions">
        <Badge
          variant={change.status === 'pending' ? 'warning' : change.status === 'applied' ? 'success' : 'secondary'}
        >
          {aiStatusLabel[change.status]}
        </Badge>
        <span className="text-fg-secondary text-xs">{aiRiskLabel[change.risk]}</span>
      </div>
    </div>
    <p className="ai-review-reason">
      <span className="font-medium">Proč AI změnu navrhuje: </span>
      {change.reason}
    </p>
    <div className="ai-review-diff" role="table" aria-label={`Porovnání: ${change.summary}`}>
      <div className="ai-review-diff-head" role="row">
        <span role="columnheader">Údaj</span>
        <span role="columnheader">Před změnou</span>
        <span role="columnheader">Po schválení</span>
      </div>
      {(change.operation._tag === 'CreateClient'
        ? [
            ...change.diff.filter((line) => line.field !== 'contacts' && !line.field.startsWith('contacts.')),
            ...newClientContactsDiff(change.operation.contacts),
          ]
        : change.diff
      ).map((line) => (
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
    {change.failure && (
      <p className="text-sm" role="alert">
        Změnu nelze provést: {change.failure}
      </p>
    )}
    {change.decisionNote && <p className="text-fg-secondary text-sm">Poznámka schvalovatele: {change.decisionNote}</p>}
    {change.status === 'pending' && (
      <div className="ai-review-actions ai-review-end">
        <Button
          disabled={busy}
          onClick={() => decide([change.id], 'reject')}
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          Zamítnout změnu
        </Button>
        <Button disabled={busy} onClick={() => decide([change.id], 'approve')} size="sm">
          Schválit změnu
        </Button>
      </div>
    )}
  </article>
);

const BatchCard = ({
  batch,
  changes,
  busy,
  submit,
  feedback,
  records,
}: {
  readonly batch: AiBatch;
  readonly changes: readonly AiChange[];
  readonly busy: boolean;
  readonly submit: Submit;
  readonly feedback: (text: string) => void;
  readonly records: RecordsResponse;
}) => {
  const [note, setNote] = useState('');
  const [confirmRevert, setConfirmRevert] = useState(false);
  const pending = changes.filter((change) => change.status === 'pending');
  const applied = changes.filter((change) => change.status === 'applied');
  const decide = (ids: readonly string[], decision: 'approve' | 'reject') => {
    void submit({
      _tag: 'AiDecideChanges',
      changeIds: [...ids],
      decision,
      ...(note.trim() !== '' ? { note: note.trim() } : {}),
    }).then((result) =>
      feedback(
        result.ok
          ? decision === 'approve'
            ? 'Rozhodnutí uloženo. Zkontrolujte výsledek u jednotlivých změn.'
            : 'Návrhy zamítnuty. Data zůstala beze změny.'
          : 'Rozhodnutí se nepodařilo uložit. Záznam se mohl od návrhu změnit. Obnovte seznam a připravte nový návrh.',
      ),
    );
  };
  return (
    <section className="ai-review-batch" data-batch-id={batch.id}>
      <header className="ai-review-batch-header">
        <div className="ai-review-heading">
          <div>
            <p className="text-fg-secondary text-xs">
              {formatDateTime(batch.createdAt)} · {batch.agentLabel}
            </p>
            <h2 className="ai-review-instruction">{batch.instruction}</h2>
          </div>
          <Badge
            variant={
              batch.revertedAt !== undefined
                ? 'secondary'
                : pending.length > 0
                  ? 'warning'
                  : applied.length > 0
                    ? 'success'
                    : 'secondary'
            }
          >
            {batch.revertedAt !== undefined
              ? 'Dávka vrácena'
              : pending.length > 0
                ? `${pending.length} ke schválení`
                : applied.length > 0
                  ? 'Změny provedeny'
                  : 'Vyřízeno'}
          </Badge>
        </div>
        {pending.length > 0 && (
          <>
            <FormInput
              id={`note-${batch.id}`}
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
                    pending.map((entry) => entry.id),
                    'approve',
                  )
                }
                size="sm"
              >
                Schválit dávku ({pending.length})
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  decide(
                    pending.map((entry) => entry.id),
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
        {applied.length > 0 && batch.revertedAt === undefined && (
          <div className="ai-review-revert">
            <Button
              disabled={busy}
              onClick={() => setConfirmRevert(!confirmRevert)}
              theme="outlined"
              variant="secondary"
              size="sm"
            >
              Vrátit vše
            </Button>
            <span className="text-fg-secondary text-xs">
              Obnoví původní údaje celé dávky. Pozdější lidské úpravy nepřepíše.
            </span>
            {confirmRevert && (
              <div className="ai-review-confirm" role="alert">
                <p>
                  Vrátit všechny provedené změny této dávky? Nově založené klienty a kontakty archivujeme; historii
                  zachováme.
                </p>
                <div className="ai-review-actions">
                  <Button
                    disabled={busy}
                    size="sm"
                    onClick={() => {
                      void submit({
                        _tag: 'AiRevertBatch',
                        batchId: batch.id,
                        note: note || 'Vráceno na žádost schvalovatele',
                      }).then((result) => {
                        feedback(
                          result.ok
                            ? 'Celá dávka vrácena. Původní údaje obnoveny, historie zachována.'
                            : 'Dávku nelze vrátit, některý záznam se mezitím změnil. Pozdější úpravy zůstaly zachovány.',
                        );
                        setConfirmRevert(false);
                      });
                    }}
                  >
                    Potvrdit vrácení celé dávky
                  </Button>
                  <Button size="sm" theme="outlined" variant="secondary" onClick={() => setConfirmRevert(false)}>
                    Zrušit
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        {batch.revertedAt && (
          <p className="text-fg-secondary text-xs">
            Vráceno {formatDateTime(batch.revertedAt)} · {nameOf(records, batch.revertedBy ?? '')}
          </p>
        )}
      </header>
      <div className="ai-review-changes">
        {changes.map((change) => (
          <ChangeCard key={change.id} change={change} busy={busy} decide={decide} />
        ))}
      </div>
    </section>
  );
};

export const AiApprovalsPage = () => {
  const { state, busy, load, submit } = useCrmRecords();
  const [filter, setFilter] = useState<'all' | 'pending'>('pending');
  const [message, setMessage] = useState('');
  const [showFullLog, setShowFullLog] = useState(false);
  return (
    <CrmPage titleKey="crm.pages.ai.title">
      <PageHeader
        title="AI změny ke schválení"
        description="AI připraví návrh. Vy porovnáte údaje a rozhodnete. Bez vašeho souhlasu se nic nezmění."
        meta={<Badge variant="secondary">Úroveň C</Badge>}
        actions={
          <Button disabled={busy} onClick={load} theme="outlined" variant="secondary" size="sm">
            Obnovit seznam
          </Button>
        }
      />
      <CrmStateGate state={state} onRetry={load}>
        {(records) => {
          if (!records.viewer.writeAll)
            return (
              <EmptyState
                title="Schvalování je vyhrazeno vedení"
                description="Změny AI může schválit nebo vrátit pouze správce a vedoucí obchodu."
              />
            );
          const slice = records.state.aiChanges ?? initialAiChangesSlice;
          const batches = slice.batches
            .toReversed()
            .filter(
              (batch) =>
                filter === 'all' ||
                slice.changes.some((change) => change.batchId === batch.id && change.status === 'pending'),
            );
          return (
            <div className="ai-review">
              <div className="ai-review-safety">
                <span aria-hidden className="icon-[mdi--shield-check-outline] size-250" />
                <p>
                  <strong>Pod kontrolou člověka.</strong> Agent smí pouze navrhovat změny CRM firmy Hanák. Každé
                  rozhodnutí má autora, čas a výsledek. Provedenou dávku lze bezpečně vrátit.
                </p>
              </div>
              <div className="ai-review-actions" role="group" aria-label="Zobrazení dávek">
                <Button
                  size="sm"
                  theme={filter === 'pending' ? 'solid' : 'outlined'}
                  variant={filter === 'pending' ? 'primary' : 'secondary'}
                  aria-pressed={filter === 'pending'}
                  onClick={() => setFilter('pending')}
                >
                  Ke schválení
                </Button>
                <Button
                  size="sm"
                  theme={filter === 'all' ? 'solid' : 'outlined'}
                  variant={filter === 'all' ? 'primary' : 'secondary'}
                  aria-pressed={filter === 'all'}
                  onClick={() => setFilter('all')}
                >
                  Všechny dávky
                </Button>
              </div>
              {message && (
                <p className="ai-review-feedback" role="status">
                  {message}
                </p>
              )}
              {batches.length === 0 ? (
                <EmptyState
                  title={filter === 'pending' ? 'Žádné změny nečekají na schválení' : 'Zatím nemáte návrhy AI'}
                  description={
                    filter === 'pending'
                      ? 'Hotová rozhodnutí a možnost vrácení najdete ve Všech dávkách.'
                      : 'Připojte agenta s profilem C a požádejte ho o návrh úprav klientů. Návrh se uloží sem, nikoli přímo do dat.'
                  }
                />
              ) : (
                batches.map((batch, index) => {
                  const changes = slice.changes.filter((change) => change.batchId === batch.id);
                  const card = (
                    <BatchCard
                      batch={batch}
                      changes={changes}
                      records={records}
                      busy={busy}
                      submit={submit}
                      feedback={setMessage}
                    />
                  );
                  return index > 0 &&
                    changes.every((change) => change.status !== 'pending' && change.status !== 'applied') ? (
                    <details className="ai-review-history" key={batch.id}>
                      <summary>
                        <span>{batch.instruction}</span>
                        <span className="text-fg-secondary text-xs">
                          {formatDateTime(batch.createdAt)} ·{' '}
                          {batch.revertedAt === undefined ? 'Vyřízeno' : 'Dávka vrácena'}
                        </span>
                      </summary>
                      {card}
                    </details>
                  ) : (
                    <div key={batch.id}>{card}</div>
                  );
                })
              )}
              <SectionCard title="Deník AI a schvalování">
                {slice.log.length === 0 ? (
                  <p className="text-fg-secondary text-sm">Deník se naplní prvním návrhem AI.</p>
                ) : (
                  <ol className="ai-review-log">
                    {slice.log
                      .toReversed()
                      .slice(0, showFullLog ? slice.log.length : 8)
                      .map((entry) => (
                        <li key={entry.id}>
                          <div className="text-fg-secondary text-xs">
                            {formatDateTime(entry.at)} · {nameOf(records, entry.actorPrincipalId)} ·{' '}
                            {entry.actorKind === 'agent' ? 'AI návrh' : 'Lidské rozhodnutí'}
                          </div>
                          <p className="text-sm">{entry.message}</p>
                          <span className="text-fg-secondary text-xs">
                            {
                              (
                                {
                                  proposed: 'Uloženo ke schválení',
                                  auto_applied: 'Provedeno (historický záznam)',
                                  approved: 'Schváleno a provedeno',
                                  rejected: 'Zamítnuto',
                                  apply_failed: 'Neprovedeno',
                                  reverted: 'Vráceno',
                                  revert_conflict: 'Vrácení zablokováno',
                                  batch_reverted: 'Dávka vrácena',
                                } as const
                              )[entry.action]
                            }
                          </span>
                        </li>
                      ))}
                  </ol>
                )}
                {slice.log.length > 8 && (
                  <Button size="sm" theme="outlined" variant="secondary" onClick={() => setShowFullLog(!showFullLog)}>
                    {showFullLog ? 'Zobrazit jen poslední události' : `Zobrazit celý deník (${slice.log.length})`}
                  </Button>
                )}
              </SectionCard>
            </div>
          );
        }}
      </CrmStateGate>
    </CrmPage>
  );
};
export default AiApprovalsPage;
