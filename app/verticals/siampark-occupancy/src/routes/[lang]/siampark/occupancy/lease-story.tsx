import { DetailList, SectionCard, formatDate, formatMoney } from '@app/admin-ui';
import type { listCustomers } from '@app/party-registry/api/client';
import type { executeRecords as readAgreements } from '@app/siampark-agreements/clients/records';
import type { Invoice } from '@app/siampark-billing-finance/contracts/records';
import type { executeRecords as readProperty } from '@app/siampark-property/clients/records';
import type { Task } from '@app/siampark-work/contracts/records';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import type { Effect } from 'effect';
import type { ReactNode } from 'react';

import type { Occupancy, RentTerms } from '../../../../../shared/apis/records.ts';

type Translate = (key: string, options?: Record<string, unknown>) => string;
export type TenantDirectoryEntry = Effect.Success<ReturnType<typeof listCustomers>>[number];
export type LeaseContract = Effect.Success<ReturnType<typeof readAgreements>>['contracts'][number];
export type LeaseUnit = Effect.Success<ReturnType<typeof readProperty>>['units'][number];
export type LeaseProperty = Effect.Success<ReturnType<typeof readProperty>>['properties'][number];
export type LeaseTask = Task;
export type LeaseInvoice = Invoice;

/** Related records of one lease, each loaded independently so a missing permission hides only its own card. */
export interface LeaseRelated {
  readonly invoices: readonly LeaseInvoice[] | 'unavailable' | undefined;
  readonly tasks: readonly LeaseTask[] | 'unavailable' | undefined;
}

const P = 'siampark-occupancy';
const mutedClass = 'siamparkoccupancy:text-sm siamparkoccupancy:text-(--color-fg-secondary)';
const rowClass =
  'siamparkoccupancy:flex siamparkoccupancy:flex-wrap siamparkoccupancy:items-center siamparkoccupancy:justify-between siamparkoccupancy:gap-3 siamparkoccupancy:rounded-lg siamparkoccupancy:border siamparkoccupancy:border-(--color-border-muted) siamparkoccupancy:p-3 siamparkoccupancy:text-sm';

const isLoadedList = <A,>(value: readonly A[] | 'unavailable' | undefined): value is readonly A[] =>
  value !== undefined && value !== 'unavailable';
export const loadedList = <A,>(value: readonly A[] | 'unavailable' | undefined): readonly A[] =>
  isLoadedList(value) ? value : [];
export const monthlyTotal = (terms: RentTerms) => terms.monthlyRentMinor + terms.serviceChargesMinor;
export const sameRentTerms = (left: RentTerms, right: RentTerms) =>
  left.monthlyRentMinor === right.monthlyRentMinor &&
  left.serviceChargesMinor === right.serviceChargesMinor &&
  left.paymentDay === right.paymentDay;

/** Parses a Czech amount in whole crowns (`12 500`, `12500,50`) into haléře; `undefined` when not a number. */
export const parseCrowns = (value: string): number | undefined => {
  const normalized = value.replaceAll(/\s/gu, '').replace(',', '.');
  if (normalized.length === 0 || !/^\d+(\.\d{1,2})?$/u.test(normalized)) {
    return undefined;
  }
  return Math.round(Number(normalized) * 100);
};
export const crownsInput = (minor: number) => (minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2));

/** The contract of a lease: the activated contract ref first, otherwise the newest contract drafted for it. */
export const leaseContract = (record: Occupancy, contracts: readonly LeaseContract[] | undefined) => {
  if (contracts === undefined) {
    return undefined;
  }
  if (record.contractRef !== null) {
    const linked = contracts.find((item) => item.contractRef.resourceId === record.contractRef?.resourceId);
    if (linked !== undefined) {
      return linked;
    }
  }
  return contracts
    .filter((item) => item.occupancyRef?.resourceId === record.occupancyRef.resourceId)
    .toSorted((left, right) => right.startDate.localeCompare(left.startDate))[0];
};

