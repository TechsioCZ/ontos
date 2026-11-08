import {
  AutosaveStatus,
  DetailList,
  SectionCard,
  SidePanel,
  formatDate,
  formatMoney,
  useAutosaveDraft,
} from '@app/admin-ui';
import type { RevisionedSaveResult } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Effect, Option } from 'effect';
import { useEffect, useRef } from 'react';

import type { Contract } from '../../../../shared/apis/records.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import {
  sameTermsDraft,
  termsCommandOf,
  termsDraftOf,
  termsProblems,
  termsUnchangedSince,
} from './contract-terms-draft.ts';
import type { ContractTermsCommand, TermsDraft } from './contract-terms-draft.ts';
import { autosaveTerms } from './use-agreements-records.ts';
import type { useRecordsPage } from './use-agreements-records.ts';

type PageState = ReturnType<typeof useRecordsPage>;
const P = 'legal-agreements';
const mutedClass = 'legalagreements:text-sm legalagreements:text-(--color-fg-secondary)';

export const contractMonthlyTotal = (record: Contract) =>
  record.rentTerms === undefined ? undefined : record.rentTerms.monthlyRentMinor + record.rentTerms.serviceChargesMinor;

/** Subject, responsible person, notice period and the agreed rent of one contract (S12, S10-03). */
export const ContractTermsCard = ({ state }: { readonly state: PageState }) => {
  const { openTerms: handleOpenTerms, selected, t } = state;
  if (selected === undefined) {
    return null;
  }
  const missing = t(`${P}.terms.notProvided`);
  const total = contractMonthlyTotal(selected);
  return (
    <SectionCard
      actions={
        state.detailView.canEditTerms ? (
          <Button disabled={state.busy} onClick={handleOpenTerms} size="sm" theme="outlined" variant="secondary">
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
  const counterpartyName = counterparty?.displayName;
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
      {counterpartyName !== null && counterpartyName !== undefined && (
        <DetailList items={[{ label: t(`${P}.links.tenant`), value: counterpartyName }]} />
      )}
      <div className="legalagreements:flex legalagreements:flex-col legalagreements:items-start legalagreements:gap-2">
        {links.map((link) => (
          <LinkButton href={link.href} icon={link.icon} key={link.href} size="sm" theme="outlined" variant="secondary">
            {link.label}
          </LinkButton>
        ))}
      </div>
    </SectionCard>
  );
};

/**
 * The terms of the selected contract. Changes save themselves (debounced, on blur and on Zavřít) against the revision
 * the draft builds on; when someone else changed these terms, the panel offers the current version instead.
 */
const ContractTermsPanel = ({ contract, state }: { readonly contract: Contract; readonly state: PageState }) => {
  const { t } = state;
  const server = termsDraftOf(contract);
  /** The version of the terms the draft builds on: what the panel opened with, last saved or reloaded. */
  const base = useRef(server);
  const rememberSaved = (value: TermsDraft, result: RevisionedSaveResult) => {
    if (result !== 'conflict' && result !== 'failed') {
      base.current = value;
    }
  };
  const send = (value: TermsDraft, expectedRevision: number, command: ContractTermsCommand) =>
    autosaveTerms(
      command,
      expectedRevision,
      termsUnchangedSince(contract.contractRef.resourceId, base.current),
      state.reportProposal,
    ).pipe(Effect.tap((result) => Effect.sync(() => rememberSaved(value, result))));
  const autosave = useAutosaveDraft<TermsDraft, never>({
    equals: sameTermsDraft,
    isValid: (value) => Option.isSome(termsCommandOf(contract.contractRef, value)),
    revision: state.snapshot?.revision ?? 0,
    runtime: browserRuntime,
    save: (value, expectedRevision) =>
      Option.match(termsCommandOf(contract.contractRef, value), {
        onNone: () => Effect.succeed<RevisionedSaveResult>('failed'),
        onSome: (command) => send(value, expectedRevision, command),
      }),
    server,
  });
  const settledOnServer = !autosave.pending && sameTermsDraft(autosave.draft, server);
  useEffect(() => {
    if (settledOnServer) {
      base.current = server;
    }
  }, [base, server, settledOnServer]);
  const { draft } = autosave;
  const problems = termsProblems(draft);
  const invalid = (problem: boolean) =>
    problem ? { helpText: t(`${P}.terms.invalidAmount`), validateStatus: 'error' as const } : {};
  const change = (field: keyof TermsDraft) => (value: string) =>
    autosave.setDraft((current) => ({ ...current, [field]: value }));
  const close = () => {
    autosave.flush();
    state.setTermsOpen(false);
  };
  const handleBlur = autosave.flush;
  const handleRetry = autosave.retry;
  const handleReloadLatest = autosave.reloadLatest;
  return (
    <SidePanel
      actions={
        <>
          <AutosaveStatus onReloadLatest={handleReloadLatest} onRetry={handleRetry} status={autosave.status} />
          <Button onClick={close} theme="outlined" variant="secondary">
            {t('legal-agreements.detail.close')}
          </Button>
        </>
      }
      closeLabel={t('legal-agreements.detail.close')}
      initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('#contract-terms-subject')}
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
      open
      resizeLabel={t('legal-agreements.detail.resizePanel')}
      size="md"
      title={t(`${P}.terms.title`)}
    >
      <div className="legalagreements:space-y-4 legalagreements:py-2">
        <p className={mutedClass}>{t(`${P}.terms.formHint`)}</p>
        <FormInput
          id="contract-terms-subject"
          label={t(`${P}.terms.subject`)}
          onBlur={handleBlur}
          onChange={(event) => change('subject')(event.target.value)}
          value={draft.subject}
        />
        <div className="legalagreements:grid legalagreements:gap-4 legalagreements:md:grid-cols-2">
          <FormInput
            id="contract-terms-owner"
            label={t(`${P}.terms.responsiblePerson`)}
            onBlur={handleBlur}
            onChange={(event) => change('responsiblePerson')(event.target.value)}
            value={draft.responsiblePerson}
          />
          <FormInput
            id="contract-terms-notice"
            label={t(`${P}.terms.noticePeriod`)}
            onBlur={handleBlur}
            onChange={(event) => change('noticePeriod')(event.target.value)}
            value={draft.noticePeriod}
          />
        </div>
        <h3 className="legalagreements:text-sm legalagreements:font-semibold">{t(`${P}.terms.rentSection`)}</h3>
        <div className="legalagreements:grid legalagreements:gap-4 legalagreements:md:grid-cols-3">
          <FormInput
            id="contract-terms-monthly"
            inputMode="decimal"
            label={t(`${P}.terms.monthlyRentInput`)}
            onBlur={handleBlur}
            onChange={(event) => change('monthly')(event.target.value)}
            value={draft.monthly}
            {...invalid(problems.monthly)}
          />
          <FormInput
            id="contract-terms-service"
            inputMode="decimal"
            label={t(`${P}.terms.serviceChargesInput`)}
            onBlur={handleBlur}
            onChange={(event) => change('service')(event.target.value)}
            value={draft.service}
            {...invalid(problems.service)}
          />
          <FormInput
            id="contract-terms-payment-day"
            label={t(`${P}.terms.paymentDayInput`)}
            max={31}
            min={1}
            onBlur={handleBlur}
            onChange={(event) => change('paymentDay')(event.target.value)}
            type="number"
            value={draft.paymentDay}
            {...(problems.paymentDay
              ? { helpText: t(`${P}.terms.invalidPaymentDay`), validateStatus: 'error' as const }
              : {})}
          />
        </div>
      </div>
    </SidePanel>
  );
};

export const ContractTermsForm = ({ state }: { readonly state: PageState }) =>
  state.termsOpen && state.selected !== undefined ? (
    <ContractTermsPanel contract={state.selected} key={state.selected.contractRef.resourceId} state={state} />
  ) : null;
