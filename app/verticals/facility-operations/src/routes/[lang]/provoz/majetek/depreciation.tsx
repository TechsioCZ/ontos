// S03 depreciation evidence: per-asset plan cards with the approved-amounts schedule, and the portfolio overview
// with reusable templates. Nothing here computes legal or tax depreciation. Owned by ops-assets.
import { ScrollRegion, SectionCard, formatMoney, surfaceTileClassName } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Accordion } from '@techsio/ui-kit/molecules/accordion';
import { Table } from '@techsio/ui-kit/organisms/table';
import type { TOptions } from 'i18next';
import { useState } from 'react';
import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import type { Asset, AssetsState, DepreciationPlan, DepreciationType } from '../../../../../shared/domain/assets.ts';
import { approvedTotal, indicativeSchedule, isActiveAsset } from '../../../../../shared/domain/assets.ts';
import { instantLabel, isoDateLabel, planOf, principalLabel, todayIsoDate } from './assets-model.ts';

const YEARS_LABEL = 'depreciation.yearsValue';
const START_DATE_LABEL = 'fields.startDate';
const TAX_GROUP_LABEL = 'fields.taxGroup';
const auditViewport = '-mx-5 min-w-0 overflow-x-auto overscroll-x-contain';

const useK = () => {
  const { t } = useModernI18n();
  return (key: string, options?: TOptions) => t(`facility-operations.assets.${key}`, options);
};

/** Always-visible honesty banner (S03 „Nedělat“: vlastní zákonný výpočet). */
export const EvidenceBanner = () => {
  const k = useK();
  return (
    <div className="flex flex-wrap items-center gap-100 rounded-lg bg-bg-light-warning-base px-200 py-150 text-sm">
      <Badge severity="warning" size="sm">
        {k('depreciation.evidenceBadge')}
      </Badge>
      <span>{k('depreciation.evidenceNote')}</span>
    </div>
  );
};

export const PlanStatusBadge = ({ plan }: { readonly plan: DepreciationPlan }) => {
  const k = useK();
  return (
    <Badge severity={plan.status === 'confirmed' ? 'success' : 'neutral'} size="sm">
      {k(`planStatus.${plan.status}`)}
    </Badge>
  );
};

/** S03-02: without an identified accounting product the link reads „nenapojeno“, never „zaúčtováno“. */
export const ConnectionBadge = ({ asset }: { readonly asset: Asset }) => {
  const k = useK();
  return asset.accountingProduct === undefined ? (
    <Badge appearance="outline" severity="neutral" size="sm">
      {k('depreciation.notConnected')}
    </Badge>
  ) : (
    <Badge severity="info" size="sm">
      {k('depreciation.manualLink', { product: asset.accountingProduct })}
    </Badge>
  );
};

const currentPeriod = (plan: DepreciationPlan) => {
  const today = todayIsoDate();
  return plan.interval === 'yearly' ? today.slice(0, 4) : today.slice(0, 7);
};

