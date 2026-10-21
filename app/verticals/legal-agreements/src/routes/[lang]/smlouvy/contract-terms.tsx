import { DetailList, SectionCard, SidePanel, formatDate, formatMoney } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';

import type { Contract } from '../../../../shared/apis/records.ts';
import type { useRecordsPage } from './use-agreements-records.ts';

type PageState = ReturnType<typeof useRecordsPage>;
const P = 'legal-agreements';
const mutedClass = 'legalagreements:text-sm legalagreements:text-(--color-fg-secondary)';

export const contractMonthlyTotal = (record: Contract) =>
  record.rentTerms === undefined ? undefined : record.rentTerms.monthlyRentMinor + record.rentTerms.serviceChargesMinor;

/** Subject, responsible person, notice period and the agreed rent of one contract (S12, S10-03). */
export const ContractTermsCard = ({ state }: { readonly state: PageState }) => {
  const { selected, t } = state;
  if (selected === undefined) {
    return null;
  }
  const missing = t(`${P}.terms.notProvided`);
  const total = contractMonthlyTotal(selected);
  return (
    <SectionCard
      actions={
        state.detailView.canEditTerms ? (
          <Button disabled={state.busy} onClick={state.openTerms} size="sm" theme="outlined" variant="secondary">
            {t(`${P}.terms.edit`)}
          </Button>
        ) : undefined
      }
      title={t(`${P}.terms.title`)}
    >
      {total !== undefined && (
        <div className="legalagreements:flex legalagreements:flex-wrap legalagreements:items-baseline legalagreements:gap-3">
          <span className="legalagreements:text-2xl legalagreements:font-semibold legalagreements:tabular-nums">
            {formatMoney(total)}
          </span>
          <span className={mutedClass}>{t(`${P}.terms.monthlyTotal`)}</span>
        </div>
      )}
      <DetailList
        items={[
          { label: t(`${P}.terms.subject`), value: selected.subject ?? missing },
          { label: t(`${P}.terms.responsiblePerson`), value: selected.responsiblePerson ?? missing },
          { label: t(`${P}.terms.noticePeriod`), value: selected.noticePeriod ?? missing },
          {
            label: t(`${P}.terms.renewalNotice`),
            value: selected.renewalNoticeDate === null ? missing : formatDate(selected.renewalNoticeDate),
          },
          {
            label: t(`${P}.terms.monthlyRent`),
            value: selected.rentTerms === undefined ? missing : formatMoney(selected.rentTerms.monthlyRentMinor),
          },
          {
            label: t(`${P}.terms.serviceCharges`),
            value: selected.rentTerms === undefined ? missing : formatMoney(selected.rentTerms.serviceChargesMinor),
          },
          {
            label: t(`${P}.terms.paymentDay`),
            value:
              selected.rentTerms === undefined
                ? missing
                : t(`${P}.terms.paymentDayValue`, { day: selected.rentTerms.paymentDay }),
          },
          { label: t(`${P}.terms.currency`), value: selected.rentTerms?.currency ?? 'CZK' },
        ]}
      />
    </SectionCard>
  );
};

/** Links from the contract to its building, unit, lease, tenant tasks and invoices. */
export const ContractLinksCard = ({ state }: { readonly state: PageState }) => {
  const { language, selected, t } = state;
  if (selected === undefined) {
    return null;
  }
  const counterparty = state.counterpartyOf(selected);
  const invoiceParams =
    counterparty === undefined
      ? ''
      : new URLSearchParams({
          counterpartyId: counterparty.counterpartyId,
          partyId: counterparty.partyId,
          tenantId: counterparty.counterpartyRef.tenantId,
        }).toString();
  const links = [
    selected.propertyRef === null
      ? undefined
      : {
          href: `/${language}/nemovitosti?resourceId=${selected.propertyRef.resourceId}`,
          icon: 'icon-[mdi--office-building-outline]' as const,
          label: t(`${P}.links.property`),
        },
    selected.unitRef === null
      ? undefined
      : {
          href: `/${language}/nemovitosti?resourceId=${selected.unitRef.resourceId}`,
          icon: 'icon-[mdi--door]' as const,
          label: t(`${P}.links.unit`),
        },
    selected.occupancyRef === null
      ? undefined
      : {
          href: `/${language}/najmy?resourceId=${selected.occupancyRef.resourceId}`,
          icon: 'icon-[mdi--key-variant]' as const,
          label: t(`${P}.links.lease`),
        },
    counterparty === undefined
      ? undefined
      : {
          href: `/${language}/ukoly?partyId=${counterparty.partyId}`,
          icon: 'icon-[mdi--clipboard-check-outline]' as const,
          label: t(`${P}.links.tenantTasks`),
        },
    counterparty === undefined
      ? undefined
      : {
          href: `/${language}/finance?${invoiceParams}`,
          icon: 'icon-[mdi--receipt-text-outline]' as const,
          label: t(`${P}.links.tenantInvoices`),
        },
  ].filter((link) => link !== undefined);
  return (
    <SectionCard title={t(`${P}.links.title`)}>
      {counterparty?.displayName != null && (
        <DetailList items={[{ label: t(`${P}.links.tenant`), value: counterparty.displayName }]} />
      )}
      <div className="legalagreements:flex legalagreements:flex-col legalagreements:items-start legalagreements:gap-2">
        {links.map((link) => (
          <LinkButton
            href={link.href}
            icon={link.icon}
            key={link.href}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {link.label}
          </LinkButton>
        ))}
      </div>
    </SectionCard>
  );
};

