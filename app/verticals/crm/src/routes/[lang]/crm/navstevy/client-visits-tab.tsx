import { pipe, DateTime } from 'effect';

// Client-card "Návštěvy" tab. OWNER: crm-visits. Contract: export name + ClientCardTabProps (klienti/card-tab-props.ts).
// The card itself is a SidePanel, so everything here is inline (no stacked dialogs): summary facts, inline
// "record visit" and "plan contact" forms, open plan items, and the client's timeline with correction history.
import { EmptyState, formatNumber, surfaceTileClassName } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { lastVisitOf, nextPlanItemOf } from '../../../../../shared/domain/visits.ts';
import type { Visit } from '../../../../../shared/domain/visits.ts';

import type { ClientCardTabProps } from '../klienti/card-tab-props.ts';
import { ClientPlanForm, ClientVisitForm } from './client-visit-forms.tsx';

import { VisitTimeline } from './visit-timeline.tsx';
import {
  formatDay,
  formatVisitTime,
  localDay,
  principalLabel,
  relativeDay,
  salespersonLabel,
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

const useClientVisits = ({ client, records, submit }: ClientCardTabProps) => {
  const { language } = useModernI18n();
  const today = localDay(records.now);
  const visits = records.state.visits.items.filter((visit) => visit.clientId === client.id);
  const last = lastVisitOf(visits, client.id);
  const next = nextPlanItemOf(records.state.visits.plan, client.id);
  const openPlan = sortPlanAsc(
    records.state.visits.plan.filter((item) => item.clientId === client.id && item.status === 'open'),
  );
  const canWrite = writableClients(records).some((entry) => entry.id === client.id);
  const [mode, setMode] = useState<'none' | 'visit' | 'plan'>('none');
  const [openVisitId, setOpenVisitId] = useState<string | undefined>();
  const openVisit = visits.find((visit) => visit.id === openVisitId);

  return {
    canWrite,
    client,
    language,
    last,
    mode,
    next,
    openPlan,
    openVisit,
    records,
    setMode,
    setOpenVisitId,
    submit,
    today,
    visits,
  };
};

export const ClientVisitsTab = (props: ClientCardTabProps) => {
  const { t } = useModernI18n();
  const {
    canWrite,
    client,
    language,
    last,
    mode,
    next,
    openPlan,
    openVisit,
    records,
    setMode,
    setOpenVisitId,
    submit,
    today,
    visits,
  } = useClientVisits(props);
  const closeForm = () => setMode('none');

  return (
    <div className="flex flex-col gap-250">
      <div className={`${surfaceTileClassName} grid grid-cols-2 gap-200 p-200`}>
        <Fact label={t('crm.ciClientsVisits.visits.lastContact')}>
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
        <Fact label={t('crm.ciClientsVisits.visits.nextPlannedContact')}>
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
        <Fact label={t('crm.ciClientsVisits.clients.assignedSalesperson')}>
          {salespersonLabel(records, client.ownerSalespersonId)}
        </Fact>
        <Fact label={t('crm.ciClientsVisits.visits.recordedContacts')}>{formatNumber(visits.length)}</Fact>
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
            className="inline-flex items-center gap-50 px-100 font-medium underline text-sm underline-offset-2 hover:underline"
            href={`/${language ?? 'cs'}/crm/navstevy?klient=${encodeURIComponent(client.id)}`}
          >
            Časová osa v Návštěvách
          </a>
        </div>
      )}

      {mode === 'visit' && (
        <ClientVisitForm clientId={client.id} onClose={closeForm} records={records} submit={submit} />
      )}
      {mode === 'plan' && <ClientPlanForm clientId={client.id} onClose={closeForm} records={records} submit={submit} />}

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
        <EmptyState
          description="U klienta zatím není zapsaný žádný kontakt."
          title={t('crm.ciClientsVisits.visits.empty')}
        />
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
