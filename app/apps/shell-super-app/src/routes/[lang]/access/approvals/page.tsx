import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData } from '@modern-js/plugin-tanstack/runtime';

import { approvalsClient, createApprovalKey } from '../../../access-admin/approvals/approvals-client.ts';
import { ApprovalsFeature } from '../../../access-admin/approvals/approvals-feature.tsx';
import { ShellContentLayout } from '../../../shell-content-layout.tsx';
import { useShellControls } from '../../../use-shell-controls.ts';
import type { ApprovalsContentModel } from './approvals-page-model.ts';

const ApprovalsPage = () => {
  const { t } = useModernI18n();
  const model = useLoaderData({ from: '/$lang/access/approvals' });
  const controls = useShellControls(model.shell.state === 'authenticated' ? model.shell : undefined);
  const content: ApprovalsContentModel = controls.reloadRequired ? { state: 'reload_required' } : model.content;
  const feature = (
    <ApprovalsFeature
      client={approvalsClient}
      createKey={createApprovalKey}
      initial={content}
      key={content.state === 'ready' ? content.revision : content.state}
    />
  );
  if (model.shell.state === 'authenticated') {
    return (
      <ShellContentLayout
        controls={controls}
        currentAccessPage="approvals"
        shell={model.shell}
        title={t('shell.accessAdmin.approvals.title')}
      >
        {feature}
      </ShellContentLayout>
    );
  }
  return <main className="mx-auto grid w-full max-w-5xl gap-300 px-200 py-400">{feature}</main>;
};

export default ApprovalsPage;
