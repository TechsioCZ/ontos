import { pipe, DateTime, Effect } from 'effect';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';

import type { CrmCommandInput } from '../../../../../shared/actions/apply-command.ts';
import { assignableSalespeople } from '../../../../crm/records.ts';
// Client-card "Návštěvy" tab. OWNER: crm-visits. Contract: export name + ClientCardTabProps (klienti/card-tab-props.ts).
// The card itself is a SidePanel, so everything here is inline (no stacked dialogs): summary facts, inline
// "record visit" and "plan contact" forms, open plan items, and the client's timeline with correction history.
import { EmptyState, formatNumber, surfaceTileClassName } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { lastVisitOf, nextPlanItemOf } from '../../../../../shared/domain/visits.ts';
import type { Visit } from '../../../../../shared/domain/visits.ts';

import type { ClientCardTabProps } from '../klienti/card-tab-props.ts';
import { VisitFields, emptyVisitDraft } from './visit-panels.tsx';
import type { VisitDraft } from './visit-panels.tsx';

import { VisitTimeline } from './visit-timeline.tsx';
import {
  czechError,
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
  <div className={`${surfaceTileClassName} flex flex-col gap-150 p-200`}>
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
      <p className="text-sm">
        Další krok: {visit.nextStep}
        {visit.nextStepDate === undefined ? '' : [' (', formatDay(visit.nextStepDate), ')'].join('')}
      </p>
    )}
    <span className="font-medium text-xs">{`Historie oprav (${String(visit.corrections.length)})`}</span>
    {visit.corrections.length === 0 ? (
      <span className="text-fg-secondary text-xs">Záznam nebyl opravován.</span>
    ) : (
      <ol className="flex flex-col gap-100">
        {visit.corrections.toReversed().map((correction, index) => (
          <li className="flex flex-col text-xs" key={`${DateTime.formatIso(correction.at)}-${String(index)}`}>
            <span className="text-fg-secondary">
              {`${formatVisitTime(correction.at)} · ${principalLabel(records, correction.by)} · ${correction.field}${correction.reason === undefined ? '' : [' · ', correction.reason].join('')}`}
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

const useClientVisits = ({ busy, client, records, submit }: ClientCardTabProps) => {
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
  const [form, setForm] = useState<{
    readonly draft: VisitDraft;
    readonly error?: string;
    readonly mode: 'none' | 'visit' | 'plan';
    readonly planDate: Extract<CrmCommandInput, { readonly _tag: 'PlanContact' }>['dueDate'];
    readonly planNote: string;
    readonly planSalesperson: string;
    readonly submitted: boolean;
  }>(() => ({
    draft: emptyVisitDraft(records, client.id),
    mode: 'none',
    planDate: shiftDay(today, 7),
    planNote: '',
    planSalesperson: '',
    submitted: false,
  }));
  const { draft, error, mode, planDate, planNote, planSalesperson, submitted } = form;
  const patchForm = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));
  const [openVisitId, setOpenVisitId] = useState<string | undefined>();
  const openVisit = visits.find((visit) => visit.id === openVisitId);

  const reset = () => {
    setForm({
      draft: emptyVisitDraft(records, client.id),
      mode: 'none',
      planDate: shiftDay(today, 7),
      planNote: '',
      planSalesperson: '',
      submitted: false,
    });
  };
  const saveVisit = () => {
    patchForm({ submitted: true });
    const occurredAt = isoFromLocal(draft.date, draft.time);
    if (draft.result.trim() === '' || occurredAt === undefined) {
      return;
    }
    const command: Extract<CrmCommandInput, { readonly _tag: 'RecordVisit' }> = {
      _tag: 'RecordVisit',
      clientId: client.id,
      kind: draft.kind,
      occurredAt,
      result: draft.result.trim(),
    };
    if (draft.note.trim() !== '') {
      Object.assign(command, { note: draft.note.trim() });
    }
    if (records.viewer.writeAll && draft.salespersonId !== '') {
      Object.assign(command, { salespersonId: draft.salespersonId });
    }
    if (draft.nextStep.trim() !== '') {
      Object.assign(command, { nextStep: draft.nextStep.trim() });
    }
    if (draft.nextStepDate !== '') {
      Object.assign(command, { addToPlan: draft.addToPlan, nextStepDate: draft.nextStepDate });
    }
    browserRuntime.runFork(
      submit(command).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            if (outcome.ok) {
              toaster.create({ title: `${visitKindMeta[draft.kind].label} zapsán(a)`, type: 'success' });
              reset();
            } else {
              patchForm({ error: czechError(outcome.message, 'Záznam se nepodařilo uložit.') });
            }
          }),
        ),
      ),
    );
  };
  const savePlan = () => {
    patchForm({ submitted: true });
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(planDate)) {
      return;
    }
    const command: Extract<CrmCommandInput, { readonly _tag: 'PlanContact' }> = {
      _tag: 'PlanContact',
      clientId: client.id,
      dueDate: planDate,
    };
    if (planNote.trim() !== '') {
      Object.assign(command, { note: planNote.trim() });
    }
    if (records.viewer.writeAll && planSalesperson !== '') {
      Object.assign(command, { salespersonId: planSalesperson });
    }
    browserRuntime.runFork(
      submit(command).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            if (outcome.ok) {
              toaster.create({ description: formatDay(planDate), title: 'Kontakt naplánován', type: 'success' });
              reset();
            } else {
              patchForm({ error: czechError(outcome.message, 'Uložení se nezdařilo.') });
            }
          }),
        ),
      ),
    );
  };

  return {
    busy,
    canWrite,
    client,
    draft,
    error,
    language,
    last,
    mode,
    next,
    openPlan,
    openVisit,
    patchForm,
    planDate,
    planNote,
    planSalesperson,
    records,
    reset,
    savePlan,
    saveVisit,
    setForm,
    setOpenVisitId,
    submitted,
    today,
    visits,
  };
};

