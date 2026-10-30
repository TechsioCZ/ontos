import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';

import { SignInRedirect } from '../sign-in-redirect.tsx';
import { ShellContentLayout } from '../shell-content-layout.tsx';
import { useShellControls } from '../use-shell-controls.ts';
import type { AgentPlatformPageModel } from './agent-platform-page-model.ts';
import { ActivityPanel } from './activity-panel.tsx';
import { ApprovalsPanel } from './approvals-panel.tsx';
import './agent-platform.css';

export const AgentPlatformView = ({ model }: { readonly model: AgentPlatformPageModel }) => {
  const { t } = useModernI18n();
  const controls = useShellControls(model.shell.state === 'authenticated' ? model.shell : undefined);
  const page = model.agentPlatformPage;
  if (model.shell.state === 'reload_required' || controls.reloadRequired) {
    return (
      <main className="shell:mx-auto shell:grid shell:w-full shell:max-w-5xl shell:gap-6 shell:px-4 shell:py-8">
        <StatusText aria-live="polite" showIcon status="error">
          {t('shell.moduleTarget.reload_required')}
        </StatusText>
      </main>
    );
  }
  if (model.shell.state === 'anonymous') {
    return <SignInRedirect reason={model.shell.reason} />;
  }
  if (model.shell.state !== 'authenticated') {
    return (
      <main className="shell:mx-auto shell:grid shell:w-full shell:max-w-5xl shell:gap-6 shell:px-4 shell:py-8">
        <StatusText aria-live="polite" showIcon status="error">
          Stránka je teď nedostupná. Zkuste ji prosím načíst znovu.
        </StatusText>
      </main>
    );
  }
  return (
    <ShellContentLayout
      controls={controls}
      currentEntrypointKey={
        page === 'approvals' ? 'shell-super-app.page.agent-approvals' : 'shell-super-app.page.agent-activity'
      }
      shell={model.shell}
      title={page === 'approvals' ? 'Ke schválení' : 'Aktivita agentů'}
    >
      {page === 'approvals' ? <ApprovalsPanel /> : <ActivityPanel />}
    </ShellContentLayout>
  );
};
