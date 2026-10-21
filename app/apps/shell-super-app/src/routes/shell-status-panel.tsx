import { Link as LocalizedLink, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Icon } from '@techsio/ui-kit/atoms/icon';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';

/**
 * Page title of a recovery state, shown once as the page heading by the shell frame. A record page says "Záznam nebyl
 * nalezen" instead of "Stránka nebyla nalezena".
 */
export const shellStatusTitleKey = (status: string, missingTitleKey: 'missing' | 'recordMissing' = 'missing') =>
  `shell.recovery.${status === 'not_found' ? missingTitleKey : status === 'forbidden' ? 'forbidden' : 'unavailable'}`;

/**
 * Safe, distinct recovery states under the page heading (see `shellStatusTitleKey`). Never display a backend error body
 * or a record identifier.
 */
export const ShellStatusPanel = ({
  messageKey,
  status,
}: {
  /** Explanation of the state; defaults to the module wording for `status`. */
  readonly messageKey?: string;
  readonly status: string;
}) => {
  const { t } = useModernI18n();
  const missing = status === 'not_found';
  const forbidden = status === 'forbidden';
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
      <p className="text-sm">{t(messageKey ?? `shell.moduleTarget.${status}`)}</p>
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
