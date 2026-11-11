// Prepares a payment reminder. Typing changes only the draft. Recording it really sends an e-mail, so the shared Uložit
// (in the footer and in the leave question) only opens a review naming the recipient; its confirmation records the
// reminder once, and the e-mail dispatcher sends it after the commit. Copy and download record nothing.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Data, Effect, Schema } from 'effect';
import { UnsavedChangesDialog, dialogCloseLabel, surfaceTileClassName } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useState } from 'react';
import type { Invoice } from '../../../../shared/apis/records.ts';
import { reminderText } from '../../../../shared/domain/finance-planning.ts';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
import { FinanceSaveActions, useFinanceFormSave } from './finance-form-save.tsx';
import type { FinanceFormSave } from './finance-form-save.tsx';
import type { FinanceCommandDraft, FinanceViewModel } from './finance-ui.tsx';
import type { EmailProviderState } from './reminder-email-receipts.tsx';

/** Same bound as FinanceLongTextSchema in shared/apis/records.ts (trimmed reminder text, at most 4000 characters). */
const REMINDER_TEXT_MAX = 4000;

class FinanceClipboardError extends Data.TaggedError('FinanceClipboardError')<{
  readonly cause: Schema.Defect['Type'];
}> {}

interface ReminderDraft {
  readonly recipient: string;
  readonly text: string;
}

/** Why the reminder cannot be saved yet, or undefined when it can. */
const reminderProblem = (draft: ReminderDraft, canSendEmail: boolean): string | undefined => {
  // The contract trims the text; an untrimmed value (e.g. a trailing space or newline) fails to encode in the browser.
  const textLength = draft.text.trim().length;
  if (!canSendEmail) {
    return 'Odeslání e-mailem není dostupné – e-mailový poskytovatel není nastaven. Nic se neodeslalo.';
  }
  if (!/^\S+@\S+\.\S+$/u.test(draft.recipient.trim())) {
    return 'Zadejte platnou e-mailovou adresu příjemce.';
  }
  if (textLength === 0) {
    return 'Text upomínky nesmí být prázdný.';
  }
  return textLength > REMINDER_TEXT_MAX
    ? `Text upomínky je příliš dlouhý (${textLength} znaků, nejvýše ${REMINDER_TEXT_MAX}). Zkraťte ho.`
    : undefined;
};

const R = 'finance-billing.financeUi.reminders';

/** Where the review is: closed, open for the person to confirm, or confirmed and sending. */
const ReviewStepSchema = Schema.Literals(['closed', 'confirmed', 'open']);
type ReviewStep = typeof ReviewStepSchema.Type;

/** The review before the e-mail goes out: which invoice, to whom and on whose behalf. Only its confirm sends. */
const ReminderReview = ({
  invoice,
  issuerName,
  onBack,
  onConfirm,
  open,
  recipient,
  sending,
}: {
  readonly invoice: Invoice;
  readonly issuerName: string | undefined;
  /** Zpět: back to the form, nothing is sent. */
  readonly onBack: () => void;
  /** Records the reminder once; the e-mail is sent after the commit. */
  readonly onConfirm: () => void;
  readonly open: boolean;
  readonly recipient: string;
  readonly sending: boolean;
}) => {
  const { t } = useModernI18n();
  return (
    <Dialog
      actions={
        <>
          <Button disabled={sending} onClick={onBack} theme="outlined" variant="secondary">
            {t(`${R}.reviewBack`)}
          </Button>
          <Button disabled={sending} isLoading={sending} onClick={onConfirm} variant="primary">
            {t(`${R}.reviewConfirm`)}
          </Button>
        </>
      }
      closeLabel={dialogCloseLabel}
      customTrigger
      description={t(`${R}.reviewDescription`)}
      onOpenChange={(details) => {
        if (!details.open && !sending) {
          onBack();
        }
      }}
      open={open}
      placement="center"
      role="alertdialog"
      size="sm"
      title={t(`${R}.reviewTitle`)}
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-300 gap-y-100 text-sm" data-testid="reminder-review">
        <dt className="text-fg-secondary">{t(`${R}.reviewInvoice`)}</dt>
        <dd>{invoice.number ?? invoice.documentNumber}</dd>
        <dt className="text-fg-secondary">{t(`${R}.reviewRecipient`)}</dt>
        <dd className="font-semibold">{recipient}</dd>
        {issuerName !== undefined && (
          <>
            <dt className="text-fg-secondary">{t(`${R}.reviewSender`)}</dt>
            <dd>{issuerName}</dd>
          </>
        )}
      </dl>
    </Dialog>
  );
};

