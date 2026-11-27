// The question asked before a one-click command changes what the public e-shop shows or sells: it names what will
// change, and only its confirm button runs the command. Escape, a click outside and Zrušit leave everything as it is.
import { dialogCloseLabel } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { useProductLabel } from './product-form-labels.ts';

export interface LiveShopConfirmProps {
  readonly confirmLabel: string;
  readonly description: string;
  /** Taking something off the e-shop is destructive; putting it on is not. */
  readonly destructive: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly open: boolean;
  readonly title: string;
}

export const LiveShopConfirm = ({
  confirmLabel,
  description,
  destructive,
  onCancel,
  onConfirm,
  open,
  title,
}: LiveShopConfirmProps) => {
  const k = useProductLabel();
  return (
    <Dialog
      actions={
        <div className="flex w-full flex-wrap justify-end gap-100 sm:flex-nowrap">
          <Button className="whitespace-nowrap" onClick={onCancel} theme="outlined" type="button" variant="secondary">
            {k('common.cancel')}
          </Button>
          <Button
            className="whitespace-nowrap"
            data-testid="live-shop-confirm"
            onClick={onConfirm}
            type="button"
            variant={destructive ? 'danger' : 'primary'}
          >
            {confirmLabel}
          </Button>
        </div>
      }
      closeLabel={dialogCloseLabel}
      customTrigger
      description={description}
      onOpenChange={({ open: next }) => {
        if (!next) {
          onCancel();
        }
      }}
      open={open}
      role="alertdialog"
      size="md"
      title={title}
    />
  );
};
