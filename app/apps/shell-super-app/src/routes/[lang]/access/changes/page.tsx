import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData } from '@modern-js/plugin-tanstack/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';

import { liveChangesClient } from '../../../access-admin/changes/changes-bff-adapter.ts';
import { ChangesFeature } from '../../../access-admin/changes/changes-feature.tsx';
import { ShellContentLayout } from '../../../shell-content-layout.tsx';
import { useShellControls } from '../../../use-shell-controls.ts';

const ChangesPage = () => {
  const { t } = useModernI18n();
  const model = useLoaderData({ from: '/$lang/access/changes' });
  const controls = useShellControls(model.shell.state === 'authenticated' ? model.shell : undefined);
  if (model.shell.state !== 'authenticated' || controls.reloadRequired) {
    const key =
      model.shell.state === 'reload_required' || controls.reloadRequired
        ? 'shell.moduleTarget.reload_required'
        : `shell.accessAdmin.common.${model.notice ?? 'unavailable'}`;
    return (
      <main className="mx-auto grid w-full max-w-5xl gap-300 px-200 py-400">
        <StatusText aria-live="polite" status="error">
          {t(key)}
        </StatusText>
      </main>
    );
  }
  return (
    <ShellContentLayout
      controls={controls}
      currentAccessPage="changes"
      shell={model.shell}
      title={t('shell.accessAdmin.changes.title')}
    >
      <ChangesFeature
        client={liveChangesClient}
        initial={model.list}
        initialNotice={model.notice}
        key={model.shell.identity.tenantId}
      />
    </ShellContentLayout>
  );
};

export default ChangesPage;
