import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import type { ComponentProps } from 'react';

import { AuthenticatedDashboardLayout } from './shell-frame.tsx';
import type { useShellControls } from './use-shell-controls.ts';

type Controls = ReturnType<typeof useShellControls>;
type Shell = NonNullable<Parameters<typeof useShellControls>[0]>;
type PageProps = Pick<
  ComponentProps<typeof AuthenticatedDashboardLayout>,
  'children' | 'currentModuleId' | 'title'
>;

export const ShellContentLayout = ({
  children,
  controls,
  shell,
  ...pageProps
}: PageProps & {
  readonly controls: Controls;
  readonly shell: Shell;
}) => {
  const { t } = useModernI18n();
  return (
    <AuthenticatedDashboardLayout
      {...(shell.selectedLegalEntityId === undefined
        ? {}
        : { currentLegalEntityId: shell.selectedLegalEntityId })}
      {...pageProps}
      currentTenantId={shell.identity.tenantId}
      homeCurrent={false}
      identity={{ displayName: shell.identity.displayName }}
      legalEntityChoices={shell.legalEntities.items}
      legalEntityState={shell.legalEntities.state}
      legalEntitySwitchFailed={controls.legalEntitySwitchFailed}
      legalEntitySwitchPending={controls.legalEntitySwitchPending}
      logoutPending={controls.logoutPending}
      navigation={shell.navigation.items}
      onLegalEntityChange={controls.handleLegalEntityChange}
      onLogout={controls.handleLogout}
      onSearch={controls.handleSearch}
      onTenantChange={controls.handleTenantChange}
      tenantChoices={shell.tenants.items}
      tenantState={shell.tenants.state}
      tenantSwitchFailed={controls.tenantSwitchFailed}
      tenantSwitchPending={controls.tenantSwitchPending}
      unavailableDeployments={shell.navigation.unavailableDeployments}
    >
      {controls.logoutFailed ? (
        <StatusText aria-live="polite" showIcon status="error">
          {t('shell.auth.logout.failed')}
        </StatusText>
      ) : null}
      {children}
    </AuthenticatedDashboardLayout>
  );
};
