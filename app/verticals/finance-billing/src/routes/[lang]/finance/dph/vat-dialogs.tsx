// The VAT settings dialogs: each one sends one change to Tax, as the signed-in person, and explains Tax's answer.
import { dialogCloseLabel } from '@app/admin-ui';
import {
  DateField,
  FlaggedTextField,
  FormBuilder,
  FormReact,
  FormRoot,
  SelectTemplateField,
  TextField,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { Effect, Schema } from 'effect';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { financeBrowserAtomRuntime, financeBrowserRuntime } from '../../../../runtime/browser.ts';
import { useIssueDateProps } from '../create-invoice-fields.tsx';
import { useFormDraft } from '../finance-form-draft.tsx';
import { formLabelProps } from '../invoice-view.ts';
import type { RateChangeInput, RegimeChangeInput } from './vat-settings-data.ts';
import { parseRatePercent } from './vat-settings-model.ts';
import type { VatChangeOutcome } from './vat-settings-model.ts';

const ns = 'finance-billing.vatSettings';

/**
 * The typed rate, first day and reason of a rate change. The dialog's own button sends them; Enter sends nothing, so
 * the form only holds them. Every dialog kind has its own form; the dialogs are modal, so one of a kind is open at a
 * time.
 */
const rateForm = FormReact.make(
  FormBuilder.empty.addField('from', Schema.String).addField('rate', Schema.String).addField('reason', Schema.String),
  {
    fields: { from: DateField, rate: FlaggedTextField, reason: FlaggedTextField },
    onSubmit: () => Effect.void,
    runtime: financeBrowserAtomRuntime,
  },
);
const openedRate: typeof rateForm.schema.Encoded = { from: '', rate: '', reason: '' };

/** The typed reason a planned rate is withdrawn; the dialog's own button sends it. */
const withdrawForm = FormReact.make(FormBuilder.empty.addField('reason', Schema.String), {
  fields: { reason: FlaggedTextField },
  onSubmit: () => Effect.void,
  runtime: financeBrowserAtomRuntime,
});
const openedWithdraw: typeof withdrawForm.schema.Encoded = { reason: '' };

const REGIMES = ['VAT_PAYER', 'NON_PAYER'] as const;

/** The regime picked, its first day and the optional reason; the dialog's own button sends them. */
const regimeForm = FormReact.make(
  FormBuilder.empty.addField('from', Schema.String).addField('reason', Schema.String).addField('regime', Schema.String),
  {
    fields: { from: DateField, reason: TextField, regime: SelectTemplateField },
    onSubmit: () => Effect.void,
    runtime: financeBrowserAtomRuntime,
  },
);
const openedRegime: typeof regimeForm.schema.Encoded = { from: '', reason: '', regime: 'VAT_PAYER' };

/** Runs one change and reports its outcome; the dialog closes only after Tax accepted it. */
const useChange = (onDone: () => void) => {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<VatChangeOutcome>();
  const run = (change: Effect.Effect<VatChangeOutcome>) => {
    setBusy(true);
    financeBrowserRuntime.runFork(
      change.pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            setBusy(false);
            setOutcome(result === 'done' ? undefined : result);
            if (result === 'done') {
              onDone();
            }
          }),
        ),
      ),
    );
  };
  return { busy, outcome, run };
};

const OutcomeNotice = ({ outcome }: { readonly outcome: VatChangeOutcome | undefined }) => {
  const { t } = useModernI18n();
  return outcome === undefined ? null : (
    <StatusText aria-live="polite" showIcon size="sm" status={outcome === 'confirmReplace' ? 'warning' : 'error'}>
      {t(`${ns}.outcome.${outcome}`)}
    </StatusText>
  );
};

const ChangeDialog = ({
  busy,
  children,
  description,
  onClose,
  onSubmit,
  submitLabel,
  title,
}: {
  readonly busy: boolean;
  readonly children: ReactNode;
  readonly description: string;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
  readonly submitLabel: string;
  readonly title: string;
}) => {
  const { t } = useModernI18n();
  return (
    <Dialog
      actions={
        <>
          <Button appearance="outline" onClick={onClose} severity="secondary">
            {t(`${ns}.cancel`)}
          </Button>
          <Button disabled={busy} onClick={onSubmit} severity="primary">
            {submitLabel}
          </Button>
        </>
      }
      closeLabel={dialogCloseLabel}
      customTrigger
      description={description}
      onOpenChange={(details) => {
        if (!details.open) {
          onClose();
        }
      }}
      open
      placement="center"
      size="md"
      title={title}
    >
      {children}
    </Dialog>
  );
};

/** The props of a rate change's reason; empty is flagged once the person tried to send. */
const useReasonProps = (invalid: boolean) => {
  const { t } = useModernI18n();
  return {
    helpText: invalid ? t(`${ns}.reasonRequired`) : undefined,
    id: 'vat-change-reason',
    invalid,
    label: t(`${ns}.reason`),
    placeholder: t(`${ns}.reasonExample`),
  };
};

