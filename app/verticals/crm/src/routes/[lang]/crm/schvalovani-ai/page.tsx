import { pipe, Effect, Predicate } from 'effect';
import { orderDateText } from '../../../../../shared/domain/imports.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';

import { EmptyState, PageHeader, SectionCard, formatDateTime } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';

import { useState } from 'react';
import type { CrmCommandInput } from '../../../../../shared/actions/apply-command.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import {
  aiRiskLabel,
  aiStatusLabel,
  initialAiChangesSlice,
  newClientContactsDiff,
} from '../../../../../shared/domain/ai-changes.ts';
import type { AiBatch, AiChange } from '../../../../../shared/domain/ai-changes.ts';

import { CrmPage } from '../../../../crm/crm-page.tsx';
import { useCrmRecords } from '../../../../crm/records.ts';
import type { CrmCommandSubmit } from '../../../../crm/records.ts';

import { CrmStateGate } from '../../../../crm/ui.tsx';
import './review.css';

type Submit = CrmCommandSubmit;
// Fixed Hanák demo accounts from scripts/demo/permissions.mts, keyed by their UUIDv5 principal identity.
// Never attribute an unknown account to one of these people; keep its unambiguous account identifier.
const revertedBatchLabel = 'Dávka vrácena';

const hanakReviewers = new Map(
  Object.entries({
    '849fdb3c-fab6-5c14-b20a-d885dc27313d': 'Karel Hanák · spravce@hanak.demo',
    '8abb7df7-c19d-5d49-836a-2146dbe5064c': 'Lucie Dvořáková · vedouci@hanak.demo',
  }),
);
const nameOf = (records: RecordsResponse, principalId: string) => {
  const name =
    records.state.salespeople.find((entry) => entry.principalId === principalId)?.name ??
    hanakReviewers.get(principalId) ??
    records.state.aiChanges?.batches.find((entry) => entry.agentPrincipalId === principalId)?.agentLabel ??
    `Účet schvalovatele ${principalId}`;
  return records.viewer.principalId === principalId ? `${name} (vy)` : name;
};

const changeStatusVariant = (status: AiChange['status']) => {
  if (status === 'pending') {
    return 'warning';
  }
  return status === 'applied' ? 'success' : 'secondary';
};

const batchStatus = (batch: AiBatch, pending: readonly AiChange[], applied: readonly AiChange[]) => {
  if (batch.revertedAt !== undefined) {
    return { label: revertedBatchLabel, variant: 'secondary' } as const;
  }
  if (pending.length > 0) {
    return { label: `${pending.length} ke schválení`, variant: 'warning' } as const;
  }
  if (applied.length > 0) {
    return { label: 'Změny provedeny', variant: 'success' } as const;
  }
  return { label: 'Vyřízeno', variant: 'secondary' } as const;
};

