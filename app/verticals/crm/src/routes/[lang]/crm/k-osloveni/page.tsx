import { orderDateText } from '../../../../../shared/domain/imports.ts';
// AREA: visits (C06) — owned by the crm-visits lane. "K oslovení": the salesperson's manual contact plan
// (Můj plán), the lead's team overview (Tým) and completed items (Vyřízené). Only manually planned contacts appear
// here; automatic recommendations (C07) are parked until their rules are approved.
import {
  EmptyState,
  PageHeader,
  SectionCard,
  StatCard,
  StatRow,
  dividedListClassName,
  formatNumber,
} from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Tabs } from '@techsio/ui-kit/molecules/tabs';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { Schema } from 'effect';
import { useState } from 'react';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import { canSeeEverything } from '../../../../../shared/domain/access.ts';
import { lastVisitOf } from '../../../../../shared/domain/visits.ts';
import type { PlanItem } from '../../../../../shared/domain/visits.ts';

import { CrmPage } from '../../../../crm/crm-page.tsx';
import { useCrmRecords } from '../../../../crm/records.ts';
import { CrmScopeNote, CrmStateGate } from '../../../../crm/ui.tsx';
import {
  canWriteVisits,
  clientLabel,
  daysBetween,
  formatDay,
  formatShortDay,
  formatVisitDay,
  formatVisitTime,
  formatWeekday,
  localDay,
  principalLabel,
  relativeDay,
  salespersonLabel,
  sortPlanAsc,
  writableClients,
} from '../navstevy/visits-model.ts';
import { CompletePlanPanel, PlanContactPanel } from './plan-panels.tsx';

const dangerTextClass = 'text-danger';

const ALL = '__all__';

const BucketSchema = Schema.Literals(['overdue', 'today', 'tomorrow', 'week', 'later']);
type Bucket = typeof BucketSchema.Type;
const bucketMeta = {
  later: { label: 'Později', tone: 'plain' },
  overdue: { label: 'Po termínu', tone: 'danger' },
  today: { label: 'Dnes', tone: 'warning' },
  tomorrow: { label: 'Zítra', tone: 'info' },
  week: { label: 'Do 7 dní', tone: 'plain' },
} satisfies Record<Bucket, { readonly label: string; readonly tone: 'danger' | 'warning' | 'info' | 'plain' }>;
const bucketOrder: readonly Bucket[] = ['overdue', 'today', 'tomorrow', 'week', 'later'];

const bucketOf = (item: PlanItem, today: string): Bucket => {
  const diff = daysBetween(today, item.dueDate);
  if (diff < 0) {
    return 'overdue';
  }
  if (diff === 0) {
    return 'today';
  }
  if (diff === 1) {
    return 'tomorrow';
  }
  return diff <= 7 ? 'week' : 'later';
};

const PlanRow = ({
  canWrite,
  item,
  onComplete,
  onReschedule,
  records,
  showSalesperson,
}: {
  readonly canWrite: boolean;
  readonly item: PlanItem;
  readonly onComplete: (item: PlanItem) => void;
  readonly onReschedule: (item: PlanItem) => void;
  readonly records: RecordsResponse;
  readonly showSalesperson: boolean;
}) => {
  const { language } = useModernI18n();
  const today = localDay(records.now);
  const bucket = bucketOf(item, today);
  const { tone } = bucketMeta[bucket];
  const last = lastVisitOf(records.state.visits.items, item.clientId);
  const source = records.state.visits.items.find((visit) => visit.id === item.sourceVisitId);
  return (
    <li className="flex flex-wrap items-center gap-200 px-250 py-200">
      <div
        className={`flex w-700 shrink-0 flex-col items-center whitespace-nowrap rounded-md bg-surface px-100 py-50 ${
          bucket === 'overdue' ? dangerTextClass : ''
        }`}
      >
        <span className="font-semibold text-sm tabular-nums">{formatShortDay(item.dueDate)}</span>
        <span className="text-fg-secondary text-xs">{formatWeekday(item.dueDate)}</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-50">
        <span className="flex flex-wrap items-center gap-100">
          <a
            className="font-semibold text-sm underline-offset-2 hover:underline"
            href={`/${language ?? 'cs'}/crm/navstevy?klient=${encodeURIComponent(item.clientId)}`}
          >
            {clientLabel(records, item.clientId)}
          </a>
          {tone === 'plain' ? (
            <span className="text-fg-secondary text-xs">{relativeDay(item.dueDate, today)}</span>
          ) : (
            <Badge size="sm" variant={tone}>
              {relativeDay(item.dueDate, today)}
            </Badge>
          )}
          {showSalesperson && (
            <span className="text-fg-secondary text-xs">{`· ${salespersonLabel(records, item.salespersonId)}`}</span>
          )}
        </span>
        {item.note !== undefined && <span className="text-sm">{item.note}</span>}
        <span className="text-fg-secondary text-xs">
          {last === undefined
            ? 'Poslední kontakt: bez záznamu'
            : `Poslední kontakt: ${formatVisitDay(last.occurredAt)} – ${last.result}`}
          {source === undefined ? '' : ` · navazuje na návštěvu ${formatVisitDay(source.occurredAt)}`}
        </span>
      </div>
      {canWrite && (
        <div className="flex shrink-0 gap-100">
          <Button onClick={() => onReschedule(item)} size="sm" theme="outlined" variant="secondary">
            Přeplánovat
          </Button>
          <Button icon="icon-[mdi--check]" onClick={() => onComplete(item)} size="sm" variant="primary">
            Vyřídit
          </Button>
        </div>
      )}
    </li>
  );
};

