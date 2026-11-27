import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';

interface ModuleRenderFailureProps {
  readonly onReload: () => void;
}

export const ModuleRenderFailure = ({ onReload }: ModuleRenderFailureProps) => {
  const { t } = useModernI18n();
  return (
    <div className="grid justify-items-start gap-200">
      <StatusText aria-live="polite" showIcon status="error">
        {t('shell.moduleTarget.render_failed')}
      </StatusText>
      <Button appearance="outline" onClick={onReload} severity="secondary" size="md" type="button">
        {t('shell.moduleTarget.reload_page')}
      </Button>
    </div>
  );
};
