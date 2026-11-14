// The frames of the market detail dialogs: title, what happens, the fields, the failure, and the buttons.
import { SaveBar, UnsavedChangesDialog, dialogCloseLabel, saveLabelsFor } from '@app/admin-ui';
import type { SaveState, UnsavedChangesGuard } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { constVoid } from 'effect/Function';
import type { ReactNode } from 'react';
import { failureText, useMarketText } from './market-ui.tsx';
import type { WriteFailure } from './page-data.ts';

interface DialogFrameProps {
  readonly busy: boolean;
  readonly children?: ReactNode;
  readonly confirmLabel: string;
  /** Destructive confirmations are alert dialogs with a danger button. */
  readonly confirmVariant: 'danger' | 'primary';
  readonly description?: string;
  readonly failure: WriteFailure | null;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
  readonly title: string;
}

/** Rendered only while open; closing is refused while the write is in flight. */
export const DialogFrame = ({
  busy,
  children,
  confirmLabel,
  confirmVariant,
  description,
  failure,
  onClose,
  onConfirm,
  title,
}: DialogFrameProps) => {
  const { text } = useMarketText();
  return (
    <Dialog
      actions={
        <div className="flex w-full flex-wrap justify-end gap-100">
          <Button disabled={busy} onClick={onClose} theme="outlined" variant="secondary">
            {text('form.cancel')}
          </Button>
          <Button isLoading={busy} loadingText={text('form.saving')} onClick={onConfirm} variant={confirmVariant}>
            {confirmLabel}
          </Button>
        </div>
      }
      closeLabel={dialogCloseLabel}
      customTrigger
      {...(description === undefined ? {} : { description })}
      onOpenChange={({ open }) => {
        if (!open && !busy) {
          onClose();
        }
      }}
      open
      role={confirmVariant === 'danger' ? 'alertdialog' : 'dialog'}
      size={confirmVariant === 'danger' ? 'md' : 'lg'}
      title={title}
    >
      <div className="flex flex-col gap-200">
        {children}
        {failure !== null && (
          <StatusText showIcon status="error">
            {failureText(text, failure)}
          </StatusText>
        )}
      </div>
    </Dialog>
  );
};

interface FormDialogFrameProps {
  readonly children?: ReactNode;
  readonly description?: string;
  /** The failure the save reported, when it failed. */
  readonly error?: string | null;
  readonly guard: UnsavedChangesGuard;
  /** Closes the dialog; every way out goes through the guard first. */
  readonly onClose: () => void;
  /** The Save button: sends the dialog's draft once. */
  readonly onSave: () => void;
  readonly status: SaveState;
  readonly title: string;
}

/**
 * A form dialog of the market detail. Cancel and the close button go through the unsaved-changes guard; the one
 * SaveBar is the last control of the footer. Typing changes only the dialog's draft.
 */
export const FormDialogFrame = ({
  children,
  description,
  error,
  guard,
  onClose,
  onSave,
  status,
  title,
}: FormDialogFrameProps) => {
  const { language, text } = useMarketText();
  const labels = saveLabelsFor(language);
  const requestClose = () => {
    guard.request(onClose);
  };
  return (
    <>
      <Dialog
        actions={
          <div className="flex w-full flex-wrap items-center justify-end gap-150">
            <Button onClick={requestClose} theme="outlined" type="button" variant="secondary">
              {text('form.cancel')}
            </Button>
            {/* This dialog never reports a conflict; a refused save shows its failure text instead. */}
            <SaveBar error={error} labels={labels} onReloadLatest={constVoid} onSave={onSave} status={status} />
          </div>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        {...(description === undefined ? {} : { description })}
        onOpenChange={({ open }) => {
          if (!open && status !== 'saving') {
            requestClose();
          }
        }}
        open
        size="lg"
        title={title}
      >
        <div className="flex flex-col gap-200">{children}</div>
      </Dialog>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};
