import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';

export interface UrlPropertyActionsProps {
  readonly value: string | null;
}

export const UrlPropertyActions = ({ value }: UrlPropertyActionsProps) => {
  const { t } = useModernI18n();

  if (value === null) {
    return null;
  }

  return (
    <>
      <LinkButton
        href={value}
        rel="noopener noreferrer"
        size="sm"
        target="_blank"
        theme="outlined"
        variant="secondary"
      >
        {t('ticketing.url.open')}
      </LinkButton>
      <Button
        onClick={() => navigator.clipboard.writeText(value)}
        size="sm"
        theme="borderless"
        type="button"
        variant="tertiary"
      >
        {t('ticketing.url.copy')}
      </Button>
    </>
  );
};
