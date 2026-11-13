import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useLoaderData } from '@modern-js/plugin-tanstack/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useState } from 'react';

import { AgentEntitiesSection } from '../../../people/agent-entities-section.tsx';
import { ShellContentLayout } from '../../../shell-content-layout.tsx';
import { useShellControls } from '../../../use-shell-controls.ts';
import type { HomePageModel } from '../../home-page-model.ts';

/** Správa oprávnění › Agenti: the company's agents, their roles, operators and connections. */
const AgentsPage = () => {
  const { t } = useModernI18n();
  const shell: HomePageModel = useLoaderData({ from: '/$lang/access/agents' });
  const controls = useShellControls(shell.state === 'authenticated' ? shell : undefined);
  const [notification, setNotification] = useState('');
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
    const companyId = shell.selectedLegalEntityId;
    return (
      <ShellContentLayout controls={controls} shell={shell} title={t('shell.accessAdmin.agents.title')}>
        {notification === '' ? null : (
          <StatusText aria-live="polite" status="default">
            {notification}
          </StatusText>
        )}
        {companyId === undefined ? (
          <StatusText status="warning">{t('shell.accessAdmin.agents.companyRequired')}</StatusText>
        ) : (
          <AgentEntitiesSection
            legalEntityId={companyId}
            onNotify={(title, description) => setNotification([title, description].filter(Boolean).join(' '))}
          />
        )}
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
