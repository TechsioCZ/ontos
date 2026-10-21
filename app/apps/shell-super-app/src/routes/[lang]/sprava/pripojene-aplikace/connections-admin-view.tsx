/* eslint-disable no-negated-condition, unicorn/no-negated-condition -- Closed route states read most clearly as error-versus-ready branches. expires: 2026-12-31. */
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';

import { SignInRedirect } from '../../../sign-in-redirect.tsx';
import { ShellContentLayout } from '../../../shell-content-layout.tsx';
import { useShellControls } from '../../../use-shell-controls.ts';
import type { ConnectionsAdminPageModel } from './connections-admin-page-model.ts';
import { ConnectionsAdminPanel } from './connections-admin-panel.tsx';

export const ConnectionsAdminView = ({ model }: { readonly model: ConnectionsAdminPageModel }) => {
  const { t } = useModernI18n();
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
      title="Připojené aplikace"
    >
      <ConnectionsAdminPanel />
    </ShellContentLayout>
  );
};
