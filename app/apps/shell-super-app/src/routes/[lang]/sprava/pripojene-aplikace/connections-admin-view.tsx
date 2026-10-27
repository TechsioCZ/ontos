import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { pageDataPending } from '@app/shared-contracts/page-data';
import { useSyncExternalStore } from 'react';

import { ConnectedAppsGuide } from '../../profile/connected-apps-guide.tsx';
import { DEFAULT_CONNECTIONS_FILTER, companyConnectionsData } from './connections-admin-data.ts';
import { SignInRedirect } from '../../../sign-in-redirect.tsx';
import { ShellContentLayout } from '../../../shell-content-layout.tsx';
import { useShellControls } from '../../../use-shell-controls.ts';
import type { ConnectionsAdminPageModel } from './connections-admin-page-model.ts';
import { ConnectionsAdminPanel } from './connections-admin-panel.tsx';

export const ConnectionsAdminView = ({ model }: { readonly model: ConnectionsAdminPageModel }) => {
  const { t } = useModernI18n();
  // Reuse the already-prepared admin list; no second request just to obtain the public MCP URL.
  const connections = useSyncExternalStore(
    companyConnectionsData.subscribe,
    () => companyConnectionsData.snapshot(DEFAULT_CONNECTIONS_FILTER),
    () => pageDataPending,
  );
  const controls = useShellControls(model.shell.state === 'authenticated' ? model.shell : undefined);
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
      currentEntrypointKey="shell-super-app.page.connected-apps"
      shell={model.shell}
      title={t('shell.profile.connections.title')}
    >
      <div className="grid min-w-0 gap-300">
        <ConnectionsAdminPanel />
        {connections.state === 'ready' ? <ConnectedAppsGuide mcpUrl={connections.value.mcpUrl} /> : null}
      </div>
    </ShellContentLayout>
  );
};