/** A new rate from a day: either the first rate of a classification or a planned change of an existing one. */
export const RateDialog = ({
  description,
  onClose,
  send,
  submitLabel,
  title,
}: {
  readonly description: string;
  readonly onClose: () => void;
  readonly send: (input: RateChangeInput) => Effect.Effect<VatChangeOutcome>;
  readonly submitLabel: string;
  readonly title: string;
}) => {
  const { t } = useModernI18n();
  const { draft, ready } = useFormDraft(rateForm, openedRate);
  const { from, rate, reason } = draft;
  const [tried, setTried] = useState(false);
  const change = useChange(onClose);
  const ratePercent = parseRatePercent(rate);
  const rateInvalid = tried && ratePercent === undefined;
  const fromProps = useIssueDateProps({
    error: tried && from === '' ? t(`${ns}.fromRequired`) : undefined,
    label: t(`${ns}.from`),
  });
  const reasonField = useReasonProps(tried && reason.trim() === '');
  const submit = () => {
    setTried(true);
    if (ratePercent !== undefined && from !== '' && reason.trim() !== '') {
      change.run(send({ from, ratePercent, reason: reason.trim() }));
    }
  };
  return (
    <ChangeDialog
      busy={change.busy}
      description={description}
      onClose={onClose}
      onSubmit={submit}
      submitLabel={submitLabel}
      title={title}
    >
      <FormRoot className="flex flex-col gap-150" defaultValues={openedRate} form={rateForm} translateMessage={t}>
        {ready}
        <OutcomeNotice outcome={change.outcome} />
        <rateForm.rate
          helpText={rateInvalid ? t(`${ns}.rateInvalid`) : undefined}
          id="vat-rate-percent"
          inputMode="numeric"
          invalid={rateInvalid}
          label={t(`${ns}.ratePercent`)}
        />
        <rateForm.from {...fromProps} />
        <rateForm.reason {...reasonField} />
      </FormRoot>
    </ChangeDialog>
  );
};

/** Withdraws one planned rate; Tax keeps the withdrawn plan in the history with this reason. */
export const WithdrawDialog = ({
  label,
  onClose,
  send,
}: {
  readonly label: string;
  readonly onClose: () => void;
  readonly send: (reason: string) => Effect.Effect<VatChangeOutcome>;
}) => {
  const { t } = useModernI18n();
  const { draft, ready } = useFormDraft(withdrawForm, openedWithdraw);
  const { reason } = draft;
  const [tried, setTried] = useState(false);
  const change = useChange(onClose);
  const reasonField = useReasonProps(tried && reason.trim() === '');
  return (
    <ChangeDialog
      busy={change.busy}
      description={t(`${ns}.withdrawDescription`, { plan: label })}
      onClose={onClose}
      onSubmit={() => {
        setTried(true);
        if (reason.trim() !== '') {
          change.run(send(reason.trim()));
        }
      }}
      submitLabel={t(`${ns}.withdraw`)}
      title={t(`${ns}.withdrawTitle`)}
    >
      <FormRoot
        className="flex flex-col gap-150"
        defaultValues={openedWithdraw}
        form={withdrawForm}
        translateMessage={t}
      >
        {ready}
        <OutcomeNotice outcome={change.outcome} />
        <withdrawForm.reason {...reasonField} />
      </FormRoot>
    </ChangeDialog>
  );
};

/** Declares the company a VAT payer or not from a day. */
export const RegimeDialog = ({
  onClose,
  send,
}: {
  readonly onClose: () => void;
  readonly send: (input: RegimeChangeInput) => Effect.Effect<VatChangeOutcome>;
}) => {
  const { t } = useModernI18n();
  const { draft, ready } = useFormDraft(regimeForm, openedRegime);
  const { from, reason } = draft;
  const regime = REGIMES.find((entry) => entry === draft.regime);
  const [tried, setTried] = useState(false);
  const change = useChange(onClose);
  const fromProps = useIssueDateProps({
    error: tried && from === '' ? t(`${ns}.fromRequired`) : undefined,
    label: t(`${ns}.from`),
  });
  // Tax asked once to confirm that a planned declaration is replaced; the next send confirms it.
  const confirmReplacesScheduled = change.outcome === 'confirmReplace';
  return (
    <ChangeDialog
      busy={change.busy}
      description={t(`${ns}.regimeDescription`)}
      onClose={onClose}
      onSubmit={() => {
        setTried(true);
        if (from !== '' && regime !== undefined) {
          change.run(send({ confirmReplacesScheduled, from, reason, regime }));
        }
      }}
      submitLabel={t(confirmReplacesScheduled ? `${ns}.regimeConfirm` : `${ns}.regimeSave`)}
      title={t(`${ns}.regimeTitle`)}
    >
      <FormRoot className="flex flex-col gap-150" defaultValues={openedRegime} form={regimeForm} translateMessage={t}>
        {ready}
        <OutcomeNotice outcome={change.outcome} />
        <regimeForm.regime
          items={REGIMES.map((value) => {
            const label = t(`${ns}.regime.${value}`);
            return { displayValue: label, label, value };
          })}
          label={t(`${ns}.regimeLabel`)}
          labelProps={formLabelProps}
          name="vat-regime"
        />
        <regimeForm.from {...fromProps} />
        <regimeForm.reason
          id="vat-change-reason"
          label={t(`${ns}.regimeReason`)}
          placeholder={t(`${ns}.reasonExample`)}
        />
      </FormRoot>
    </ChangeDialog>
  );
};