export const ContractTermsForm = ({ state }: { readonly state: PageState }) => {
  const { busy, feedback, t, terms } = state;
  if (!state.termsOpen) {
    return null;
  }
  const change = (field: keyof typeof terms) => (value: string) =>
    state.setTerms((current) => ({ ...current, [field]: value }));
  return (
    <SidePanel
      actions={
        <>
          <Button disabled={busy} onClick={() => state.setTermsOpen(false)} theme="outlined" variant="secondary">
            {t('legal-agreements.detail.close')}
          </Button>
          <Button disabled={busy} isLoading={feedback === 'saving'} onClick={state.saveTerms} variant="primary">
            {t(`${P}.terms.save`)}
          </Button>
        </>
      }
      closeLabel={t('legal-agreements.detail.close')}
      closeOnInteractOutside={false}
      initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('#contract-terms-subject')}
      onOpenChange={(open) => {
        if (!open && !busy) {
          state.setTermsOpen(false);
        }
      }}
      open
      resizeLabel={t('legal-agreements.detail.resizePanel')}
      size="md"
      title={t(`${P}.terms.title`)}
    >
      <div className="legalagreements:space-y-4 legalagreements:py-2">
        <p className={mutedClass}>{t(`${P}.terms.formHint`)}</p>
        {feedback === 'validation' && <output aria-live="polite">{t(`${P}.demo.feedback.validation`)}</output>}
        <FormInput
          id="contract-terms-subject"
          label={t(`${P}.terms.subject`)}
          onChange={(event) => change('subject')(event.target.value)}
          value={terms.subject}
        />
        <div className="legalagreements:grid legalagreements:gap-4 legalagreements:md:grid-cols-2">
          <FormInput
            id="contract-terms-owner"
            label={t(`${P}.terms.responsiblePerson`)}
            onChange={(event) => change('responsiblePerson')(event.target.value)}
            value={terms.responsiblePerson}
          />
          <FormInput
            id="contract-terms-notice"
            label={t(`${P}.terms.noticePeriod`)}
            onChange={(event) => change('noticePeriod')(event.target.value)}
            value={terms.noticePeriod}
          />
        </div>
        <h3 className="legalagreements:text-sm legalagreements:font-semibold">{t(`${P}.terms.rentSection`)}</h3>
        <div className="legalagreements:grid legalagreements:gap-4 legalagreements:md:grid-cols-3">
          <FormInput
            id="contract-terms-monthly"
            inputMode="decimal"
            label={t(`${P}.terms.monthlyRentInput`)}
            onChange={(event) => change('monthly')(event.target.value)}
            value={terms.monthly}
          />
          <FormInput
            id="contract-terms-service"
            inputMode="decimal"
            label={t(`${P}.terms.serviceChargesInput`)}
            onChange={(event) => change('service')(event.target.value)}
            value={terms.service}
          />
          <FormInput
            id="contract-terms-payment-day"
            label={t(`${P}.terms.paymentDayInput`)}
            max={31}
            min={1}
            onChange={(event) => change('paymentDay')(event.target.value)}
            type="number"
            value={terms.paymentDay}
          />
        </div>
      </div>
    </SidePanel>
  );
};
