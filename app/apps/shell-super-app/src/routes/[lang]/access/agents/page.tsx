import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData } from '@modern-js/plugin-tanstack/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';

import { AgentsUnavailable } from '../../../access-admin/why/why-view.tsx';
import { ShellContentLayout } from '../../../shell-content-layout.tsx';
import { useShellControls } from '../../../use-shell-controls.ts';
import type { HomePageModel } from '../../home-page-model.ts';

const AgentsPage = () => {
  const { t } = useModernI18n();
  const shell: HomePageModel = useLoaderData({ from: '/$lang/access/agents' });
  const controls = useShellControls(shell.state === 'authenticated' ? shell : undefined);
  if (shell.state === 'reload_required' || controls.reloadRequired) {
    return (
      <main className="shell:p-6">
        <StatusText showIcon status="error">
          {t('shell.moduleTarget.reload_required')}
        </StatusText>
      </main>
    );
  }
  if (shell.state === 'authenticated') {
    return (
      <ShellContentLayout controls={controls} shell={shell} title={t('shell.accessAdmin.agents.title')}>
        <AgentsUnavailable />
      </ShellContentLayout>
    );
  }
  return (
    <main className="shell:p-6">
      <StatusText showIcon status="error">
        {t(shell.state === 'anonymous' ? 'shell.accessAdmin.common.unauthenticated' : 'shell.dashboard.unavailable')}
      </StatusText>
    </main>
  );
};

export default AgentsPage;
