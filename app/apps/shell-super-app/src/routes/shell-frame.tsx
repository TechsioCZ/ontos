/* eslint-disable complexity, no-nested-ternary, unicorn/no-nested-ternary -- The responsive Shell layout derives accessible selector and navigation states from closed props. */
import { Link as LocalizedLink, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Menu } from '@techsio/ui-kit/molecules/menu';
import type { MenuItem } from '@techsio/ui-kit/molecules/menu';
import { Select } from '@techsio/ui-kit/molecules/select';
import { SearchForm } from '@techsio/ui-kit/molecules/search-form';
import { Header } from '@techsio/ui-kit/organisms/header';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

interface DashboardAccount {
  readonly displayName: string;
}

interface DashboardNavigationItem {
  readonly enabled: boolean;
  readonly href?: string;
  readonly label: string;
  readonly moduleId: string;
  readonly state: 'active' | 'deprecated' | 'read_only';
  readonly unavailable: boolean;
}

interface DashboardTenantItem {
  readonly name: string;
  readonly tenantId: string;
}

interface DashboardLegalEntityItem {
  readonly legalEntityId: string;
  readonly legalName: string;
}

export interface AuthenticatedDashboardLayoutProps {
  readonly navigation: readonly DashboardNavigationItem[];
  readonly children: ReactNode;
  readonly currentModuleId?: string;
  readonly currentLegalEntityId?: string;
  readonly currentTenantId: string;
  readonly identity: DashboardAccount;
  readonly homeCurrent?: boolean;
  readonly logoutPending: boolean;
  readonly legalEntityChoices: readonly DashboardLegalEntityItem[];
  readonly legalEntityState: 'available' | 'unavailable';
  readonly legalEntitySwitchFailed: boolean;
  readonly legalEntitySwitchPending: boolean;
  readonly onLogout: () => void;
  readonly onLegalEntityChange: (legalEntityId: string) => void;
  readonly onSearch: (query: string) => void;
  readonly onTenantChange: (tenantId: string) => void;
  readonly tenantChoices: readonly DashboardTenantItem[];
  readonly tenantState: 'available' | 'unavailable';
  readonly tenantSwitchFailed: boolean;
  readonly tenantSwitchPending: boolean;
  readonly title: string;
}

export const AuthenticatedDashboardLayout = ({
  navigation,
  children,
  currentModuleId,
  currentLegalEntityId,
  currentTenantId,
  identity,
  homeCurrent = true,
  logoutPending,
  legalEntityChoices,
  legalEntityState,
  legalEntitySwitchFailed,
  legalEntitySwitchPending,
  onLogout,
  onLegalEntityChange,
  onSearch,
  onTenantChange,
  tenantChoices,
  tenantState,
  tenantSwitchFailed,
  tenantSwitchPending,
  title,
}: AuthenticatedDashboardLayoutProps) => {
  const { t } = useModernI18n();
  const [searchValue, setSearchValue] = useState('');
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
  const legalEntityItems = legalEntityChoices.map(({ legalEntityId, legalName }) => ({
    displayValue: legalName,
    label: legalName,
    value: legalEntityId,
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
  const legalEntityStatus = legalEntitySwitchFailed
    ? 'error'
    : legalEntityState === 'unavailable'
      ? 'warning'
      : 'default';
  const legalEntityStatusText = legalEntitySwitchPending
    ? t('shell.dashboard.legalEntity.pending')
    : legalEntitySwitchFailed
      ? t('shell.dashboard.legalEntity.failed')
      : legalEntityState === 'unavailable'
        ? t('shell.dashboard.legalEntity.unavailable')
        : null;

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
        <Select
          disabled={legalEntityState === 'unavailable' || legalEntitySwitchPending}
          items={legalEntityItems}
          name="legalEntity"
          onValueChange={({ value }) => {
            const [legalEntityId] = value;
            if (
              value.length === 1 &&
              legalEntityId !== undefined &&
              legalEntityId !== currentLegalEntityId
            ) {
              onLegalEntityChange(legalEntityId);
            }
          }}
          validateStatus={legalEntityStatus}
          value={currentLegalEntityId === undefined ? [] : [currentLegalEntityId]}
        >
          <Select.Label>{t('shell.dashboard.legalEntity.accessibleLabel')}</Select.Label>
          <Select.Control>
            <Select.Trigger
              aria-describedby={
                legalEntityStatusText === null ? undefined : 'legal-entity-switch-status'
              }
            >
              <Select.ValueText placeholder={t('shell.dashboard.legalEntity.placeholder')} />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {legalEntityItems.map((item) => (
                <Select.Item item={item} key={item.value}>
                  <Select.ItemText />
                  <Select.ItemIndicator />
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
          {legalEntityStatusText === null ? null : (
            <Select.StatusText
              aria-live="polite"
              id="legal-entity-switch-status"
              showIcon
              status={legalEntityStatus}
            >
              {legalEntityStatusText}
            </Select.StatusText>
          )}
        </Select>
        <SearchForm
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const query = searchValue.trim();
            if (query.length > 0) {
              onSearch(query);
            }
          }}
          onValueChange={setSearchValue}
          value={searchValue}
        >
          <SearchForm.Label>{t('shell.search.label')}</SearchForm.Label>
          <SearchForm.Control>
            <SearchForm.Input />
            <SearchForm.ClearButton />
            <SearchForm.Button showSearchIcon>{t('shell.search.submit')}</SearchForm.Button>
          </SearchForm.Control>
        </SearchForm>
        <nav aria-label={t('shell.dashboard.navigation.label')}>
          <ul className="flex flex-col gap-2">
            <li>
              <Link
                aria-current={homeCurrent && currentModuleId === undefined ? 'page' : undefined}
                as={LocalizedLink}
                to="/"
              >
                {t('shell.dashboard.navigation.home')}
              </Link>
            </li>
            {navigation.map((module) => (
              <li className="flex flex-wrap items-center gap-2" key={module.moduleId}>
                {module.enabled && module.href !== undefined ? (
                  <Link
                    aria-current={currentModuleId === module.moduleId ? 'page' : undefined}
                    as={LocalizedLink}
                    to={module.href}
                  >
                    {module.label}
                  </Link>
                ) : (
                  <span aria-disabled="true">{module.label}</span>
                )}
                {module.state === 'read_only' ? (
                  <Badge size="sm" variant="warning">
                    {t('shell.modules.state.readOnly')}
                  </Badge>
                ) : null}
                {module.state === 'deprecated' ? (
                  <Badge size="sm" variant="warning">
                    {t('shell.modules.state.deprecated')}
                  </Badge>
                ) : null}
                {module.unavailable ? (
                  <StatusText showIcon size="sm" status="warning">
                    {t('shell.modules.unavailable')}
                  </StatusText>
                ) : null}
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