/** Uložit, in the footer and in the leave question, opens the review; it never sends the e-mail by itself. */
const useReviewedSave = (form: FinanceFormSave) => {
  const [review, setReview] = useState<ReviewStep>('closed');
  const sending = form.record.status === 'saving';
  // A confirmed review stays up while the reminder is recorded; a failure brings the form back with its reason.
  const open = review === 'open' || (review === 'confirmed' && sending);
  const openReview = () => setReview('open');
  const reviewed: FinanceFormSave = {
    ...form,
    guard: {
      ...form.guard,
      prompt: {
        ...form.guard.prompt,
        onSave: () => {
          form.guard.prompt.onStay();
          openReview();
        },
      },
    },
    handleSave: openReview,
  };
  return {
    handleBack: () => setReview('closed'),
    handleConfirm: () => {
      setReview('confirmed');
      form.handleSave();
    },
    open,
    reviewed,
    sending,
  };
};

const EmailProviderStatus = ({
  issuerName,
  provider,
}: {
  readonly issuerName: string | undefined;
  readonly provider: EmailProviderState;
}) => {
  if (provider.kind === 'loading') {
    return (
      <StatusText showIcon size="sm" status="default">
        Zjišťuji, zda je nastaven e-mailový poskytovatel…
      </StatusText>
    );
  }
  if (provider.kind === 'ready' && provider.provider.configured) {
    return (
      <StatusText showIcon size="sm" status="default">
        Po uložení se upomínka skutečně odešle e-mailem ({provider.provider.label ?? 'SMTP server'}) jménem{' '}
        {issuerName === undefined ? 'vybrané společnosti' : `společnosti ${issuerName}`}. Stav odeslání se zobrazí v
        seznamu upomínek.
      </StatusText>
    );
  }
  return (
    <StatusText showIcon size="sm" status="warning">
      {provider.kind === 'unavailable'
        ? 'Odeslání e-mailem teď není dostupné – e-mailovou službu nelze ověřit.'
        : 'Odeslání e-mailem není dostupné – e-mailový poskytovatel (SMTP server) není nastaven.'}{' '}
      Text upomínky zkopírujte nebo stáhněte a pošlete jinou cestou; jako odeslaná se nezaznamená.
    </StatusText>
  );
};

