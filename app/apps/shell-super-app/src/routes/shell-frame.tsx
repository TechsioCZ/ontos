import { Link as LocalizedLink, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Menu } from '@techsio/ui-kit/molecules/menu';
import type { MenuItem } from '@techsio/ui-kit/molecules/menu';
import { Select } from '@techsio/ui-kit/molecules/select';
import { Header } from '@techsio/ui-kit/organisms/header';
import type { ReactNode } from 'react';

interface DashboardAccount {
  readonly displayName: string;
}

interface DashboardNavigationItem {
  readonly moduleKey: string;
}

interface DashboardTenantItem {
  readonly name: string;
  readonly tenantId: string;
}

export interface AuthenticatedDashboardLayoutProps {
  readonly activeModules: readonly DashboardNavigationItem[];
  readonly children: ReactNode;
  readonly currentModuleKey?: string;
  readonly currentTenantId: string;
  readonly identity: DashboardAccount;
  readonly logoutPending: boolean;
  readonly onLogout: () => void;
  readonly onTenantChange: (tenantId: string) => void;
  readonly tenantChoices: readonly DashboardTenantItem[];
  readonly tenantState: 'available' | 'unavailable';
  readonly tenantSwitchFailed: boolean;
  readonly tenantSwitchPending: boolean;
  readonly title: string;
}

export const AuthenticatedDashboardLayout = ({
  activeModules,
  children,
  currentModuleKey,
  currentTenantId,
  identity,
  logoutPending,
  onLogout,
  onTenantChange,
  tenantChoices,
  tenantState,
  tenantSwitchFailed,
  tenantSwitchPending,
  title,
}: AuthenticatedDashboardLayoutProps) => {
  const { t } = useModernI18n();
  const accountItems: MenuItem[] = [
    {
      disabled: logoutPending,
      label: t(logoutPending ? 'shell.auth.logout.pending' : 'shell.auth.logout.action'),
      type: 'action',
      value: 'logout',
    },
  ];
  const tenantItems = tenantChoices.map(({ name, tenantId }) => ({
    displayValue: name,
    label: name,
    value: tenantId,
  }));
  let tenantStatus: 'default' | 'error' | 'warning' = 'default';
  if (tenantSwitchFailed) {
    tenantStatus = 'error';
  } else if (tenantState === 'unavailable') {
    tenantStatus = 'warning';
  }
  let tenantStatusText: string | null = null;
  if (tenantSwitchPending) {
    tenantStatusText = t('shell.dashboard.tenant.pending');
  } else if (tenantSwitchFailed) {
    tenantStatusText = t('shell.dashboard.tenant.failed');
  } else if (tenantState === 'unavailable') {
    tenantStatusText = t('shell.dashboard.tenant.unavailable');
  }
  const tenantSelectDisabled =
    tenantState === 'unavailable' ||
    tenantSwitchPending ||
    !tenantItems.some((item) => item.value !== currentTenantId);

  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden bg-(--color-page-bg) text-(--color-page-fg) md:flex-row">
      <aside
        aria-label={t('shell.dashboard.sidebar.label')}
        className="flex w-full shrink-0 flex-col gap-6 bg-(--color-surface) p-4 md:w-64"
      >
        <p>{t('shell.dashboard.brand')}</p>
        <Select
          disabled={tenantSelectDisabled}
          items={tenantItems}
          name="tenant"
          onValueChange={({ value }) => {
            const [tenantId] = value;
            if (value.length === 1 && tenantId !== undefined && tenantId !== currentTenantId) {
              onTenantChange(tenantId);
            }
          }}
          validateStatus={tenantStatus}
          value={[currentTenantId]}
        >
          <Select.Label>{t('shell.dashboard.tenant.accessibleLabel')}</Select.Label>
          <Select.Control>
            <Select.Trigger
              aria-describedby={tenantStatusText === null ? undefined : 'tenant-switch-status'}
              aria-label={t('shell.dashboard.tenant.accessibleLabel')}
            >
              <Select.ValueText placeholder={t('shell.dashboard.tenant.unavailable')} />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {tenantItems.map((item) => (
                <Select.Item item={item} key={item.value}>
                  <Select.ItemText />
                  <Select.ItemIndicator />
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
          {tenantStatusText === null ? null : (
            <Select.StatusText
              aria-live="polite"
              id="tenant-switch-status"
              showIcon
              status={tenantStatus}
            >
              {tenantStatusText}
            </Select.StatusText>
          )}
        </Select>
        <nav aria-label={t('shell.dashboard.navigation.label')}>
          <ul className="flex flex-col gap-2">
            <li>
              <Link
                aria-current={currentModuleKey === undefined ? 'page' : undefined}
                as={LocalizedLink}
                to="/"
              >
                {t('shell.dashboard.navigation.home')}
              </Link>
            </li>
            {activeModules.map((module) => (
              <li key={module.moduleKey}>
                <Link
                  aria-current={currentModuleKey === module.moduleKey ? 'page' : undefined}
                  as={LocalizedLink}
                  to={`/${module.moduleKey}`}
                >
                  {module.moduleKey}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <Header aria-label={t('shell.dashboard.header.label')}>
          <Header.Container position="start">
            <h1>{title}</h1>
          </Header.Container>
          <Header.Actions>
            <Header.ActionItem>
              <Menu
                aria-label={t('shell.dashboard.account.label')}
                items={accountItems}
                onSelect={({ value }) => {
                  if (value === 'logout') {
                    onLogout();
                  }
                }}
                triggerText={identity.displayName}
              />
            </Header.ActionItem>
          </Header.Actions>
        </Header>
        <div className="min-w-0 flex-1 p-4">{children}</div>
      </main>
    </div>
  );
};