const contractBadge = { ACTIVE: 'success', DRAFT: 'outline', EXPIRED: 'warning', TERMINATED: 'danger' } as const;
const signatureBadge = { DECLINED: 'danger', NOT_SENT: 'outline', SENT: 'info', SIGNED: 'success' } as const;
const taskBadge = {
  CANCELLED: 'secondary',
  DONE: 'success',
  IN_PROGRESS: 'info',
  NEW: 'outline',
  WAITING: 'warning',
} as const;
const invoiceBadge = { CONFIRMED: 'success', DRAFT: 'outline', VOIDED: 'danger' } as const;

export interface StoryStep {
  readonly current?: boolean;
  readonly href?: string | undefined;
  readonly label: string;
  readonly value?: string | undefined;
}

/** Clickable chain building → unit → tenant → contract → lease → service tasks → invoice. */
export const LeaseStoryNav = ({ steps, t }: { readonly steps: readonly StoryStep[]; readonly t: Translate }) => (
  <nav
    aria-label={t(`${P}.story.title`)}
    className="siamparkoccupancy:overflow-x-auto siamparkoccupancy:rounded-lg siamparkoccupancy:border siamparkoccupancy:border-(--color-border-muted) siamparkoccupancy:bg-(--color-surface) siamparkoccupancy:p-3"
  >
    <ol className="siamparkoccupancy:flex siamparkoccupancy:min-w-max siamparkoccupancy:items-stretch siamparkoccupancy:gap-2">
      {steps.map((step, index) => {
        const body = (
          <>
            <span className="siamparkoccupancy:block siamparkoccupancy:text-xs siamparkoccupancy:uppercase siamparkoccupancy:tracking-wide siamparkoccupancy:text-(--color-fg-secondary)">
              {index + 1}. {step.label}
            </span>
            <span className="siamparkoccupancy:block siamparkoccupancy:max-w-48 siamparkoccupancy:truncate siamparkoccupancy:text-sm siamparkoccupancy:font-medium">
              {step.value ?? '—'}
            </span>
          </>
        );
        const tone =
          step.current === true
            ? 'siamparkoccupancy:border-2 siamparkoccupancy:border-(--color-fg-secondary) siamparkoccupancy:bg-(--color-surface-subtle)'
            : 'siamparkoccupancy:border-(--color-border-muted)';
        return (
          <li
            className="siamparkoccupancy:flex siamparkoccupancy:items-center siamparkoccupancy:gap-2"
            key={step.label}
          >
            {step.href === undefined || step.current === true ? (
              <div
                aria-current={step.current === true ? 'step' : undefined}
                className={`siamparkoccupancy:rounded-md siamparkoccupancy:border siamparkoccupancy:px-3 siamparkoccupancy:py-2 ${tone}`}
              >
                {body}
              </div>
            ) : (
              <a
                className={`siamparkoccupancy:rounded-md siamparkoccupancy:border siamparkoccupancy:px-3 siamparkoccupancy:py-2 siamparkoccupancy:no-underline siamparkoccupancy:hover:bg-(--color-surface-subtle) ${tone}`}
                href={step.href}
              >
                {body}
              </a>
            )}
            {index < steps.length - 1 && (
              <span aria-hidden className="siamparkoccupancy:text-(--color-fg-secondary)">
                →
              </span>
            )}
          </li>
        );
      })}
    </ol>
  </nav>
);

