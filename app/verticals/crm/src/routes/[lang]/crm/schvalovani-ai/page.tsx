import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { pipe, Effect, Option, Predicate, Schema } from 'effect';
import { Atom } from 'effect/reactivity';
import { orderDateText } from '../../../../../shared/domain/imports.ts';
import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';

import { EmptyState, PageHeader, SectionCard, formatDateTime } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { FormBuilder, FormReact, FormRoot, TextField, useAtomValue } from '@app/core-runtime/ui/form';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Accordion } from '@techsio/ui-kit/molecules/accordion';

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
    'Schvalovatel';
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

/**
 * The approver's note of one batch: every batch card has its own, and the batch's decisions and its revert send it. It
 * is never submitted.
 */
const batchNoteFormOf = Atom.family((_batchId: string) =>
  FormReact.make(FormBuilder.empty.addField('note', Schema.String), {
    fields: { note: TextField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  }),
);

const ChangeCard = ({
  busy,
  change,
  decide,
}: {
  readonly busy: boolean;
  readonly change: AiChange;
  readonly decide: (ids: readonly string[], decision: 'approve' | 'reject') => void;
}) => (
  <article className="flex min-w-0 flex-col gap-3.5 rounded-sm bg-surface p-3 sm:p-4" data-change-id={change.id}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 grow basis-64">
        <h3 className="font-semibold text-sm">{change.summary}</h3>
        <p className="text-fg-secondary text-sm">{change.target.label}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge severity={changeStatusVariant(change.status)}>{aiStatusLabel[change.status]}</Badge>
        <span className="text-fg-secondary text-xs">{aiRiskLabel[change.risk]}</span>
      </div>
    </div>
    <p className="max-w-[80ch] text-sm leading-normal wrap-anywhere">
      <span className="font-medium">Proč AI změnu navrhuje: </span>
      {change.reason}
    </p>
    <table
      aria-label={`Porovnání: ${change.summary}`}
      className="w-full table-fixed border-collapse overflow-hidden rounded-sm bg-base"
    >
      <thead>
        <tr className="bg-surface text-fg-secondary text-xs font-medium leading-normal">
          <th
            className="w-[27.2727%] px-1.5 py-2 align-top wrap-anywhere sm:px-3 sm:py-2.5 text-left font-medium"
            scope="col"
          >
            Údaj
          </th>
          <th className="px-1.5 py-2 align-top wrap-anywhere sm:px-3 sm:py-2.5 text-left font-medium" scope="col">
            Před změnou
          </th>
          <th className="px-1.5 py-2 align-top wrap-anywhere sm:px-3 sm:py-2.5 text-left font-medium" scope="col">
            Po schválení
          </th>
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
          <tr className="border-t border-border-primary/60 text-xs leading-normal sm:text-sm" key={line.field}>
            <th className="px-1.5 py-2 align-top wrap-anywhere sm:px-3 sm:py-2.5 text-left font-medium" scope="row">
              {line.label}
            </th>
            <td className="px-1.5 py-2 align-top wrap-anywhere sm:px-3 sm:py-2.5 bg-danger-light text-danger-fg">
              {line.before ?? 'Neuvedeno'}
            </td>
            <td className="px-1.5 py-2 align-top wrap-anywhere sm:px-3 sm:py-2.5 bg-success-light text-success-fg">
              {line.after ?? 'Vymazáno'}
            </td>
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
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          appearance="outline"
          disabled={busy}
          onClick={() => decide([change.id], 'reject')}
          severity="secondary"
          size="sm"
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
  const { t } = useModernI18n();
  const noteForm = batchNoteFormOf(batch.id);
  const note = Option.match(useAtomValue(noteForm.values), { onNone: () => '', onSome: (values) => values.note });
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
    <section className="min-w-0 overflow-hidden rounded-md border border-border-primary/60" data-batch-id={batch.id}>
      <header className="flex flex-col gap-4 p-3 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 grow basis-64">
            <p className="text-fg-secondary text-xs">
              {pipe(batch.createdAt, orderDateText, formatDateTime)} · {batch.agentLabel}
            </p>
            <h2 className="mt-1.5 max-w-[75ch] text-base font-semibold leading-normal wrap-anywhere sm:text-[1.1rem]">
              {batch.instruction}
            </h2>
          </div>
          <Badge severity={status.variant}>{status.label}</Badge>
        </div>
        {pending.length > 0 && (
          <>
            <FormRoot
              defaultValues={{ note: '' }}
              form={noteForm}
              translateMessage={(message) => t(message, { defaultValue: message })}
            >
              <noteForm.note
                id={`note-${batch.id}`}
                label={t('crm.ciWorkflow.decisionNote')}
                placeholder={t('crm.ciWorkflow.decisionNotePlaceholder')}
              />
            </FormRoot>
            <div className="flex flex-wrap items-center gap-2">
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
                appearance="outline"
                disabled={busy}
                onClick={() =>
                  decide(
                    pending.map((entry) => entry.id),
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
        {applied.length > 0 && batch.revertedAt === undefined && (
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
              Obnoví původní údaje celé dávky. Pozdější lidské úpravy nepřepíše.
            </span>
            {confirmRevert && (
              <div className="flex basis-full flex-col gap-3 border-l-2 border-warning p-4 text-sm" role="alert">
                <p>
                  Vrátit všechny provedené změny této dávky? Nově založené klienty a kontakty archivujeme; historii
                  zachováme.
                </p>
                <div className="flex flex-wrap items-center gap-2">
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
            Vráceno {pipe(batch.revertedAt, orderDateText, formatDateTime)} · {nameOf(records, batch.revertedBy ?? '')}
          </p>
        )}
      </header>
      <div className="flex flex-col gap-4 px-3 pb-3 sm:px-5 sm:pb-5">
        {changes.map((change) => (
          <ChangeCard busy={busy} change={change} decide={decide} key={change.id} />
        ))}
      </div>
    </section>
  );
};

const AiApprovalsContent = () => {
  const { t } = useModernI18n();
  const { busy, load, state, submit } = useCrmRecords();
  const [filter, setFilter] = useState<'all' | 'pending'>('pending');
  const [message, setMessage] = useState('');
  const [showFullLog, setShowFullLog] = useState(false);
  return (
    <>
      <PageHeader
        description="AI připraví návrh. Vy porovnáte údaje a rozhodnete. Bez vašeho souhlasu se nic nezmění."
        meta={<Badge severity="secondary">Úroveň C</Badge>}
        title={t('crm.pages.ai.title')}
      />
      <CrmStateGate onRetry={load} state={state}>
        {(records) => {
          if (!records.viewer.writeAll) {
            return (
              <EmptyState
                description="Změny AI může schválit nebo vrátit pouze správce a vedoucí obchodu."
                title={t('crm.ciWorkflow.managementApprovalsOnly')}
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
            <div className="flex min-w-0 flex-col gap-5">
              <div className="flex items-start gap-3 rounded-sm border-l-2 border-info bg-surface p-4 text-sm leading-relaxed">
                <span aria-hidden className="icon-[mdi--shield-check-outline] size-250 shrink-0" />
                <p className="max-w-[80ch]">
                  <strong>Pod kontrolou člověka.</strong> Agent smí pouze navrhovat změny CRM firmy Hanák. Každé
                  rozhodnutí má autora, čas a výsledek. Provedenou dávku lze bezpečně vrátit.
                </p>
              </div>
              <fieldset aria-label={t('crm.ciWorkflow.batchView')} className="flex flex-wrap items-center gap-2">
                <Button
                  appearance={filter === 'pending' ? 'solid' : 'outline'}
                  aria-pressed={filter === 'pending'}
                  onClick={() => setFilter('pending')}
                  severity={filter === 'pending' ? 'primary' : 'secondary'}
                  size="sm"
                >
                  Ke schválení
                </Button>
                <Button
                  appearance={filter === 'all' ? 'solid' : 'outline'}
                  aria-pressed={filter === 'all'}
                  onClick={() => setFilter('all')}
                  severity={filter === 'all' ? 'primary' : 'secondary'}
                  size="sm"
                >
                  Všechny dávky
                </Button>
              </fieldset>
              {message && <output className="rounded-sm bg-surface px-4 py-3.5 text-sm">{message}</output>}
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
                    <Accordion className="rounded-sm bg-surface" collapsible key={batch.id}>
                      <Accordion.Item value={batch.id}>
                        <Accordion.Header>
                          <Accordion.Title className="wrap-anywhere">{batch.instruction}</Accordion.Title>
                          <Accordion.Subtitle>
                            {pipe(batch.createdAt, orderDateText, formatDateTime)} ·{' '}
                            {batch.revertedAt === undefined ? 'Vyřízeno' : revertedBatchLabel}
                          </Accordion.Subtitle>
                          <Accordion.Indicator />
                        </Accordion.Header>
                        <Accordion.Content>{card}</Accordion.Content>
                      </Accordion.Item>
                    </Accordion>
                  ) : (
                    <div key={batch.id}>{card}</div>
                  );
                })
              )}
              <SectionCard title={t('crm.ciWorkflow.aiApprovalLog')}>
                {slice.log.length === 0 ? (
                  <p className="text-fg-secondary text-sm">Deník se naplní prvním návrhem AI.</p>
                ) : (
                  <ol className="flex max-w-[90ch] flex-col gap-4">
                    {slice.log
                      .toReversed()
                      .slice(0, showFullLog ? slice.log.length : 8)
                      .map((entry) => (
                        <li
                          className="flex flex-col gap-1 border-l-2 border-border-primary/60 pl-4 wrap-anywhere"
                          key={entry.id}
                        >
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
                  <Button
                    appearance="outline"
                    onClick={() => setShowFullLog(!showFullLog)}
                    severity="secondary"
                    size="sm"
                  >
                    {showFullLog ? 'Zobrazit jen poslední události' : `Zobrazit celý deník (${slice.log.length})`}
                  </Button>
                )}
              </SectionCard>
            </div>
          );
        }}
      </CrmStateGate>
    </>
  );
};

export const AiApprovalsPage = () => (
  <CrmPage titleKey="crm.pages.ai.title">
    <AiApprovalsContent />
  </CrmPage>
);
/** The Shell awaits this before it reveals the page, so the first render already has the records. */
export { preloadCrmRecords as preloadPage } from '../../../../crm/records.ts';
export default AiApprovalsPage;
