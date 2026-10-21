import { Link as LocalizedLink, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Icon } from '@techsio/ui-kit/atoms/icon';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';

/** Safe, distinct recovery states. Never display a backend error body or a record identifier. */
export const ShellStatusPanel = ({
  messageKey,
  missingTitleKey = 'missing',
  status,
}: {
  /** Explanation under the title; defaults to the module wording for `status`. */
  readonly messageKey?: string;
  /** Title of the "not found" state; a record page says "Záznam nebyl nalezen" instead of "Stránka…". */
  readonly missingTitleKey?: 'missing' | 'recordMissing';
  readonly status: string;
}) => {
  const { t } = useModernI18n();
  const missing = status === 'not_found';
  const forbidden = status === 'forbidden';
  const titleKey = missing ? missingTitleKey : forbidden ? 'forbidden' : 'unavailable';
  return (
    <section
      aria-live="polite"
      className="ontos-card rounded-lg border border-border-primary/60 bg-base [&_.ontos-card]:border-0 [&_.ontos-card]:bg-transparent [&_.ontos-card]:p-0 flex w-full max-w-2xl flex-col items-start gap-200 p-300"
    >
      <span className="flex size-icon-control-lg items-center justify-center rounded-md bg-surface text-fg-secondary">
        <Icon
          icon={
            missing
              ? 'icon-[mdi--file-search-outline]'
              : forbidden
                ? 'icon-[mdi--lock-outline]'
                : 'icon-[mdi--cloud-alert-outline]'
          }
          size="md"
        />
      </span>
      <h1 className="font-semibold text-xl">{t(`shell.recovery.${titleKey}`)}</h1>
      <p className="text-fg-secondary text-sm">{t(messageKey ?? `shell.moduleTarget.${status}`)}</p>
      <div className="flex flex-wrap gap-150">
        <LinkButton as={LocalizedLink} icon="icon-[mdi--home-outline]" size="sm" theme="solid" to="/" variant="primary">
          {t('shell.recovery.home')}
        </LinkButton>
        {missing || forbidden ? null : (
          <Button
            icon="icon-[mdi--refresh]"
            onClick={() => window.location.reload()}
            size="sm"
            theme="outlined"
            type="button"
            variant="secondary"
          >
            {t('shell.recovery.retry')}
          </Button>
        )}
      </div>
    </section>
  );
};