const PlanCard = ({
  actor,
  asset,
  canWrite,
  onConfirm,
  onRecord,
  plan,
}: {
  readonly actor: PrincipalRef | undefined;
  readonly asset: Asset;
  readonly canWrite: boolean;
  readonly onConfirm: (plan: DepreciationPlan) => void;
  readonly onRecord: (plan: DepreciationPlan) => void;
  readonly plan: DepreciationPlan;
}) => {
  const k = useK();
  const [full, setFull] = useState(false);
  const schedule = indicativeSchedule(plan);
  const entries = new Map(plan.entries.map((entry) => [entry.period, entry]));
  const lastApproved = plan.entries.at(-1)?.period ?? '';
  const horizon = [lastApproved, currentPeriod(plan)].toSorted().at(-1) ?? '';
  const visible = full
    ? schedule
    : schedule.filter((row) => row.period <= horizon || entries.has(row.period)).slice(-12);
  const extra = plan.entries.filter((entry) => !schedule.some((row) => row.period === entry.period));
  const tableRows: readonly { readonly amountMinor?: number; readonly period: string }[] = [
    ...visible,
    ...extra.map((entry) => ({ period: entry.period })),
  ];
  const total = approvedTotal(plan);
  const active = isActiveAsset(asset);
  return (
    <SectionCard
      actions={
        canWrite && active ? (
          <>
            {plan.status === 'draft' && (
              <Button appearance="outline" onClick={() => onConfirm(plan)} severity="secondary" size="sm">
                {k('actions.confirmPlan')}
              </Button>
            )}
            <Button onClick={() => onRecord(plan)} severity="primary" size="sm">
              {k('actions.recordEntry')}
            </Button>
          </>
        ) : undefined
      }
      title={
        <span className="flex flex-wrap items-center gap-100">
          {k(`depreciation.${plan.type}Plan`)} <PlanStatusBadge plan={plan} />
        </span>
      }
    >
      <dl className="grid grid-cols-2 gap-150 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-fg-secondary text-xs">{k('fields.method')}</dt>
          <dd>{plan.method}</dd>
        </div>
        <div>
          <dt className="text-fg-secondary text-xs">{k('fields.years')}</dt>
          <dd>
            {k(YEARS_LABEL, { count: plan.years })} · {k(`interval.${plan.interval}`)}
          </dd>
        </div>
        <div>
          <dt className="text-fg-secondary text-xs">{k('fields.base')}</dt>
          <dd className="tabular-nums">{formatMoney(plan.baseMinor)}</dd>
        </div>
        <div>
          <dt className="text-fg-secondary text-xs">{k(START_DATE_LABEL)}</dt>
          <dd>{isoDateLabel(plan.startDate)}</dd>
        </div>
        {plan.taxGroup !== undefined && (
          <div>
            <dt className="text-fg-secondary text-xs">{k(TAX_GROUP_LABEL)}</dt>
            <dd>{plan.taxGroup}</dd>
          </div>
        )}
        <div>
          <dt className="text-fg-secondary text-xs">{k('depreciation.approvedTotal')}</dt>
          <dd className="font-medium tabular-nums">{formatMoney(total)}</dd>
        </div>
        <div>
          <dt className="text-fg-secondary text-xs">{k(`depreciation.remaining.${plan.type}`)}</dt>
          <dd className="font-medium tabular-nums">{formatMoney(plan.baseMinor - total)}</dd>
        </div>
      </dl>
      {plan.note !== undefined && <p className="text-fg-secondary text-sm">{plan.note}</p>}
      {/* Keep the audit's intrinsic width inside its own viewport, not the panel's prose and controls. */}
      <ScrollRegion className={auditViewport} label={k(`depreciation.${plan.type}Plan`)}>
        {/* A fixed layout is as wide as its columns (840px) or its viewport, whichever is wider. */}
        <Table appearance="line" className="table-fixed" size="sm">
          <colgroup>
            <col className="w-17.5" />
            <col className="w-39" />
            <col className="w-52.5" />
            <col className="w-36" />
            <col className="w-65" />
          </colgroup>
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader className="whitespace-nowrap">{k('fields.period')}</Table.ColumnHeader>
              <Table.ColumnHeader align="end" className="whitespace-nowrap">
                {k('depreciation.indicative')}
              </Table.ColumnHeader>
              <Table.ColumnHeader align="end" className="whitespace-nowrap">
                {k('fields.approvedAmount')}
              </Table.ColumnHeader>
              <Table.ColumnHeader className="whitespace-nowrap">{k('fields.documentRef')}</Table.ColumnHeader>
              <Table.ColumnHeader className="whitespace-nowrap">{k('depreciation.recordedBy')}</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {tableRows.map((row) => {
              const entry = entries.get(row.period);
              return (
                <Table.Row key={row.period}>
                  <Table.Cell className="tabular-nums">{row.period}</Table.Cell>
                  <Table.Cell align="end" className="text-fg-secondary tabular-nums">
                    {row.amountMinor === undefined ? '—' : formatMoney(row.amountMinor)}
                  </Table.Cell>
                  <Table.Cell align="end" className="font-medium tabular-nums">
                    {entry === undefined ? (
                      <span className="font-normal text-fg-secondary">{k('depreciation.notApproved')}</span>
                    ) : (
                      <span className="inline-flex items-center gap-100">
                        {entry.partial === true && (
                          <Badge severity="warning" size="sm">
                            {k('depreciation.partial')}
                          </Badge>
                        )}
                        {formatMoney(entry.amountMinor)}
                      </span>
                    )}
                  </Table.Cell>
                  <Table.Cell className="whitespace-nowrap">
                    {entry?.documentRef ?? (entry === undefined ? '' : k('notProvided'))}
                  </Table.Cell>
                  <Table.Cell className="min-w-65 max-w-80 text-fg-secondary" style={{ fontSize: '1rem' }}>
                    {entry === undefined ? null : (
                      <>
                        <div>{principalLabel(entry.by, actor, k('you'))}</div>
                        <div>{instantLabel(entry.at)}</div>
                      </>
                    )}
                    {entry?.note === undefined ? null : <div className="text-fg-primary">{entry.note}</div>}
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table>
      </ScrollRegion>
      <div
        className="flex flex-wrap items-center justify-between gap-100 text-fg-secondary"
        style={{ fontSize: '1rem' }}
      >
        <span>{k('depreciation.indicativeNote')}</span>
        {(full || schedule.length > visible.length) && (
          <Button appearance="ghost" onClick={() => setFull((value) => !value)} severity="secondary" size="sm">
            {full ? k('depreciation.collapse') : k('depreciation.showAll', { count: schedule.length })}
          </Button>
        )}
      </div>
      <Accordion appearance="ghost" className="text-sm" collapsible size="sm">
        <Accordion.Item value="history">
          <Accordion.Header>
            <Accordion.Title className="text-fg-secondary">{k('depreciation.history')}</Accordion.Title>
            <Accordion.Indicator />
          </Accordion.Header>
          <Accordion.Content>
            <ul className="mt-100 flex flex-col gap-50">
              {plan.history.toReversed().map((entry) => (
                <li key={`${instantLabel(entry.at)}-${entry.change}-${entry.note ?? ''}`}>
                  <span className="text-fg-secondary">{instantLabel(entry.at)}</span> ·{' '}
                  {k(`planChange.${entry.change}`, { period: entry.note ?? '' })} ·{' '}
                  {principalLabel(entry.by, actor, k('you'))}
                </li>
              ))}
            </ul>
          </Accordion.Content>
        </Accordion.Item>
      </Accordion>
    </SectionCard>
  );
};

/** Depreciation tab of the asset detail: one card per plan type, or a create action. */
export const AssetDepreciation = ({
  actor,
  asset,
  canWrite,
  onConfirm,
  onCreate,
  onRecord,
}: {
  readonly actor: PrincipalRef | undefined;
  readonly asset: Asset;
  readonly canWrite: boolean;
  readonly onConfirm: (plan: DepreciationPlan) => void;
  readonly onCreate: (type: DepreciationType) => void;
  readonly onRecord: (plan: DepreciationPlan) => void;
}) => {
  const k = useK();
  return (
    <div className="flex flex-col gap-200">
      <EvidenceBanner />
      <div className="flex flex-wrap items-center gap-100 text-sm">
        <span className="text-fg-secondary">{k('depreciation.connection')}</span>
        <ConnectionBadge asset={asset} />
      </div>
      {(['accounting', 'tax'] as const).map((type) => {
        const plan = planOf(asset, type);
        return plan === undefined ? (
          <SectionCard
            actions={
              canWrite && isActiveAsset(asset) ? (
                <Button appearance="outline" onClick={() => onCreate(type)} severity="secondary" size="sm">
                  {k(`actions.createPlan.${type}`)}
                </Button>
              ) : undefined
            }
            key={type}
            title={k(`depreciation.${type}Plan`)}
          >
            <p className="text-fg-secondary text-sm">{k('depreciation.noPlan')}</p>
          </SectionCard>
        ) : (
          <PlanCard
            actor={actor}
            asset={asset}
            canWrite={canWrite}
            key={type}
            onConfirm={onConfirm}
            onRecord={onRecord}
            plan={plan}
          />
        );
      })}
    </div>
  );
};

/** Portfolio overview of all plans (tab „Odpisové plány“) + reusable templates. */
export const DepreciationOverview = ({
  canWrite,
  onNewTemplate,
  onOpen,
  state,
}: {
  readonly canWrite: boolean;
  readonly onNewTemplate: () => void;
  readonly onOpen: (asset: Asset) => void;
  readonly state: AssetsState;
}) => {
  const k = useK();
  const rows = state.assets.flatMap((asset) =>
    asset.archive === undefined ? (asset.depreciationPlans ?? []).map((plan) => ({ asset, plan })) : [],
  );
  const year = todayIsoDate().slice(0, 4);
  const sumFor = (type: DepreciationType) => {
    let sum = 0;
    for (const { plan } of rows) {
      if (plan.type === type) {
        for (const entry of plan.entries) {
          if (entry.period.startsWith(year)) {
            sum += entry.amountMinor;
          }
        }
      }
    }
    return sum;
  };
  return (
    <div className="flex flex-col gap-250">
      <EvidenceBanner />
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-3">
        <div className={`${surfaceTileClassName} p-200`}>
          <p className="text-fg-secondary text-sm">{k('depreciation.yearAccounting', { year })}</p>
          <p className="font-semibold text-xl tabular-nums">{formatMoney(sumFor('accounting'))}</p>
        </div>
        <div className={`${surfaceTileClassName} p-200`}>
          <p className="text-fg-secondary text-sm">{k('depreciation.yearTax', { year })}</p>
          <p className="font-semibold text-xl tabular-nums">{formatMoney(sumFor('tax'))}</p>
        </div>
        <div className={`${surfaceTileClassName} p-200`}>
          <p className="text-fg-secondary text-sm">{k('depreciation.draftPlans')}</p>
          <p className="font-semibold text-xl tabular-nums">
            {rows.filter((row) => row.plan.status === 'draft').length}
          </p>
        </div>
      </div>
      <SectionCard flush title={k('depreciation.allPlans')}>
        <Table appearance="line" size="sm">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>{k('columns.asset')}</Table.ColumnHeader>
              <Table.ColumnHeader>{k('fields.planType')}</Table.ColumnHeader>
              <Table.ColumnHeader>{k('fields.method')}</Table.ColumnHeader>
              <Table.ColumnHeader align="end">{k('fields.base')}</Table.ColumnHeader>
              <Table.ColumnHeader align="end">{k('depreciation.approvedTotal')}</Table.ColumnHeader>
              <Table.ColumnHeader align="end">{k('depreciation.remainingShort')}</Table.ColumnHeader>
              <Table.ColumnHeader>{k('fields.status')}</Table.ColumnHeader>
              <Table.ColumnHeader>{k('depreciation.connection')}</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rows.map(({ asset, plan }) => (
              <Table.Row className="cursor-pointer hover:bg-fill-hover" key={plan.id} onClick={() => onOpen(asset)}>
                <Table.Cell>
                  <span className="flex flex-col">
                    <span className="font-medium">{asset.name}</span>
                    <span className="text-fg-secondary text-xs tabular-nums">{asset.inventoryNumber}</span>
                  </span>
                </Table.Cell>
                <Table.Cell>{k(`depreciation.${plan.type}`)}</Table.Cell>
                <Table.Cell>
                  {plan.method}
                  <span className="block text-fg-secondary text-xs">
                    {k(YEARS_LABEL, { count: plan.years })}
                    {plan.taxGroup === undefined ? '' : ` · ${k(TAX_GROUP_LABEL)} ${plan.taxGroup}`}
                  </span>
                </Table.Cell>
                <Table.Cell align="end" className="tabular-nums">
                  {formatMoney(plan.baseMinor)}
                </Table.Cell>
                <Table.Cell align="end" className="tabular-nums">
                  {formatMoney(approvedTotal(plan))}
                </Table.Cell>
                <Table.Cell align="end" className="tabular-nums">
                  {formatMoney(plan.baseMinor - approvedTotal(plan))}
                </Table.Cell>
                <Table.Cell>
                  <PlanStatusBadge plan={plan} />
                </Table.Cell>
                <Table.Cell>
                  <ConnectionBadge asset={asset} />
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </SectionCard>
      <SectionCard
        actions={
          canWrite ? (
            <Button appearance="outline" onClick={onNewTemplate} severity="secondary" size="sm">
              {k('actions.newTemplate')}
            </Button>
          ) : undefined
        }
        title={k('templates.title')}
      >
        {(state.templates ?? []).length === 0 ? (
          <p className="text-fg-secondary text-sm">{k('templates.empty')}</p>
        ) : (
          <ul className="grid grid-cols-1 gap-150 sm:grid-cols-3">
            {(state.templates ?? []).map((template) => (
              <li className={`${surfaceTileClassName} flex flex-col gap-50 p-150 text-sm`} key={template.id}>
                <span className="font-medium">{template.name}</span>
                <span className="text-fg-secondary">
                  {k(`depreciation.${template.type}`)} · {template.method} · {k(YEARS_LABEL, { count: template.years })}{' '}
                  · {k(`interval.${template.interval}`)}
                  {template.taxGroup === undefined ? '' : ` · ${k(TAX_GROUP_LABEL)} ${template.taxGroup}`}
                </span>
                {template.note !== undefined && <span className="text-fg-secondary text-xs">{template.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
};
