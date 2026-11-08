import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';

interface ModuleRenderFailureProps {
  readonly onReload: () => void;
}

export const ModuleRenderFailure = ({ onReload }: ModuleRenderFailureProps) => {
  const { t } = useModernI18n();
  return (
    <div className="shell:grid shell:justify-items-start shell:gap-4">
      <StatusText aria-live="polite" role="alert" showIcon status="error">
        {t('shell.moduleTarget.render_failed')}
      </StatusText>
      <Button onClick={onReload} size="md" theme="outlined" type="button" variant="secondary">
        {t('shell.moduleTarget.reload_page')}
      </Button>
    </div>
  );
};
