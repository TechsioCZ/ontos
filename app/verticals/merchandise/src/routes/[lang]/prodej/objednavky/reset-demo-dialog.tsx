import { pendingProposalMessage } from '../../../../api/action-result.ts';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { dialogCloseLabel } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormBuilder, FormReact, FormRoot, TextField, useAtomSet, useAtomValue } from '@app/core-runtime/ui/form';
import { Effect, Option, Schema } from 'effect';
import { useState } from 'react';
import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { isRevisionConflict, resetDemoData } from './orders-records.ts';

const CONFIRMATION = 'OBNOVIT';
const DEFAULT_REASON = 'Obnovení ukázky před další prezentací';

/** The audit reason and the typed confirmation. The dialog's button sends them; the form itself is never submitted. */
const resetDemoForm = FormReact.make(
  FormBuilder.empty.addField('confirmation', Schema.String).addField('reason', Schema.String),
  {
    fields: { confirmation: TextField, reason: TextField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);
const opening = { confirmation: '', reason: DEFAULT_REASON };

interface ResetDemoDialogProps {
  readonly onDismiss: () => void;
  readonly onReset: (message: string) => void;
  readonly open: boolean;
  readonly revision: number;
}

const ResetDemoContent = ({ onDismiss, onReset, open, revision }: ResetDemoDialogProps) => {
  const { t } = useModernI18n();
  const { confirmation: typed, reason } = Option.getOrElse(useAtomValue(resetDemoForm.values), () => opening);
  const setValues = useAtomSet(resetDemoForm.setValues);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = typed.trim().toUpperCase() === CONFIRMATION;
  const reasonValid = reason.trim().length >= 5;
  const close = () => {
    setValues(opening);
    setError(null);
    onDismiss();
  };
  const submit = () => {
    if (!confirmed || !reasonValid || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    void browserRuntime.runPromise(
      resetDemoData(reason.trim(), revision).pipe(
        Effect.match({
          onFailure: (failure) => {
            setBusy(false);
            setError(
              pendingProposalMessage(failure) ??
                (isRevisionConflict(failure)
                  ? 'Data se mezitím změnila (např. nová objednávka z e-shopu). Zavřete okno, načtěte stránku a zkuste to znovu.'
                  : 'Obnovení se nepodařilo, nic se nezměnilo. Zkuste to prosím znovu.'),
            );
          },
          onSuccess: () => {
            setBusy(false);
            setValues(opening);
            onReset('Ukázková data e-shopu jsou obnovená do výchozího stavu.');
          },
        }),
      ),
    );
  };
  return (
    <Dialog
      actions={
        <div className="flex w-full flex-wrap justify-end gap-100">
          <Button appearance="outline" className="shrink-0 whitespace-nowrap" onClick={close} severity="secondary">
            Zpět
          </Button>
          <Button
            className="shrink-0 whitespace-nowrap"
            disabled={!confirmed || !reasonValid}
            isLoading={busy}
            loadingText="Obnovuji…"
            onClick={submit}
            severity="danger"
          >
            Obnovit výchozí data
          </Button>
        </div>
      }
      closeLabel={dialogCloseLabel}
      customTrigger
      description="Katalog, kategorie, skladové zásoby a objednávky e-shopu se vrátí do výchozího stavu ukázky se šesti vzorovými objednávkami. Pozdější úpravy produktů, pohyby skladu a testovací objednávky se odstraní. Ostatní firmy ani odeslané e-maily se nezmění. Akci nelze vrátit."
      onOpenChange={({ open: next }) => {
        if (!next && !busy) {
          close();
        }
      }}
      open={open}
      role="alertdialog"
      size="sm"
      title={t('merchandise.ui.resetAkrosDemo')}
    >
      <div className="flex flex-col gap-200">
        <resetDemoForm.reason
          id="reset-demo-reason"
          label={t('merchandise.ui.auditReason')}
          maxLength={500}
          name="reason"
          {...(reasonValid ? {} : { helpText: 'Napište alespoň 5 znaků.', invalid: true })}
        />
        <resetDemoForm.confirmation
          autoComplete="off"
          id="reset-demo-confirmation"
          label={`Pro potvrzení napište ${CONFIRMATION}`}
          name="confirmation"
        />
        {error !== null && <StatusText status="error">{error}</StatusText>}
      </div>
    </Dialog>
  );
};

/**
 * Administrators of the e-shop demo company only. Replaces the company's catalog, categories, stock and orders with the predictable demo
 * baseline (six sample orders). The server scopes the write to the signed-in company; nothing else changes.
 */
export const ResetDemoDialog = (props: ResetDemoDialogProps) => {
  const { t } = useModernI18n();
  return (
    <FormRoot className="contents" defaultValues={opening} form={resetDemoForm} translateMessage={t}>
      <ResetDemoContent {...props} />
    </FormRoot>
  );
};