export const RentTermsCard = ({
  action,
  contract,
  record,
  t,
}: {
  readonly action?: ReactNode;
  readonly contract: LeaseContract | undefined;
  readonly record: Occupancy;
  readonly t: Translate;
}) => {
  const terms = record.rentTerms;
  const contractTerms = contract?.rentTerms;
  return (
    <SectionCard actions={action} title={t(`${P}.rent.title`)}>
      {terms === undefined ? (
        <p className={mutedClass}>{t(`${P}.rent.missing`)}</p>
      ) : (
        <>
          <div className="siamparkoccupancy:flex siamparkoccupancy:flex-wrap siamparkoccupancy:items-baseline siamparkoccupancy:gap-3">
            <span className="siamparkoccupancy:text-2xl siamparkoccupancy:font-semibold siamparkoccupancy:tabular-nums">
              {formatMoney(monthlyTotal(terms), terms.currency)}
            </span>
            <span className={mutedClass}>{t(`${P}.rent.monthlyTotal`)}</span>
            {contractTerms !== undefined && (
              <Badge size="sm" variant={sameRentTerms(terms, contractTerms) ? 'success' : 'warning'}>
                {sameRentTerms(terms, contractTerms)
                  ? t(`${P}.rent.contractMatches`)
                  : t(`${P}.rent.contractDiffers`, { amount: formatMoney(monthlyTotal(contractTerms)) })}
              </Badge>
            )}
          </div>
          <DetailList
            items={[
              { label: t(`${P}.rent.monthlyRent`), value: formatMoney(terms.monthlyRentMinor, terms.currency) },
              { label: t(`${P}.rent.serviceCharges`), value: formatMoney(terms.serviceChargesMinor, terms.currency) },
              { label: t(`${P}.rent.paymentDay`), value: t(`${P}.rent.paymentDayValue`, { day: terms.paymentDay }) },
              { label: t(`${P}.rent.currency`), value: terms.currency },
            ]}
          />
        </>
      )}
    </SectionCard>
  );
};

export const UnitCard = ({
  language,
  property,
  t,
  unit,
}: {
  readonly language: string;
  readonly property: LeaseProperty | undefined;
  readonly t: Translate;
  readonly unit: LeaseUnit | undefined;
}) => (
  <SectionCard title={t(`${P}.related.unitCard`)}>
    <DetailList
      items={[
        { label: t(`${P}.demo.unit`), value: unit?.name ?? t(`${P}.related.notProvided`) },
        { label: t(`${P}.related.unitCode`), value: unit?.code ?? t(`${P}.related.notProvided`) },
        { label: t(`${P}.related.property`), value: property?.name ?? t(`${P}.related.notProvided`) },
        { label: t(`${P}.related.address`), value: property?.address ?? t(`${P}.related.notProvided`) },
      ]}
    />
    <div className="siamparkoccupancy:flex siamparkoccupancy:flex-wrap siamparkoccupancy:gap-2">
      {unit !== undefined && (
        <LinkButton
          href={`/${language}/siampark/properties?resourceId=${unit.unitRef.resourceId}`}
          icon="icon-[mdi--door]"
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          {t(`${P}.related.openUnit`)}
        </LinkButton>
      )}
      {property !== undefined && (
        <LinkButton
          href={`/${language}/siampark/properties?resourceId=${property.propertyRef.resourceId}`}
          icon="icon-[mdi--office-building-outline]"
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          {t(`${P}.related.openProperty`)}
        </LinkButton>
      )}
    </div>
  </SectionCard>
);

