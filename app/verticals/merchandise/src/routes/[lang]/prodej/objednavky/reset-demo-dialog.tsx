import { dialogCloseLabel } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Effect } from 'effect';
import { useState } from 'react';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { isRevisionConflict, resetDemoData } from './orders-records.ts';

const CONFIRMATION = 'OBNOVIT';
const DEFAULT_REASON = 'Obnovení ukázky před další prezentací';

interface ResetDemoDialogProps {
  readonly onDismiss: () => void;
  readonly onReset: (message: string) => void;
  readonly open: boolean;
  readonly revision: number;
}

/**
 * AKROS administrators only. Replaces the company's catalog, categories, stock and orders with the predictable demo
 * baseline (six sample orders). The server scopes the write to the signed-in company; nothing else changes.
 */
export const ResetDemoDialog = ({ onDismiss, onReset, open, revision }: ResetDemoDialogProps) => {
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState(DEFAULT_REASON);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = typed.trim().toUpperCase() === CONFIRMATION;
  const reasonValid = reason.trim().length >= 5;
  const close = () => {
    setTyped('');
    setReason(DEFAULT_REASON);
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
              isRevisionConflict(failure)
                ? 'Data se mezitím změnila (např. nová objednávka z e-shopu). Zavřete okno, načtěte stránku a zkuste to znovu.'
                : 'Obnovení se nepodařilo, nic se nezměnilo. Zkuste to prosím znovu.',
            );
          },
          onSuccess: () => {
            setBusy(false);
            setTyped('');
            setReason(DEFAULT_REASON);
            onReset('Ukázková data AKROS jsou obnovená do výchozího stavu.');
          },
        }),
      ),
    );
  };
  return (
    <Dialog
      actions={
        <div className="flex w-full flex-wrap justify-end gap-100">
          <Button className="shrink-0 whitespace-nowrap" onClick={close} theme="outlined" variant="secondary">
            Zpět
          </Button>
          <Button
            className="shrink-0 whitespace-nowrap"
            disabled={!confirmed || !reasonValid}
            isLoading={busy}
            loadingText="Obnovuji…"
            onClick={submit}
            variant="danger"
          >
            Obnovit výchozí data
          </Button>
        </div>
      }
      closeLabel={dialogCloseLabel}
      customTrigger
      description="Katalog, kategorie, skladové zásoby a objednávky AKROS se vrátí do výchozího stavu ukázky se šesti vzorovými objednávkami. Pozdější úpravy produktů, pohyby skladu a testovací objednávky se odstraní. Ostatní firmy ani odeslané e-maily se nezmění. Akci nelze vrátit."
      onOpenChange={({ open: next }) => {
        if (!next && !busy) {
          close();
        }
      }}
      open={open}
      role="alertdialog"
      size="sm"
      title="Obnovit ukázková data AKROS?"
    >
      <div className="flex flex-col gap-200">
        <FormInput
          id="reset-demo-reason"
          label="Důvod (zapíše se do auditu)"
          maxLength={500}
          name="reason"
          onChange={(event) => setReason(event.target.value)}
          value={reason}
          {...(reasonValid ? {} : { helpText: 'Napište alespoň 5 znaků.', validateStatus: 'error' as const })}
        />
        <FormInput
          autoComplete="off"
          id="reset-demo-confirmation"
          label={`Pro potvrzení napište ${CONFIRMATION}`}
          name="confirmation"
          onChange={(event) => setTyped(event.target.value)}
          value={typed}
        />
        {error !== null && <StatusText status="error">{error}</StatusText>}
      </div>
    </Dialog>
  );
};
