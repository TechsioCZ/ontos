// Explicit save of one finance form: typing changes only the draft, the shared Save button sends it once, and
// leaving with unsaved input asks Uložit / Zahodit změny / Zůstat. An untouched form closes without asking.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import {
  SaveBar,
  UnsavedChangesDialog,
  dialogCloseLabel,
  saveLabelsFor,
  useDraftSave,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { DraftSave, SaveLabels, SaveOutcome, UnsavedChangesGuard } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { Effect, Equal } from 'effect';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
import { outcomeMessage } from './finance-ui.tsx';
import type { FinanceViewModel } from './finance-ui.tsx';
import { financeSaveOutcome } from './price-list-draft.ts';

/** What one save of a finance form answers: a write, or why nothing was written. */
export type FinanceSendOutcome =
  | { readonly ok: true }
  | { readonly feedback: string; readonly ok: false; readonly reason?: string };

export type FinanceSendFailure = Extract<FinanceSendOutcome, { readonly ok: false }>;

export interface FinanceFormSaveOptions<V, O extends FinanceSendOutcome> {
  readonly equals?: (left: V, right: V) => boolean;
  /**
   * The version the form opens with: what the draft is compared with, and what discarding it goes back to. Read when
   * the form opens (and by a create form's "Načíst aktuální verzi"), so it may be recomputed on every render.
   */
  readonly initial: V;
  /** The form's own validation; an invalid draft is never sent and keeps Uložit disabled. */
  readonly isValid: (value: V) => boolean;
  /** Leaves the form (closes its dialog or panel). Runs after a save went through and after Zahodit změny. */
  readonly onClose: () => void;
  /**
   * Nothing was written: for a follow-up such as a toast. A change parked for approval arrives here too, as
   * `pendingApproval`. Called with a failed outcome only.
   */
  readonly onFailed?: (outcome: FinanceSendFailure) => void;
  /** The save went through; for a follow-up such as opening the created record. Called with an `ok` outcome only. */
  readonly onSent?: (outcome: O) => void;
  /** Puts `value` back into the form's own state. */
  readonly reset: (value: V) => void;
  /** Sends one valid draft; undefined when the draft cannot be turned into a command. */
  readonly send: (value: V) => Effect.Effect<O> | undefined;
  /**
   * An edit form's record as the server has it now, in the draft's shape; undefined once it is gone. A save is sent
   * only while it still equals the version the draft was based on, so someone else's newer change is never
   * overwritten: the form shows a conflict with "Načíst aktuální verzi" instead.
   */
  readonly server?: (() => V | undefined) | undefined;
  readonly value: V;
  readonly vm: FinanceViewModel;
}

export interface FinanceFormSave {
  readonly close: () => void;
  readonly error: string | null;
  readonly guard: UnsavedChangesGuard;
  readonly handleSave: () => void;
  readonly labels: SaveLabels;
  readonly record: Pick<DraftSave<unknown>, 'dirty' | 'status'>;
  readonly reloadLatest: () => void;
}

export const useFinanceFormSave = <V, O extends FinanceSendOutcome>(
  options: FinanceFormSaveOptions<V, O>,
): FinanceFormSave => {
  const { language } = useModernI18n();
  const [error, setError] = useState<string | null>(null);
  const same = options.equals ?? Equal.equals;
  /** The server version the draft builds on: what it opened with, last saved or reloaded. */
  const base = useRef(options.initial);
  const settle = (value: V, outcome: O) => {
    if (outcome.ok) {
      base.current = value;
      setError(null);
      options.onSent?.(outcome);
      return;
    }
    const failure: FinanceSendOutcome = outcome;
    if (!failure.ok) {
      options.onFailed?.(failure);
    }
    // The save bar reports a conflict and a change waiting for approval itself.
    setError(
      outcome.feedback === 'conflict' || outcome.feedback === 'pendingApproval'
        ? null
        : outcomeMessage(options.vm, outcome),
    );
  };
  const record = useDraftSave<V, never>({
    equals: same,
    initial: options.initial,
    isValid: (value) => options.isValid(value),
    runtime: financeBrowserRuntime,
    save: (value) => {
      if (options.server !== undefined) {
        const current = options.server();
        if (current === undefined || !same(current, base.current)) {
          return Effect.succeed<SaveOutcome>('conflict');
        }
      }
      const sending = options.send(value);
      if (sending === undefined) {
        return Effect.succeed<SaveOutcome>('failed');
      }
      return sending.pipe(
        Effect.tap((outcome) => Effect.sync(() => settle(value, outcome))),
        Effect.map(financeSaveOutcome),
      );
    },
    value: options.value,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: record,
    navigation: blocker,
    onDiscard: () => options.reset(record.confirmed),
  });
  return {
    close: () => guard.request(options.onClose),
    error,
    guard,
    handleSave: () => {
      record.save();
      record.afterSave((status) => {
        if (status === 'saved') {
          options.onClose();
        }
      });
    },
    labels: saveLabelsFor(language),
    record,
    reloadLatest: () => {
      setError(null);
      // An edit form continues from the server's version; a create form keeps what was typed and may send it again.
      const latest = options.server?.();
      if (latest === undefined) {
        record.adopt(options.initial);
        return;
      }
      base.current = latest;
      options.reset(latest);
      record.adopt(latest);
    },
  };
};

/** Zrušit and the shared Save button, which is always the last control of the footer. */
export const FinanceSaveActions = ({
  form,
  size = 'md',
}: {
  readonly form: FinanceFormSave;
  readonly size?: 'md' | 'sm';
}) => {
  const { t } = useModernI18n();
  const handleClose = form.close;
  const handleReloadLatest = form.reloadLatest;
  return (
    <>
      <Button onClick={handleClose} size={size} theme="outlined" variant="secondary">
        {t('finance-billing.financeUi.common.cancel')}
      </Button>
      <SaveBar
        error={form.error}
        labels={form.labels}
        onReloadLatest={handleReloadLatest}
        onSave={form.handleSave}
        size={size}
        status={form.record.status}
      />
    </>
  );
};

/** A centred finance form dialog, mounted only while open: its close button, Escape and Zrušit leave through the guard. */
export const FinanceFormDialog = ({
  children,
  description,
  form,
  size = 'md',
  title,
}: {
  readonly children: ReactNode;
  readonly description?: string;
  readonly form: FinanceFormSave;
  readonly size?: 'md' | 'sm';
  readonly title: string;
}) => (
  <>
    <Dialog
      actions={<FinanceSaveActions form={form} />}
      closeLabel={dialogCloseLabel}
      customTrigger
      {...(description === undefined ? {} : { description })}
      onOpenChange={(details) => {
        if (!details.open) {
          form.close();
        }
      }}
      open
      placement="center"
      size={size}
      title={title}
    >
      {children}
    </Dialog>
    <UnsavedChangesDialog labels={form.labels} prompt={form.guard.prompt} />
  </>
);

/** Error props for a field, spread so `validateStatus` is absent (not undefined) when the field is valid. */
export const invalidField = (message: string | undefined) =>
  message === undefined ? {} : { helpText: message, validateStatus: 'error' as const };