export const TenantCard = ({
  fallbackName,
  language,
  t,
  tenant,
  title,
}: {
  readonly fallbackName: string;
  readonly language: string;
  readonly t: Translate;
  readonly tenant: TenantDirectoryEntry | undefined;
  readonly title: string;
}) => {
  const invoiceParams =
    tenant === undefined
      ? ''
      : new URLSearchParams({
          counterpartyId: tenant.counterpartyId,
          partyId: tenant.partyId,
          tenantId: tenant.counterpartyRef.tenantId,
        }).toString();
  return (
    <SectionCard title={title}>
      <DetailList
        items={[
          { label: t(`${P}.detail.customerName`), value: tenant?.displayName ?? fallbackName },
          { label: t(`${P}.related.companyId`), value: tenant?.companyId ?? t(`${P}.related.notProvided`) },
          { label: t(`${P}.related.email`), value: tenant?.email ?? t(`${P}.related.notProvided`) },
          { label: t(`${P}.related.phone`), value: tenant?.phone ?? t(`${P}.related.notProvided`) },
        ]}
      />
      {tenant !== undefined && (
        <div className="siamparkoccupancy:flex siamparkoccupancy:flex-wrap siamparkoccupancy:gap-2">
          <LinkButton
            href={`/${language}/siampark/work?partyId=${tenant.partyId}`}
            icon="icon-[mdi--clipboard-check-outline]"
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {t(`${P}.related.tenantTasks`)}
          </LinkButton>
          <LinkButton
            href={`/${language}/siampark/finance?${invoiceParams}`}
            icon="icon-[mdi--receipt-text-outline]"
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {t(`${P}.related.tenantInvoices`)}
          </LinkButton>
          <LinkButton
            href={`/${language}/prodej/zakaznici`}
            icon="icon-[mdi--account-box-outline]"
            size="sm"
            theme="borderless"
            variant="secondary"
          >
            {t(`${P}.related.customers`)}
          </LinkButton>
        </div>
      )}
    </SectionCard>
  );
};

export const ContractCard = ({
  contract,
  language,
  t,
}: {
  readonly contract: LeaseContract | undefined;
  readonly language: string;
  readonly t: Translate;
}) => (
  <SectionCard title={t(`${P}.related.contractCard`)}>
    {contract === undefined ? (
      <>
        <p className={mutedClass}>{t(`${P}.related.noContract`)}</p>
        <div>
          <LinkButton
            href={`/${language}/siampark/agreements`}
            icon="icon-[mdi--file-document-outline]"
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {t(`${P}.related.allContracts`)}
          </LinkButton>
        </div>
      </>
    ) : (
      <>
        <div className="siamparkoccupancy:flex siamparkoccupancy:flex-wrap siamparkoccupancy:gap-2">
          <Badge size="sm" variant={contractBadge[contract.lifecycleState]}>
            {t(`${P}.related.contractStates.${contract.lifecycleState}`)}
          </Badge>
          <Badge size="sm" variant={signatureBadge[contract.signatureState]}>
            {t(`${P}.related.signatureStates.${contract.signatureState}`)}
          </Badge>
        </div>
        <DetailList
          items={[
            {
              label: t(`${P}.related.contractSubject`),
              value: contract.subject ?? t(`${P}.related.notProvided`),
            },
            {
              label: t(`${P}.related.contractPeriod`),
              value: `${formatDate(contract.startDate)} – ${
                contract.endDate === null ? t(`${P}.demo.openEnd`) : formatDate(contract.endDate)
              }`,
            },
            {
              label: t(`${P}.related.responsiblePerson`),
              value: contract.responsiblePerson ?? t(`${P}.related.notProvided`),
            },
            {
              label: t(`${P}.rent.monthlyTotal`),
              value:
                contract.rentTerms === undefined
                  ? t(`${P}.related.notProvided`)
                  : formatMoney(monthlyTotal(contract.rentTerms), contract.rentTerms.currency),
            },
          ]}
        />
        <div>
          <LinkButton
            href={`/${language}/siampark/agreements?resourceId=${contract.contractRef.resourceId}`}
            icon="icon-[mdi--file-sign]"
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {t(`${P}.related.openContract`)}
          </LinkButton>
        </div>
      </>
    )}
  </SectionCard>
);

