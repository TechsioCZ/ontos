import {
  DetailList,
  SaveBar,
  SectionCard,
  SidePanel,
  UnsavedChangesDialog,
  formatDate,
  formatMoney,
  saveLabelsFor,
  useRecordDraft,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { RevisionedSaveResult } from '@app/admin-ui';
import type { ActionProposalAccepted } from '@app/core-runtime/http/action-proposal';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Effect, Option, Predicate } from 'effect';
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
import { saveTerms } from './use-agreements-records.ts';
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
 * The terms of the selected contract. Typing changes the draft only; the Save button sends it against the revision the
 * draft builds on, and when someone else changed these terms, the panel offers the current version instead. Closing
 * the panel or leaving the page with unsaved changes asks first.
 */
export interface ContractTermsPanelProps {
  readonly contract: Contract;
  /** Closes the panel; called once the guard let the person leave. */
  readonly onClose: () => void;
  /** Told about a change that was parked for approval instead of being saved. */
  readonly onProposal?: ((proposal: ActionProposalAccepted) => void) | undefined;
  /** Revision of the agreements the contract was read at. */
  readonly revision: number;
}

export const ContractTermsPanel = ({ contract, onClose, onProposal, revision }: ContractTermsPanelProps) => {
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  const server = termsDraftOf(contract);
  /** The version of the terms the draft builds on: what the panel opened with, last saved or reloaded. */
  const base = useRef(server);
  const rememberSaved = (value: TermsDraft, result: RevisionedSaveResult) => {
    if (Predicate.isNumber(result) || result === 'saved') {
      base.current = value;
    }
  };
  const send = (value: TermsDraft, expectedRevision: number, command: ContractTermsCommand) =>
    saveTerms(
      command,
      expectedRevision,
      termsUnchangedSince(contract.contractRef.resourceId, base.current),
      onProposal,
    ).pipe(Effect.tap((result) => Effect.sync(() => rememberSaved(value, result))));
  const record = useRecordDraft<TermsDraft, never>({
    equals: sameTermsDraft,
    isValid: (value) => Option.isSome(termsCommandOf(contract.contractRef, value)),
    revision,
    runtime: browserRuntime,
    save: (value, expectedRevision) =>
      Option.match(termsCommandOf(contract.contractRef, value), {
        onNone: () => Effect.succeed<RevisionedSaveResult>('failed'),
        onSome: (command) => send(value, expectedRevision, command),
      }),
    server,
  });
  const settledOnServer = !record.pending && sameTermsDraft(record.draft, server);
  useEffect(() => {
    if (settledOnServer) {
      base.current = server;
    }
  }, [base, server, settledOnServer]);
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: record.discard });
  const { draft } = record;
  const problems = termsProblems(draft);
  const invalid = (problem: boolean) =>
    problem ? { helpText: t(`${P}.terms.invalidAmount`), validateStatus: 'error' as const } : {};
  const change = (field: keyof TermsDraft) => (value: string) =>
    record.setDraft((current) => ({ ...current, [field]: value }));
  const requestClose = () => {
    guard.request(onClose);
  };
  const handleSave = record.save;
  const handleReloadLatest = record.reloadLatest;
  return (
    <SidePanel
      actions={
        <>
          <Button onClick={requestClose} theme="outlined" variant="secondary">
            {t('legal-agreements.detail.close')}
          </Button>
          <SaveBar labels={labels} onReloadLatest={handleReloadLatest} onSave={handleSave} status={record.status} />
        </>
      }
      closeLabel={t('legal-agreements.detail.close')}
      guard={guard}
      initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('#contract-terms-subject')}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      resizeLabel={t('legal-agreements.detail.resizePanel')}
      size="md"
      title={t(`${P}.terms.title`)}
    >
      <form
        className="legalagreements:space-y-4 legalagreements:py-2"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          handleSave();
        }}
      >
        <p className={mutedClass}>{t(`${P}.terms.formHint`)}</p>
        <FormInput
          id="contract-terms-subject"
          label={t(`${P}.terms.subject`)}
          onChange={(event) => change('subject')(event.target.value)}
          value={draft.subject}
        />
        <div className="legalagreements:grid legalagreements:gap-4 legalagreements:md:grid-cols-2">
          <FormInput
            id="contract-terms-owner"
            label={t(`${P}.terms.responsiblePerson`)}
            onChange={(event) => change('responsiblePerson')(event.target.value)}
            value={draft.responsiblePerson}
          />
          <FormInput
            id="contract-terms-notice"
            label={t(`${P}.terms.noticePeriod`)}
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
            onChange={(event) => change('monthly')(event.target.value)}
            value={draft.monthly}
            {...invalid(problems.monthly)}
          />
          <FormInput
            id="contract-terms-service"
            inputMode="decimal"
            label={t(`${P}.terms.serviceChargesInput`)}
            onChange={(event) => change('service')(event.target.value)}
            value={draft.service}
            {...invalid(problems.service)}
          />
          <FormInput
            id="contract-terms-payment-day"
            label={t(`${P}.terms.paymentDayInput`)}
            max={31}
            min={1}
            onChange={(event) => change('paymentDay')(event.target.value)}
            type="number"
            value={draft.paymentDay}
            {...(problems.paymentDay
              ? { helpText: t(`${P}.terms.invalidPaymentDay`), validateStatus: 'error' as const }
              : {})}
          />
        </div>
      </form>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </SidePanel>
  );
};

export const ContractTermsForm = ({ state }: { readonly state: PageState }) => {
  if (!state.termsOpen || state.selected === undefined) {
    return null;
  }
  const handleProposal = state.reportProposal;
  return (
    <ContractTermsPanel
      contract={state.selected}
      key={state.selected.contractRef.resourceId}
      onClose={() => state.setTermsOpen(false)}
      onProposal={handleProposal}
      revision={state.snapshot?.revision ?? 0}
    />
  );
};
