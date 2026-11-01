// The confirmation frame of every market detail dialog: title, what happens, the fields, the failure, two buttons.
import { dialogCloseLabel } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
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
