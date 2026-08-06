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

export interface AuthenticatedDashboardLayoutProps {
  readonly activeModules: readonly DashboardNavigationItem[];
  readonly children: ReactNode;
  readonly currentModuleKey?: string;
  readonly identity: DashboardAccount;
  readonly logoutPending: boolean;
  readonly onLogout: () => void;
  readonly title: string;
}

export const AuthenticatedDashboardLayout = ({
  activeModules,
  children,
  currentModuleKey,
  identity,
  logoutPending,
  onLogout,
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

  return (
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden bg-(--color-page-bg) text-(--color-page-fg) md:flex-row">
      <aside
        aria-label={t('shell.dashboard.sidebar.label')}
        className="flex w-full shrink-0 flex-col gap-6 bg-(--color-surface) p-4 md:w-64"
      >
        <p>{t('shell.dashboard.brand')}</p>
        <Select disabled items={[]} name="tenant" value={[]}>
          <Select.Label>{t('shell.dashboard.tenant.label')}</Select.Label>
          <Select.Control>
            <Select.Trigger aria-label={t('shell.dashboard.tenant.label')}>
              <Select.ValueText placeholder={t('shell.dashboard.tenant.empty')} />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content />
          </Select.Positioner>
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
