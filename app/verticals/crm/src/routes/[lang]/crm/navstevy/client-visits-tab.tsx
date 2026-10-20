// Client-card "Návštěvy" tab. OWNER: crm-visits. Contract: export name + ClientCardTabProps (klienti/card-tab-props.ts).
// The card itself is a SidePanel, so everything here is inline (no stacked dialogs): summary facts, inline
// "record visit" and "plan contact" forms, open plan items, and the client's timeline with correction history.
import { EmptyState, formatNumber } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Visit } from '../../../../../shared/domain/visits.ts';
import { lastVisitOf, nextPlanItemOf } from '../../../../../shared/domain/visits.ts';
import type { ClientCardTabProps } from '../klienti/card-tab-props.ts';
import type { VisitDraft } from './visit-panels.tsx';
import { VisitFields, emptyVisitDraft } from './visit-panels.tsx';
import { VisitTimeline } from './visit-timeline.tsx';
import {
  formatDay,
  formatVisitTime,
  isoFromLocal,
  localDay,
  principalLabel,
  relativeDay,
  salespersonLabel,
  shiftDay,
  sortPlanAsc,
  visitKindMeta,
  writableClients,
} from './visits-model.ts';

const Fact = ({ children, label }: { readonly children: ReactNode; readonly label: string }) => (
  <div className="flex min-w-0 flex-col gap-50">
    <span className="text-fg-secondary text-xs">{label}</span>
    <span className="text-sm">{children}</span>
  </div>
);

const InlineVisitDetail = ({
  onClose,
  records,
  visit,
}: { readonly onClose: () => void } & Pick<ClientCardTabProps, 'records'> & { readonly visit: Visit }) => (
  <div className="flex flex-col gap-150 rounded-lg border border-border-primary bg-surface p-200">
    <div className="flex items-start justify-between gap-150">
      <div className="flex flex-col gap-50">
        <span className="font-semibold text-sm">{visit.result}</span>
        <span className="text-fg-secondary text-xs">
          {`${visitKindMeta[visit.kind].label} · ${formatVisitTime(visit.occurredAt)} · ${salespersonLabel(records, visit.salespersonId)} · zapsal(a) ${principalLabel(records, visit.authorPrincipalId)}`}
        </span>
      </div>
      <Button onClick={onClose} size="sm" theme="borderless" variant="secondary">
        Skrýt
      </Button>
    </div>
    {visit.note !== undefined && <p className="text-sm">{visit.note}</p>}
    {visit.nextStep !== undefined && (
      <p className="text-sm">{`Další krok: ${visit.nextStep}${visit.nextStepDate === undefined ? '' : ` (${formatDay(visit.nextStepDate)})`}`}</p>
    )}
    <span className="font-medium text-xs">{`Historie oprav (${String(visit.corrections.length)})`}</span>
    {visit.corrections.length === 0 ? (
      <span className="text-fg-secondary text-xs">Záznam nebyl opravován.</span>
    ) : (
      <ol className="flex flex-col gap-100">
        {visit.corrections.toReversed().map((correction, index) => (
          <li className="flex flex-col text-xs" key={`${correction.at}-${String(index)}`}>
            <span className="text-fg-secondary">
              {`${formatVisitTime(correction.at)} · ${principalLabel(records, correction.by)} · ${correction.field}${correction.reason === undefined ? '' : ` · ${correction.reason}`}`}
            </span>
            <span>
              <span className="text-fg-secondary line-through">{correction.previous ?? '(prázdné)'}</span>
              {' → '}
              {correction.next ?? '(smazáno)'}
            </span>
          </li>
        ))}
      </ol>
    )}
  </div>
);