export const TasksCard = ({
  language,
  t,
  tasks,
}: {
  readonly language: string;
  readonly t: Translate;
  readonly tasks: LeaseRelated['tasks'];
}) => (
  <SectionCard
    actions={
      <LinkButton
        href={`/${language}/siampark/work`}
        icon="icon-[mdi--arrow-right]"
        size="sm"
        theme="borderless"
        variant="secondary"
      >
        {t(`${P}.related.openTasks`)}
      </LinkButton>
    }
    title={t(`${P}.related.tasksCard`)}
  >
    {tasks === undefined && <p className={mutedClass}>{t(`${P}.demo.feedback.loading`)}</p>}
    {tasks === 'unavailable' && <p className={mutedClass}>{t(`${P}.related.tasksUnavailable`)}</p>}
    {isLoadedList(tasks) && tasks.length === 0 && <p className={mutedClass}>{t(`${P}.related.noTasks`)}</p>}
    {isLoadedList(tasks) && tasks.length > 0 && (
      <ul className="siamparkoccupancy:space-y-2">
        {tasks.map((task) => (
          <li className={rowClass} key={task.ref.resourceId}>
            <a
              className="siamparkoccupancy:min-w-0 siamparkoccupancy:font-medium"
              href={`/${language}/siampark/work?resourceId=${task.ref.resourceId}`}
            >
              {task.title} →
            </a>
            <span className="siamparkoccupancy:flex siamparkoccupancy:items-center siamparkoccupancy:gap-2">
              {task.dueDate !== undefined && (
                <span className={mutedClass}>{t(`${P}.related.due`, { date: formatDate(task.dueDate) })}</span>
              )}
              <Badge size="sm" variant={taskBadge[task.state]}>
                {t(`${P}.related.taskStates.${task.state}`)}
              </Badge>
            </span>
          </li>
        ))}
      </ul>
    )}
  </SectionCard>
);

export const InvoicesCard = ({
  invoices,
  language,
  t,
}: {
  readonly invoices: LeaseRelated['invoices'];
  readonly language: string;
  readonly t: Translate;
}) => (
  <SectionCard
    actions={
      <LinkButton
        href={`/${language}/siampark/finance`}
        icon="icon-[mdi--arrow-right]"
        size="sm"
        theme="borderless"
        variant="secondary"
      >
        {t(`${P}.related.allInvoices`)}
      </LinkButton>
    }
    title={t(`${P}.related.invoicesCard`)}
  >
    {invoices === undefined && <p className={mutedClass}>{t(`${P}.demo.feedback.loading`)}</p>}
    {invoices === 'unavailable' && <p className={mutedClass}>{t(`${P}.related.invoicesUnavailable`)}</p>}
    {isLoadedList(invoices) && invoices.length === 0 && <p className={mutedClass}>{t(`${P}.related.noInvoices`)}</p>}
    {isLoadedList(invoices) && invoices.length > 0 && (
      <ul className="siamparkoccupancy:space-y-2">
        {invoices.map((invoice) => (
          <li className={rowClass} key={invoice.ref.resourceId}>
            <span className="siamparkoccupancy:min-w-0">
              <span className="siamparkoccupancy:block siamparkoccupancy:font-medium">
                {invoice.number ?? invoice.documentNumber}
              </span>
              <span className={mutedClass}>
                {formatDate(invoice.issueDate)} · {formatMoney(invoice.totalMinor, invoice.currency)}
              </span>
            </span>
            <span className="siamparkoccupancy:flex siamparkoccupancy:flex-wrap siamparkoccupancy:items-center siamparkoccupancy:gap-2">
              <Badge size="sm" variant={invoiceBadge[invoice.businessState]}>
                {t(`${P}.related.invoiceStates.${invoice.businessState}`)}
              </Badge>
              <Badge size="sm" variant={invoice.paymentState === 'PAID' ? 'success' : 'outline'}>
                {t(`${P}.related.paymentStates.${invoice.paymentState}`)}
              </Badge>
              <LinkButton
                href={`/${language}/siampark/finance?resourceId=${invoice.ref.resourceId}`}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                {t(`${P}.related.openInvoice`)}
              </LinkButton>
            </span>
          </li>
        ))}
      </ul>
    )}
  </SectionCard>
);

export const RentEditButton = ({
  label,
  onClick,
  disabled,
}: {
  readonly disabled: boolean;
  readonly label: string;
  readonly onClick: () => void;
}) => (
  <Button disabled={disabled} onClick={onClick} size="sm" theme="outlined" variant="secondary">
    {label}
  </Button>
);
