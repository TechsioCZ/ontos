import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  saveLabelsFor,
  useRecordDraft,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Effect, Option } from 'effect';
import { useState } from 'react';
import type { Feedback } from '../../../../shared/actions/apply-command.ts';
import type { Contract } from '../../../../shared/apis/records.ts';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { failureReasonOf, revisionedResultOf } from './agreements-command.ts';
import type { AgreementOutcome } from './agreements-command.ts';
import { periodDraftOf, samePeriodDraft, validPeriod } from './agreement-draft.ts';
import type { PeriodDraft } from './agreement-draft.ts';

export interface ContractPeriodPanelProps {
  /** The draft contract as the page reads it now. */
  readonly contract: Contract;
  /** What the contract is about (its unit, or the kind of a contract without one). */
  readonly label: string;
  /** Closes the panel; called once the guard let the person leave. */
  readonly onClose: () => void;
  /** Sends one save of the period against `expectedRevision`. */
  readonly onSave: (
    draft: PeriodDraft,
    expectedRevision: number,
    confirmed: PeriodDraft,
  ) => Effect.Effect<AgreementOutcome>;
  /** Re-reads the agreements for "Načíst aktuální verzi". */
  readonly reload: Effect.Effect<void>;
  /** Revision of the agreements the contract was read at. */
  readonly revision: number;
}

/**
 * The period of a draft contract. Typing changes the draft only; Uložit sends it against the revision the draft was
 * read at, and someone else's change of this contract comes back as a conflict that offers the newer version.
 * Closing the panel or leaving the page with unsaved changes asks first.
 */
export const ContractPeriodPanel = ({
  contract,
  label,
  onClose,
  onSave,
  reload,
  revision,
}: ContractPeriodPanelProps) => {
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  const [reason, setReason] = useState(() => Option.none<Feedback>());
  const record = useRecordDraft<PeriodDraft, never>({
    equals: samePeriodDraft,
    isValid: validPeriod,
    refresh: reload,
    revision,
    runtime: browserRuntime,
    save: (value, expectedRevision, confirmed) =>
      onSave(value, expectedRevision, confirmed).pipe(
        Effect.tap((outcome) => Effect.sync(() => setReason(failureReasonOf(outcome)))),
        Effect.map(revisionedResultOf),
      ),
    server: periodDraftOf(contract),
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: record.discard });
  const { draft } = record;
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
          <SaveBar
            error={Option.match(reason, {
              onNone: () => null,
              onSome: (value) => t(`legal-agreements.demo.feedback.${value}`),
            })}
            labels={labels}
            onReloadLatest={handleReloadLatest}
            onSave={handleSave}
            status={record.status}
          />
        </>
      }
      closeLabel={t('legal-agreements.detail.close')}
      guard={guard}
      initialFocusEl={() => globalThis.document.querySelector<HTMLElement>('#contract-start-date')}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      resizeLabel={t('legal-agreements.detail.resizePanel')}
      size="lg"
      title={t('legal-agreements.demo.editDraft')}
    >
      <form
        className="legalagreements:space-y-4 legalagreements:py-2"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          handleSave();
        }}
      >
        <p>{label}</p>
        <div className="legalagreements:grid legalagreements:gap-4 legalagreements:md:grid-cols-2">
          <FormInput
            id="contract-start-date"
            label={t('legal-agreements.demo.startDate')}
            onChange={(event) => record.setDraft((current) => ({ ...current, startDate: event.target.value }))}
            type="date"
            value={draft.startDate}
          />
          <FormInput
            id="contract-end-date"
            label={t('legal-agreements.demo.endDate')}
            onChange={(event) => record.setDraft((current) => ({ ...current, endDate: event.target.value }))}
            type="date"
            value={draft.endDate}
          />
        </div>
      </form>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </SidePanel>
  );
};