export const ClientVisitsTab = (props: ClientCardTabProps) => {
  const {
    busy,
    canWrite,
    client,
    draft,
    error,
    language,
    last,
    mode,
    next,
    openPlan,
    openVisit,
    patchForm,
    planDate,
    planNote,
    planSalesperson,
    records,
    reset,
    savePlan,
    saveVisit,
    setForm,
    setOpenVisitId,
    submitted,
    today,
    visits,
  } = useClientVisits(props);

  return (
    <div className="flex flex-col gap-250">
      <div className={`${surfaceTileClassName} grid grid-cols-2 gap-200 p-200`}>
        <Fact label="Poslední kontakt">
          {last === undefined ? (
            <span className="text-fg-secondary">bez zapsaného kontaktu</span>
          ) : (
            <>
              <span className="font-medium">{pipe(last.occurredAt, localDay, formatDay)}</span>
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
          <Button icon="icon-[mdi--plus]" onClick={() => patchForm({ mode: 'visit' })} size="sm" variant="primary">
            Zapsat návštěvu
          </Button>
          <Button
            icon="icon-[mdi--calendar-plus]"
            onClick={() => patchForm({ mode: 'plan' })}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            Naplánovat kontakt
          </Button>
          <a
            className="inline-flex items-center gap-50 px-100 font-medium underline text-sm underline-offset-2 hover:underline"
            href={`/${language ?? 'cs'}/crm/navstevy?klient=${encodeURIComponent(client.id)}`}
          >
            Časová osa v Návštěvách
          </a>
        </div>
      )}

      {mode !== 'none' && (
        <form
          className={`${surfaceTileClassName} flex flex-col gap-200 p-250`}
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
                onChange={(patch) => setForm((current) => ({ ...current, draft: { ...current.draft, ...patch } }))}
                records={records}
                showClient={false}
                showSalesperson={records.viewer.writeAll}
                submitted={submitted}
              />
              {draft.nextStepDate !== '' && (
                <FormCheckbox
                  checked={draft.addToPlan}
                  id="crm-card-visit-plan"
                  label="Zařadit další krok do plánu K oslovení"
                  onCheckedChange={(checked) =>
                    setForm((current) => ({ ...current, draft: { ...current.draft, addToPlan: checked } }))
                  }
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
                onChange={(event) => patchForm({ planDate: event.target.value })}
                required
                size="sm"
                type="date"
                value={planDate}
              />
              <FormTextarea
                id="crm-card-plan-note"
                label="Poznámka"
                name="note"
                onChange={(event) => patchForm({ planNote: event.target.value })}
                rows={2}
                size="sm"
                value={planNote}
              />
              {records.viewer.writeAll && (
                <SelectTemplate
                  items={[
                    { label: 'Přidělený obchodník klienta', value: '' },
                    ...assignableSalespeople(records).map((person) => ({ label: person.name, value: person.id })),
                  ]}
                  label="Odpovědný obchodník"
                  name="planSalesperson"
                  onValueChange={(details) => patchForm({ planSalesperson: details.value[0] ?? '' })}
                  size="sm"
                  value={[planSalesperson]}
                />
              )}
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
                className={`${surfaceTileClassName} flex flex-wrap items-center gap-150 px-200 py-150 text-sm`}
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
            className="font-medium underline text-xs underline-offset-2 hover:underline"
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