export const InvoiceReminderForm = ({
  counterpartyName,
  invoice,
  issuerName,
  onClose,
  provider,
  vm,
}: {
  readonly counterpartyName: string;
  readonly invoice: Invoice;
  readonly issuerName: string | undefined;
  readonly onClose: () => void;
  readonly provider: EmailProviderState;
  readonly vm: FinanceViewModel;
}) => {
  const { t } = useModernI18n();
  const canSendEmail = provider.kind === 'ready' && provider.provider.configured;
  // The suggested text is not typed input: an untouched form closes without asking.
  const initial: ReminderDraft = {
    recipient: '',
    text: reminderText({
      businessDate: vm.referenceDate,
      counterpartyName,
      invoice,
      senderName: vm.actorLabel ?? 'Finanční oddělení',
    }),
  };
  const [draft, setDraft] = useState(initial);
  const [notice, setNotice] = useState<string>();
  const form = useFinanceFormSave({
    initial,
    isValid: (value) => reminderProblem(value, canSendEmail) === undefined,
    onClose,
    reset: setDraft,
    send: (value) => {
      const command: FinanceCommandDraft<'RecordReminder'> = {
        _tag: 'RecordReminder',
        invoiceRef: invoice.ref,
        recipient: value.recipient.trim(),
        text: value.text.trim(),
      };
      if (vm.actorLabel !== undefined) {
        command.actorLabel = vm.actorLabel;
      }
      return vm.execute(command, 'Upomínka uložena a předána k odeslání e-mailem.');
    },
    value: draft,
    vm,
  });
  const review = useReviewedSave(form);
  const textLength = draft.text.trim().length;
  const textTooLong = textLength > REMINDER_TEXT_MAX;
  const problem = form.record.status === 'invalid' ? reminderProblem(draft, canSendEmail) : undefined;
  const copy = () => {
    void financeBrowserRuntime.runPromise(
      Effect.tryPromise({
        catch: (cause) => new FinanceClipboardError({ cause }),
        try: navigator.clipboard.writeText.bind(navigator.clipboard, draft.text),
      }).pipe(
        Effect.timeout('10 seconds'),
        Effect.tap(() => Effect.sync(() => setNotice('Text upomínky zkopírován do schránky.'))),
        Effect.result,
      ),
    );
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([`${draft.text.trim()}\n`], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `upominka-${invoice.number ?? invoice.documentNumber}.txt`;
    link.click();
    void financeBrowserRuntime.runPromise(
      Effect.sleep('1 second').pipe(Effect.andThen(Effect.sync(() => URL.revokeObjectURL(url)))),
    );
    setNotice('Návrh upomínky stažen jako textový soubor. Upomínka se jako odeslaná nezaznamenala.');
  };
  return (
    <div className={`${surfaceTileClassName} flex flex-col gap-150 p-200`}>
      <ReminderReview
        invoice={invoice}
        issuerName={issuerName}
        onBack={review.handleBack}
        onConfirm={review.handleConfirm}
        open={review.open}
        recipient={draft.recipient.trim()}
        sending={review.sending}
      />
      <EmailProviderStatus issuerName={issuerName} provider={provider} />
      {notice !== undefined && (
        <StatusText showIcon size="sm" status="success">
          {notice}
        </StatusText>
      )}
      {problem !== undefined && (
        <StatusText showIcon size="sm" status="warning">
          {problem}
        </StatusText>
      )}
      <FormInput
        id="reminder-recipient"
        label={t('finance-billing.financeUi.reminders.recipient')}
        onChange={(event) => {
          const { value } = event.target;
          setDraft((current) => ({ ...current, recipient: value }));
        }}
        placeholder={t('finance-billing.financeUi.reminders.emailExample')}
        size="sm"
        type="email"
        value={draft.recipient}
      />
      <FormTextarea
        helpText={
          textTooLong
            ? `${textLength} / ${REMINDER_TEXT_MAX} znaků – text je příliš dlouhý, zkraťte ho o ${textLength - REMINDER_TEXT_MAX}.`
            : `${textLength} / ${REMINDER_TEXT_MAX} znaků`
        }
        id="reminder-text"
        label={t('finance-billing.financeUi.reminders.message')}
        onChange={(event) => {
          const { value } = event.target;
          setDraft((current) => ({ ...current, text: value }));
        }}
        rows={9}
        validateStatus={textTooLong ? 'error' : 'default'}
        value={draft.text}
      />
      <div className="flex flex-wrap items-center gap-100">
        <Button icon="icon-[mdi--content-copy]" onClick={copy} size="sm" theme="outlined" variant="secondary">
          Kopírovat text
        </Button>
        <Button icon="icon-[mdi--download]" onClick={download} size="sm" theme="outlined" variant="secondary">
          Stáhnout návrh
        </Button>
        <div className="ml-auto flex flex-wrap items-center gap-100">
          <FinanceSaveActions form={review.reviewed} size="sm" />
        </div>
      </div>
      <UnsavedChangesDialog labels={form.labels} prompt={review.reviewed.guard.prompt} />
    </div>
  );
};