const Agenda = ({
  emptyText,
  items,
  onComplete,
  onReschedule,
  records,
  showSalesperson,
}: {
  readonly emptyText: string;
  readonly items: readonly PlanItem[];
  readonly onComplete: (item: PlanItem) => void;
  readonly onReschedule: (item: PlanItem) => void;
  readonly records: RecordsResponse;
  readonly showSalesperson: boolean;
}) => {
  const today = localDay(records.now);
  const writable = new Set(writableClients(records).map((client) => client.id));
  if (items.length === 0) {
    return (
      <SectionCard>
        <EmptyState
          description="Kontakt naplánujete tlačítkem Naplánovat kontakt nebo při zápisu návštěvy."
          title={emptyText}
        />
      </SectionCard>
    );
  }
  return (
    <SectionCard flush>
      <div className={`flex flex-col ${dividedListClassName}`}>
        {bucketOrder.map((bucket) => {
          const inBucket = sortPlanAsc(items.filter((item) => bucketOf(item, today) === bucket));
          if (inBucket.length === 0) {
            return null;
          }
          return (
            <section aria-label={bucketMeta[bucket].label} key={bucket}>
              <h3
                className={`flex items-baseline gap-100 px-250 pt-250 pb-50 font-semibold text-sm ${
                  bucket === 'overdue' ? dangerTextClass : ''
                }`}
              >
                {bucketMeta[bucket].label}
                <span className="font-normal text-fg-secondary tabular-nums">{String(inBucket.length)}</span>
              </h3>
              <ul className={`flex flex-col pb-50 ${dividedListClassName}`}>
                {inBucket.map((item) => (
                  <PlanRow
                    canWrite={writable.has(item.clientId)}
                    item={item}
                    key={item.id}
                    onComplete={onComplete}
                    onReschedule={onReschedule}
                    records={records}
                    showSalesperson={showSalesperson}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </SectionCard>
  );
};

const TeamOverview = ({ records }: { readonly records: RecordsResponse }) => {
  const today = localDay(records.now);
  const { plan } = records.state.visits;
  const rows: readonly { readonly id?: string; readonly name: string }[] = [
    ...records.state.salespeople.map((person) => ({ id: person.id, name: person.name })),
    ...(plan.some((item) => item.salespersonId === undefined) ? [{ name: 'Bez obchodníka' }] : []),
  ];
  return (
    <div className="grid grid-cols-1 gap-200 md:grid-cols-2">
      {rows.map((row) => {
        const mine = plan.filter((item) => item.salespersonId === row.id);
        const open = mine.filter((item) => item.status === 'open');
        const overdue = open.filter((item) => daysBetween(today, item.dueDate) < 0);
        const week = open.filter((item) => {
          const diff = daysBetween(today, item.dueDate);
          return diff >= 0 && diff <= 7;
        });
        const done30 = mine.filter(
          (item) =>
            item.status === 'done' && item.doneAt !== undefined && daysBetween(localDay(item.doneAt), today) <= 30,
        );
        const visits30 = records.state.visits.items.filter(
          (visit) => visit.salespersonId === row.id && daysBetween(localDay(visit.occurredAt), today) <= 30,
        );
        return (
          <SectionCard key={row.id ?? 'none'} title={row.name}>
            <div className="grid grid-cols-2 gap-150 sm:grid-cols-4">
              {[
                { label: 'Otevřené', value: open.length },
                { label: 'Po termínu', tone: overdue.length > 0 ? dangerTextClass : '', value: overdue.length },
                { label: 'Do 7 dní', value: week.length },
                { label: 'Vyřízeno (30 dní)', value: done30.length },
              ].map((cell) => (
                <div className="flex flex-col gap-50" key={cell.label}>
                  <span className="text-fg-secondary text-xs">{cell.label}</span>
                  <span className={`font-semibold text-lg tabular-nums ${cell.tone ?? ''}`}>
                    {formatNumber(cell.value)}
                  </span>
                </div>
              ))}
            </div>
            <span className="text-fg-secondary text-xs">{`Zapsané kontakty za 30 dní: ${formatNumber(visits30.length)}`}</span>
          </SectionCard>
        );
      })}
    </div>
  );
};

const DoneList = ({ items, records }: { readonly items: readonly PlanItem[]; readonly records: RecordsResponse }) => {
  const { language, t } = useModernI18n();
  if (items.length === 0) {
    return (
      <SectionCard>
        <EmptyState title={t('crm.ciWorkflow.noCompletedContacts')} />
      </SectionCard>
    );
  }
  return (
    <SectionCard flush>
      <ul className={`flex flex-col ${dividedListClassName}`}>
        {items
          .toSorted((left, right) =>
            (orderDateText(right.doneAt) ?? '').localeCompare(orderDateText(left.doneAt) ?? ''),
          )
          .map((item) => {
            const visit = records.state.visits.items.find((entry) => entry.id === item.doneVisitId);
            return (
              <li className="flex flex-wrap items-start gap-200 px-250 py-200" key={item.id}>
                <span aria-hidden="true" className="icon-[mdi--check-circle] mt-50 size-250 shrink-0 text-success" />
                <div className="flex min-w-0 flex-1 flex-col gap-50">
                  <span className="flex flex-wrap items-center gap-100">
                    <a
                      className="font-semibold text-sm underline-offset-2 hover:underline"
                      href={`/${language ?? 'cs'}/crm/navstevy?klient=${encodeURIComponent(item.clientId)}`}
                    >
                      {clientLabel(records, item.clientId)}
                    </a>
                    <Badge size="sm" variant="success">
                      Vyřízeno
                    </Badge>
                    <span className="text-fg-secondary text-xs">{`· ${salespersonLabel(records, item.salespersonId)}`}</span>
                  </span>
                  {item.note !== undefined && <span className="text-sm">{item.note}</span>}
                  {item.doneNote !== undefined && <span className="text-sm">{`Výsledek: ${item.doneNote}`}</span>}
                  <span className="text-fg-secondary text-xs">
                    {`Plánováno na ${formatDay(item.dueDate)} · vyřízeno ${item.doneAt === undefined ? '—' : formatVisitTime(item.doneAt)}${
                      item.doneBy === undefined ? '' : [' · ', principalLabel(records, item.doneBy)].join('')
                    }${visit === undefined ? '' : [' · zapsán kontakt: ', visit.result].join('')}`}
                  </span>
                </div>
              </li>
            );
          })}
      </ul>
    </SectionCard>
  );
};

const planSelection = ({
  completeId,
  records,
  rescheduleId,
  salespersonFilter,
  tab,
}: {
  readonly completeId: string | undefined;
  readonly records: RecordsResponse;
  readonly rescheduleId: string | undefined;
  readonly salespersonFilter: string;
  readonly tab: string | undefined;
}) => {
  const today = localDay(records.now);
  const lead = canSeeEverything(records.viewer);
  const own = records.viewer.salespersonId;
  const { plan } = records.state.visits;
  const open = plan.filter((item) => item.status === 'open');
  const mine = open.filter((item) => item.salespersonId === own);
  const activeTab = tab ?? (lead && (own === undefined || mine.length === 0) ? 'team' : 'mine');
  const teamItems = open.filter(
    (item) => salespersonFilter === ALL || (item.salespersonId ?? 'none') === salespersonFilter,
  );
  const scope = activeTab === 'team' || own === undefined ? open : mine;
  const done = plan.filter(
    (item) =>
      item.status === 'done' &&
      (lead
        ? salespersonFilter === ALL || (item.salespersonId ?? 'none') === salespersonFilter
        : own === undefined || item.salespersonId === own),
  );
  const canWrite = canWriteVisits(records) && writableClients(records).length > 0;
  const rescheduling = plan.find((item) => item.id === rescheduleId);
  const completing = plan.find((item) => item.id === completeId);
  return { activeTab, canWrite, completing, done, lead, mine, open, own, plan, rescheduling, scope, teamItems, today };
};

const PlanContent = () => {
  const { t } = useModernI18n();
  const { busy, load, state, submit } = useCrmRecords();
  const [tab, setTab] = useState<string | undefined>();
  const [salespersonFilter, setSalespersonFilter] = useState(ALL);
  const [creating, setCreating] = useState(false);
  const [rescheduleId, setRescheduleId] = useState<string | undefined>();
  const [completeId, setCompleteId] = useState<string | undefined>();
  return (
    <CrmStateGate onRetry={load} state={state}>
      {(records) => {
        const {
          activeTab,
          canWrite,
          completing,
          done,
          lead,
          mine,
          open,
          own,
          plan,
          rescheduling,
          scope,
          teamItems,
          today,
        } = planSelection({ completeId, records, rescheduleId, salespersonFilter, tab });
        return (
          <>
            <PageHeader
              actions={
                canWrite ? (
                  <Button
                    icon="icon-[mdi--calendar-plus]"
                    onClick={() => setCreating(true)}
                    size="sm"
                    variant="primary"
                  >
                    Naplánovat kontakt
                  </Button>
                ) : undefined
              }
              description={t('crm.pages.plan.description')}
              title={t('crm.pages.plan.title')}
            />
            <StatRow>
              <StatCard
                label={t('crm.ciWorkflow.overdue')}
                value={formatNumber(scope.filter((item) => daysBetween(today, item.dueDate) < 0).length)}
              />
              <StatCard
                label={t('crm.ciWorkflow.today')}
                value={formatNumber(scope.filter((item) => item.dueDate === today).length)}
              />
              <StatCard
                label={t('crm.ciWorkflow.within14Days')}
                value={formatNumber(
                  scope.filter((item) => {
                    const diff = daysBetween(today, item.dueDate);
                    return diff >= 0 && diff <= 14;
                  }).length,
                )}
              />
              <StatCard
                hint="kontakty zůstávají dohledatelné"
                label={t('crm.ciWorkflow.completed30Days')}
                value={formatNumber(
                  plan.filter(
                    (item) =>
                      item.status === 'done' &&
                      item.doneAt !== undefined &&
                      daysBetween(localDay(item.doneAt), today) <= 30 &&
                      (activeTab === 'team' || own === undefined || item.salespersonId === own),
                  ).length,
                )}
              />
            </StatRow>
            <CrmScopeNote records={records} />

            <div className="flex flex-wrap items-end justify-between gap-150">
              <Tabs onValueChange={setTab} value={activeTab} variant="line">
                <Tabs.List>
                  {own !== undefined && <Tabs.Trigger value="mine">{`Můj plán (${String(mine.length)})`}</Tabs.Trigger>}
                  {lead && <Tabs.Trigger value="team">{`Tým (${String(open.length)})`}</Tabs.Trigger>}
                  {own === undefined && !lead && (
                    <Tabs.Trigger value="mine">{`Otevřené (${String(open.length)})`}</Tabs.Trigger>
                  )}
                  <Tabs.Trigger value="done">{`Vyřízené (${String(done.length)})`}</Tabs.Trigger>
                  <Tabs.Indicator />
                </Tabs.List>
              </Tabs>
              {lead && activeTab !== 'mine' && (
                <div className="w-52">
                  <SelectTemplate
                    items={[
                      { label: 'Všichni obchodníci', value: ALL },
                      ...records.state.salespeople.map((person) => ({
                        label: person.active ? person.name : `${person.name} (vyřazen)`,
                        value: person.id,
                      })),
                    ]}
                    label={t('crm.ciWorkflow.salesperson')}
                    name="salespersonFilter"
                    onValueChange={(details) => setSalespersonFilter(details.value[0] ?? ALL)}
                    size="sm"
                    value={[salespersonFilter]}
                  />
                </div>
              )}
            </div>

            {activeTab === 'team' && lead && (
              <>
                <TeamOverview records={records} />
                <Agenda
                  emptyText="Tým nemá žádné otevřené kontakty"
                  items={teamItems}
                  onComplete={(item) => setCompleteId(item.id)}
                  onReschedule={(item) => setRescheduleId(item.id)}
                  records={records}
                  showSalesperson
                />
              </>
            )}
            {activeTab === 'mine' && (
              <Agenda
                emptyText="Nemáte žádné naplánované kontakty"
                items={own === undefined ? open : mine}
                onComplete={(item) => setCompleteId(item.id)}
                onReschedule={(item) => setRescheduleId(item.id)}
                records={records}
                showSalesperson={own === undefined}
              />
            )}
            {activeTab === 'done' && <DoneList items={done} records={records} />}

            {creating && (
              <PlanContactPanel busy={busy} onClose={() => setCreating(false)} records={records} submit={submit} />
            )}
            {rescheduling !== undefined && (
              <PlanContactPanel
                busy={busy}
                item={rescheduling}
                key={rescheduling.id}
                onClose={() => setRescheduleId(undefined)}
                records={records}
                submit={submit}
              />
            )}
            {completing !== undefined && (
              <CompletePlanPanel
                busy={busy}
                item={completing}
                key={completing.id}
                onClose={() => setCompleteId(undefined)}
                records={records}
                submit={submit}
              />
            )}
          </>
        );
      }}
    </CrmStateGate>
  );
};

export const PlanPage = () => (
  <CrmPage titleKey="crm.pages.plan.title">
    <PlanContent />
  </CrmPage>
);

/** The Shell awaits this before it reveals the page, so the first render already has the records. */
export { preloadCrmRecords as preloadPage } from '../../../../crm/records.ts';
export default PlanPage;
