import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { dialogCloseLabel } from '@app/admin-ui';

interface DiscardDialogProps {
  /** Translation prefix of the panel whose unsaved values are being dropped; it owns a `discard` block. */
  readonly copyKey: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}

/** Asks before a dirty form is dropped; Escape and the keep button both leave the typed values alone. */
export const DiscardDialog = ({ copyKey, onCancel, onConfirm, onOpenChange, open }: DiscardDialogProps) => {
  const { t } = useModernI18n();
  return (
    <Dialog
      actions={
        <>
          <Button onClick={onCancel} theme="outlined" type="button" variant="secondary">
            {t(`${copyKey}.discard.keep`)}
          </Button>
          <Button onClick={onConfirm} type="button" variant="danger">
            {t(`${copyKey}.discard.confirm`)}
          </Button>
        </>
      }
      closeLabel={dialogCloseLabel}
      customTrigger
      description={t(`${copyKey}.discard.description`)}
      hideCloseButton
      onOpenChange={(details) => onOpenChange(details.open)}
      open={open}
      role="alertdialog"
      size="sm"
      title={t(`${copyKey}.discard.title`)}
    />
  );
};