const ChangeCard = ({
  busy,
  change,
  decide,
}: {
  readonly busy: boolean;
  readonly change: AiChange;
  readonly decide: (ids: readonly string[], decision: 'approve' | 'reject') => void;
}) => (
  <article className="ai-review-change" data-change-id={change.id}>
    <div className="ai-review-heading">
      <div>
        <h3 className="font-semibold text-sm">{change.summary}</h3>
        <p className="text-fg-secondary text-sm">{change.target.label}</p>
      </div>
      <div className="ai-review-actions">
        <Badge variant={changeStatusVariant(change.status)}>{aiStatusLabel[change.status]}</Badge>
        <span className="text-fg-secondary text-xs">{aiRiskLabel[change.risk]}</span>
      </div>
    </div>
    <p className="ai-review-reason">
      <span className="font-medium">Proč AI změnu navrhuje: </span>
      {change.reason}
    </p>
    <table aria-label={`Porovnání: ${change.summary}`} className="ai-review-diff">
      <thead>
        <tr className="ai-review-diff-head">
          <th scope="col">Údaj</th>
          <th scope="col">Před změnou</th>
          <th scope="col">Po schválení</th>
        </tr>
      </thead>
      <tbody>
        {(Predicate.isTagged(change.operation, 'CreateClient')
          ? [
              ...change.diff.filter((line) => line.field !== 'contacts' && !line.field.startsWith('contacts.')),
              ...newClientContactsDiff(change.operation.contacts),
            ]
          : change.diff
        ).map((line) => (
          <tr className="ai-review-diff-row" key={line.field}>
            <th className="font-medium" scope="row">
              {line.label}
            </th>
            <td className="ai-review-before">{line.before ?? 'Neuvedeno'}</td>
            <td className="ai-review-after">{line.after ?? 'Vymazáno'}</td>
          </tr>
        ))}
      </tbody>
    </table>
    {change.failure !== undefined && change.failure !== '' && (
      <p className="text-sm" role="alert">
        Změnu nelze provést: {change.failure}
      </p>
    )}
    {change.decisionNote !== undefined && change.decisionNote !== '' && (
      <p className="text-fg-secondary text-sm">Poznámka schvalovatele: {change.decisionNote}</p>
    )}
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
  busy,
  changes,
  feedback,
  records,
  submit,
}: {
  readonly batch: AiBatch;
  readonly busy: boolean;
  readonly changes: readonly AiChange[];
  readonly feedback: (text: string) => void;
  readonly records: RecordsResponse;
  readonly submit: Submit;
}) => {
  const [note, setNote] = useState('');
  const [confirmRevert, setConfirmRevert] = useState(false);
  const pending = changes.filter((change) => change.status === 'pending');
  const applied = changes.filter((change) => change.status === 'applied');
  const status = batchStatus(batch, pending, applied);
  const decide = (ids: readonly string[], decision: 'approve' | 'reject') => {
    const command: Extract<CrmCommandInput, { readonly _tag: 'AiDecideChanges' }> = {
      _tag: 'AiDecideChanges',
      changeIds: [...ids],
      decision,
    };
    if (note.trim() !== '') {
      Object.assign(command, { note: note.trim() });
    }
    browserRuntime.runFork(
      submit(command).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            let message =
              'Rozhodnutí se nepodařilo uložit. Záznam se mohl od návrhu změnit. Obnovte seznam a připravte nový návrh.';
            if (result.ok) {
              message =
                decision === 'approve'
                  ? 'Rozhodnutí uloženo. Zkontrolujte výsledek u jednotlivých změn.'
                  : 'Návrhy zamítnuty. Data zůstala beze změny.';
            }
            feedback(message);
          }),
        ),
      ),
    );
  };
  return (
    <section className="ai-review-batch" data-batch-id={batch.id}>
      <header className="ai-review-batch-header">
        <div className="ai-review-heading">
          <div>
            <p className="text-fg-secondary text-xs">
              {pipe(batch.createdAt, orderDateText, formatDateTime)} · {batch.agentLabel}
            </p>
            <h2 className="ai-review-instruction">{batch.instruction}</h2>
          </div>
          <Badge variant={status.variant}>{status.label}</Badge>
        </div>
        {pending.length > 0 && (
          <>
            <FormInput
              id={`note-${batch.id}`}
              label="Poznámka k rozhodnutí (nepovinná)"
              onChange={(event) => setNote(event.target.value)}
              placeholder="Např. ověřeno s obchodníkem"
              value={note}
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
              size="sm"
              theme="outlined"
              variant="secondary"
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
                    onClick={() => {
                      browserRuntime.runFork(
                        submit({
                          _tag: 'AiRevertBatch',
                          batchId: batch.id,
                          note: note || 'Vráceno na žádost schvalovatele',
                        }).pipe(
                          Effect.tap((result) =>
                            Effect.sync(() => {
                              feedback(
                                result.ok
                                  ? 'Celá dávka vrácena. Původní údaje obnoveny, historie zachována.'
                                  : 'Dávku nelze vrátit, některý záznam se mezitím změnil. Pozdější úpravy zůstaly zachovány.',
                              );
                              setConfirmRevert(false);
                            }),
                          ),
                        ),
                      );
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
            Vráceno {pipe(batch.revertedAt, orderDateText, formatDateTime)} · {nameOf(records, batch.revertedBy ?? '')}
          </p>
        )}
      </header>
      <div className="ai-review-changes">
        {changes.map((change) => (
          <ChangeCard busy={busy} change={change} decide={decide} key={change.id} />
        ))}
      </div>
    </section>
  );
};

export const AiApprovalsPage = () => {
  const { busy, load, state, submit } = useCrmRecords();
  const [filter, setFilter] = useState<'all' | 'pending'>('pending');
  const [message, setMessage] = useState('');
  const [showFullLog, setShowFullLog] = useState(false);
  return (
    <CrmPage titleKey="crm.pages.ai.title">
      <PageHeader
        actions={
          <Button disabled={busy} onClick={load} size="sm" theme="outlined" variant="secondary">
            Obnovit seznam
          </Button>
        }
        description="AI připraví návrh. Vy porovnáte údaje a rozhodnete. Bez vašeho souhlasu se nic nezmění."
        meta={<Badge variant="secondary">Úroveň C</Badge>}
        title="AI změny ke schválení"
      />
      <CrmStateGate onRetry={load} state={state}>
        {(records) => {
          if (!records.viewer.writeAll) {
            return (
              <EmptyState
                description="Změny AI může schválit nebo vrátit pouze správce a vedoucí obchodu."
                title="Schvalování je vyhrazeno vedení"
              />
            );
          }
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
              <fieldset aria-label="Zobrazení dávek" className="ai-review-actions">
                <Button
                  aria-pressed={filter === 'pending'}
                  onClick={() => setFilter('pending')}
                  size="sm"
                  theme={filter === 'pending' ? 'solid' : 'outlined'}
                  variant={filter === 'pending' ? 'primary' : 'secondary'}
                >
                  Ke schválení
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
              </fieldset>
              {message && <output className="ai-review-feedback">{message}</output>}
              {batches.length === 0 ? (
                <EmptyState
                  description={
                    filter === 'pending'
                      ? 'Hotová rozhodnutí a možnost vrácení najdete ve Všech dávkách.'
                      : 'Připojte agenta s profilem C a požádejte ho o návrh úprav klientů. Návrh se uloží sem, nikoli přímo do dat.'
                  }
                  title={filter === 'pending' ? 'Žádné změny nečekají na schválení' : 'Zatím nemáte návrhy AI'}
                />
              ) : (
                batches.map((batch, index) => {
                  const changes = slice.changes.filter((change) => change.batchId === batch.id);
                  const card = (
                    <BatchCard
                      batch={batch}
                      busy={busy}
                      changes={changes}
                      feedback={setMessage}
                      records={records}
                      submit={submit}
                    />
                  );
                  return index > 0 &&
                    changes.every((change) => change.status !== 'pending' && change.status !== 'applied') ? (
                    <details className="ai-review-history" key={batch.id}>
                      <summary>
                        <span>{batch.instruction}</span>
                        <span className="text-fg-secondary text-xs">
                          {pipe(batch.createdAt, orderDateText, formatDateTime)} ·{' '}
                          {batch.revertedAt === undefined ? 'Vyřízeno' : revertedBatchLabel}
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
                            {pipe(entry.at, orderDateText, formatDateTime)} · {nameOf(records, entry.actorPrincipalId)}{' '}
                            · {entry.actorKind === 'agent' ? 'AI návrh' : 'Lidské rozhodnutí'}
                          </div>
                          <p className="text-sm">{entry.message}</p>
                          <span className="text-fg-secondary text-xs">
                            {
                              (
                                {
                                  apply_failed: 'Neprovedeno',
                                  approved: 'Schváleno a provedeno',
                                  auto_applied: 'Provedeno (historický záznam)',
                                  batch_reverted: revertedBatchLabel,
                                  proposed: 'Uloženo ke schválení',
                                  rejected: 'Zamítnuto',
                                  revert_conflict: 'Vrácení zablokováno',
                                  reverted: 'Vráceno',
                                } as const
                              )[entry.action]
                            }
                          </span>
                        </li>
                      ))}
                  </ol>
                )}
                {slice.log.length > 8 && (
                  <Button onClick={() => setShowFullLog(!showFullLog)} size="sm" theme="outlined" variant="secondary">
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
/** The Shell awaits this before it reveals the page, so the first render already has the records. */
export { preloadCrmRecords as preloadPage } from '../../../../crm/records.ts';
export default AiApprovalsPage;