export const ClientVisitsTab = ({ busy, client, records, submit }: ClientCardTabProps) => {
  const { language } = useModernI18n();
  const toaster = useToast();
  const today = localDay(records.now);
  const visits = records.state.visits.items.filter((visit) => visit.clientId === client.id);
  const last = lastVisitOf(visits, client.id);
  const next = nextPlanItemOf(records.state.visits.plan, client.id);
  const openPlan = sortPlanAsc(
    records.state.visits.plan.filter((item) => item.clientId === client.id && item.status === 'open'),
  );
  const canWrite = writableClients(records).some((entry) => entry.id === client.id);
  const [mode, setMode] = useState<'none' | 'visit' | 'plan'>('none');
  const [draft, setDraft] = useState<VisitDraft>(() => emptyVisitDraft(records, client.id));
  const [planDate, setPlanDate] = useState(() => shiftDay(today, 7));
  const [planNote, setPlanNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [openVisitId, setOpenVisitId] = useState<string | undefined>();
  const openVisit = visits.find((visit) => visit.id === openVisitId);

  const reset = () => {
    setMode('none');
    setDraft(emptyVisitDraft(records, client.id));
    setPlanNote('');
    setPlanDate(shiftDay(today, 7));
    setSubmitted(false);
    setError(undefined);
  };
  const saveVisit = () => {
    setSubmitted(true);
    const occurredAt = isoFromLocal(draft.date, draft.time);
    if (draft.result.trim() === '' || occurredAt === undefined) {
      return;
    }
    void submit({
      _tag: 'RecordVisit',
      clientId: client.id,
      kind: draft.kind,
      occurredAt,
      result: draft.result.trim(),
      ...(draft.note.trim() === '' ? {} : { note: draft.note.trim() }),
      ...(draft.nextStep.trim() === '' ? {} : { nextStep: draft.nextStep.trim() }),
      ...(draft.nextStepDate === '' ? {} : { addToPlan: draft.addToPlan, nextStepDate: draft.nextStepDate }),
    }).then((outcome) => {
      if (outcome.ok) {
        toaster.create({ title: `${visitKindMeta[draft.kind].label} zapsán(a)`, type: 'success' });
        reset();
      } else {
        setError(outcome.message ?? 'Záznam se nepodařilo uložit.');
      }
    });
  };
  const savePlan = () => {
    setSubmitted(true);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(planDate)) {
      return;
    }
    void submit({
      _tag: 'PlanContact',
      clientId: client.id,
      dueDate: planDate,
      ...(planNote.trim() === '' ? {} : { note: planNote.trim() }),
    }).then((outcome) => {
      if (outcome.ok) {
        toaster.create({ description: formatDay(planDate), title: 'Kontakt naplánován', type: 'success' });
        reset();
      } else {
        setError(outcome.message ?? 'Uložení se nezdařilo.');
      }
    });
  };

  return (
    <div className="flex flex-col gap-250">
      <div className="grid grid-cols-2 gap-200 rounded-lg border border-border-primary p-200">
        <Fact label="Poslední kontakt">
          {last === undefined ? (
            <span className="text-fg-secondary">bez zapsaného kontaktu</span>
          ) : (
            <>
              <span className="font-medium">{formatDay(localDay(last.occurredAt))}</span>
              {` · ${relativeDay(localDay(last.occurredAt), today)}`}
              <span className="block text-fg-secondary text-xs">
                {`${visitKindMeta[last.kind].label} · ${salespersonLabel(records, last.salespersonId)} · ${last.result}`}
              </span>
            </>
          )}
        </Fact>
        <Fact label="Příští plánovaný kontakt">
          {next === undefined ? (
            <span className="text-fg-secondary">nenaplánováno</span>
          ) : (
            <>
              <span className="font-medium">{formatDay(next.dueDate)}</span>
              {` · ${relativeDay(next.dueDate, today)}`}
              {next.note !== undefined && <span className="block text-fg-secondary text-xs">{next.note}</span>}
            </>
          )}
        </Fact>
        <Fact label="Přidělený obchodník">{salespersonLabel(records, client.ownerSalespersonId)}</Fact>
        <Fact label="Zapsané kontakty">{formatNumber(visits.length)}</Fact>
      </div>

      {canWrite && mode === 'none' && (
        <div className="flex flex-wrap gap-100">
          <Button icon="icon-[mdi--plus]" onClick={() => setMode('visit')} size="sm" variant="primary">
            Zapsat návštěvu
          </Button>
          <Button
            icon="icon-[mdi--calendar-plus]"
            onClick={() => setMode('plan')}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            Naplánovat kontakt
          </Button>
          <a
            className="inline-flex items-center gap-50 px-100 text-link text-sm underline-offset-2 hover:underline"
            href={`/${language ?? 'cs'}/crm/navstevy?klient=${encodeURIComponent(client.id)}`}
          >
            Časová osa v Návštěvách
          </a>
        </div>
      )}

      {mode !== 'none' && (
        <form
          className="flex flex-col gap-200 rounded-lg border border-border-primary bg-surface p-250"
          onSubmit={(event) => {
            event.preventDefault();
            if (mode === 'visit') {
              saveVisit();
            } else {
              savePlan();
            }
          }}
        >
          <span className="font-semibold text-sm">{mode === 'visit' ? 'Zapsat návštěvu' : 'Naplánovat kontakt'}</span>
          {error !== undefined && (
            <StatusText showIcon status="error">
              {error}
            </StatusText>
          )}
          {mode === 'visit' ? (
            <>
              <VisitFields
                draft={draft}
                idPrefix="crm-card-visit"
                onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
                records={records}
                showClient={false}
                showSalesperson={false}
                submitted={submitted}
              />
              {draft.nextStepDate !== '' && (
                <FormCheckbox
                  checked={draft.addToPlan}
                  id="crm-card-visit-plan"
                  label="Zařadit další krok do plánu K oslovení"
                  onCheckedChange={(checked) => setDraft((current) => ({ ...current, addToPlan: checked }))}
                  size="sm"
                />
              )}
            </>
          ) : (
            <>
              <FormInput
                helpText={`${formatDay(planDate)} · ${relativeDay(planDate, today)}`}
                id="crm-card-plan-date"
                label="Ozvat se dne"
                min={today}
                name="dueDate"
                onChange={(event) => setPlanDate(event.target.value)}
                required
                type="date"
                value={planDate}
              />
              <FormTextarea
                id="crm-card-plan-note"
                label="Poznámka"
                name="note"
                onChange={(event) => setPlanNote(event.target.value)}
                rows={2}
                value={planNote}
              />
              <span className="text-fg-secondary text-xs">Ruční plán obchodníka, nejde o doporučení systému.</span>
            </>
          )}
          <div className="flex justify-end gap-100">
            <Button onClick={reset} size="sm" theme="outlined" variant="secondary">
              Zrušit
            </Button>
            <Button isLoading={busy} loadingText="Ukládám…" size="sm" type="submit" variant="primary">
              {mode === 'visit' ? 'Zapsat' : 'Naplánovat'}
            </Button>
          </div>
        </form>
      )}

      {openPlan.length > 0 && (
        <section className="flex flex-col gap-100">
          <span className="font-semibold text-sm">Naplánované kontakty</span>
          <ul className="flex flex-col gap-100">
            {openPlan.map((item) => (
              <li
                className="flex flex-wrap items-center gap-150 rounded-md border border-border-primary px-200 py-150 text-sm"
                key={item.id}
              >
                <span aria-hidden="true" className="icon-[mdi--calendar-clock] size-200 text-fg-secondary" />
                <span className="font-medium">{formatDay(item.dueDate)}</span>
                <Badge size="sm" variant={item.dueDate < today ? 'danger' : 'outline'}>
                  {relativeDay(item.dueDate, today)}
                </Badge>
                <span className="min-w-0 flex-1 truncate">{item.note ?? 'bez poznámky'}</span>
                <span className="text-fg-secondary text-xs">{salespersonLabel(records, item.salespersonId)}</span>
              </li>
            ))}
          </ul>
          <a
            className="text-link text-xs underline-offset-2 hover:underline"
            href={`/${language ?? 'cs'}/crm/k-osloveni`}
          >
            Vyřídit v plánu K oslovení
          </a>
        </section>
      )}

      {openVisit !== undefined && (
        <InlineVisitDetail onClose={() => setOpenVisitId(undefined)} records={records} visit={openVisit} />
      )}

      {visits.length === 0 ? (
        <EmptyState description="U klienta zatím není zapsaný žádný kontakt." title="Bez návštěv" />
      ) : (
        <VisitTimeline
          onOpen={(visit) => setOpenVisitId(visit.id)}
          records={records}
          showClient={false}
          visits={visits}
        />
      )}
    </div>
  );
};
