// The VAT settings dialogs: each one sends one change to Tax, as the signed-in person, and explains Tax's answer.
import { dialogCloseLabel } from '@app/admin-ui';
import { FormInput } from '@app/admin-ui/form-controls';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { Effect } from 'effect';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { financeBrowserRuntime } from '../../../../runtime/browser.ts';
import { IssueDateField } from '../create-invoice-fields.tsx';
import { formLabelProps } from '../invoice-view.ts';
import type { RateChangeInput, RegimeChangeInput } from './vat-settings-data.ts';
import { parseRatePercent } from './vat-settings-model.ts';
import type { VatChangeOutcome } from './vat-settings-model.ts';

const ns = 'finance-billing.vatSettings';

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
          <Button onClick={onClose} theme="outlined" variant="secondary">
            {t(`${ns}.cancel`)}
          </Button>
          <Button disabled={busy} onClick={onSubmit} variant="primary">
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
      <form className="flex flex-col gap-150" onSubmit={(event) => event.preventDefault()}>
        {children}
      </form>
    </Dialog>
  );
};

const ReasonField = ({
  invalid,
  onChange,
  value,
}: {
  readonly invalid: boolean;
  readonly onChange: (next: string) => void;
  readonly value: string;
}) => {
  const { t } = useModernI18n();
  return (
    <FormInput
      id="vat-change-reason"
      label={t(`${ns}.reason`)}
      onChange={(event) => onChange(event.target.value)}
      placeholder={t(`${ns}.reasonExample`)}
      value={value}
      {...(invalid ? { helpText: t(`${ns}.reasonRequired`), validateStatus: 'error' as const } : {})}
    />
  );
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
  const [rate, setRate] = useState('');
  const [from, setFrom] = useState('');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const change = useChange(onClose);
  const ratePercent = parseRatePercent(rate);
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
      <OutcomeNotice outcome={change.outcome} />
      <FormInput
        id="vat-rate-percent"
        inputMode="numeric"
        label={t(`${ns}.ratePercent`)}
        onChange={(event) => setRate(event.target.value)}
        value={rate}
        {...(tried && ratePercent === undefined
          ? { helpText: t(`${ns}.rateInvalid`), validateStatus: 'error' as const }
          : {})}
      />
      <IssueDateField
        error={tried && from === '' ? t(`${ns}.fromRequired`) : undefined}
        label={t(`${ns}.from`)}
        onChange={setFrom}
        value={from}
      />
      <ReasonField invalid={tried && reason.trim() === ''} onChange={setReason} value={reason} />
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
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const change = useChange(onClose);
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
      <OutcomeNotice outcome={change.outcome} />
      <ReasonField invalid={tried && reason.trim() === ''} onChange={setReason} value={reason} />
    </ChangeDialog>
  );
};

const REGIMES = ['VAT_PAYER', 'NON_PAYER'] as const;

/** Declares the company a VAT payer or not from a day. */
export const RegimeDialog = ({
  onClose,
  send,
}: {
  readonly onClose: () => void;
  readonly send: (input: RegimeChangeInput) => Effect.Effect<VatChangeOutcome>;
}) => {
  const { t } = useModernI18n();
  const [regime, setRegime] = useState<RegimeChangeInput['regime']>('VAT_PAYER');
  const [from, setFrom] = useState('');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const change = useChange(onClose);
  // Tax asked once to confirm that a planned declaration is replaced; the next send confirms it.
  const confirmReplacesScheduled = change.outcome === 'confirmReplace';
  return (
    <ChangeDialog
      busy={change.busy}
      description={t(`${ns}.regimeDescription`)}
      onClose={onClose}
      onSubmit={() => {
        setTried(true);
        if (from !== '') {
          change.run(send({ confirmReplacesScheduled, from, reason, regime }));
        }
      }}
      submitLabel={t(confirmReplacesScheduled ? `${ns}.regimeConfirm` : `${ns}.regimeSave`)}
      title={t(`${ns}.regimeTitle`)}
    >
      <OutcomeNotice outcome={change.outcome} />
      <SelectTemplate
        items={REGIMES.map((value) => {
          const label = t(`${ns}.regime.${value}`);
          return { displayValue: label, label, value };
        })}
        label={t(`${ns}.regimeLabel`)}
        labelProps={formLabelProps}
        name="vat-regime"
        onValueChange={({ value }) => {
          const next = REGIMES.find((entry) => entry === value[0]);
          if (next !== undefined) {
            setRegime(next);
          }
        }}
        value={[regime]}
      />
      <IssueDateField
        error={tried && from === '' ? t(`${ns}.fromRequired`) : undefined}
        label={t(`${ns}.from`)}
        onChange={setFrom}
        value={from}
      />
      <FormInput
        id="vat-change-reason"
        label={t(`${ns}.regimeReason`)}
        onChange={(event) => setReason(event.target.value)}
        placeholder={t(`${ns}.reasonExample`)}
        value={reason}
      />
    </ChangeDialog>
  );
};
