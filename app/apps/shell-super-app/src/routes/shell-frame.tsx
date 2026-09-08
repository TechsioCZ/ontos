import { Link as LocalizedLink, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Menu } from '@techsio/ui-kit/molecules/menu';
import type { MenuItem } from '@techsio/ui-kit/molecules/menu';
import { Select } from '@techsio/ui-kit/molecules/select';
import type { SelectItem } from '@techsio/ui-kit/molecules/select';
import { SearchForm } from '@techsio/ui-kit/molecules/search-form';
import { Header } from '@techsio/ui-kit/organisms/header';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ShellUnavailableDeployment } from '../../shared/api.ts';

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
  readonly children: ReactNode;
  readonly currentLegalEntityId?: string;
  readonly currentModuleId?: string;
  readonly currentTenantId: string;
  readonly homeCurrent?: boolean;
  readonly identity: DashboardAccount;
  readonly legalEntityChoices: readonly DashboardLegalEntityItem[];
  readonly legalEntityState: 'available' | 'unavailable';
  readonly legalEntitySwitchFailed: boolean;
  readonly legalEntitySwitchPending: boolean;
  readonly logoutPending: boolean;
  readonly navigation: readonly DashboardNavigationItem[];
  readonly onLegalEntityChange: (legalEntityId: string) => void;
  readonly onLogout: () => void;
  readonly onSearch: (query: string) => void;
  readonly onTenantChange: (tenantId: string) => void;
  readonly tenantChoices: readonly DashboardTenantItem[];
  readonly tenantState: 'available' | 'unavailable';
  readonly tenantSwitchFailed: boolean;
  readonly tenantSwitchPending: boolean;
  readonly title?: string;
  readonly unavailableDeployments: readonly ShellUnavailableDeployment[];
}

interface DashboardTenantSelectorProps {
  readonly currentTenantId: string;
  readonly onTenantChange: (tenantId: string) => void;
  readonly tenantChoices: readonly DashboardTenantItem[];
  readonly tenantState: AuthenticatedDashboardLayoutProps['tenantState'];
  readonly tenantSwitchFailed: boolean;
  readonly tenantSwitchPending: boolean;
}

interface DashboardLegalEntitySelectorProps {
  readonly currentLegalEntityId: string | undefined;
  readonly legalEntityChoices: readonly DashboardLegalEntityItem[];
  readonly legalEntityState: AuthenticatedDashboardLayoutProps['legalEntityState'];
  readonly legalEntitySwitchFailed: boolean;
  readonly legalEntitySwitchPending: boolean;
  readonly onLegalEntityChange: (legalEntityId: string) => void;
}

interface DashboardSelectorProps {
  readonly ariaLabel?: string;
  readonly currentValue: string | undefined;
  readonly disabled: boolean;
  readonly items: SelectItem[];
  readonly label: string;
  readonly name: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
  readonly status: 'default' | 'error' | 'warning';
  readonly statusId: string;
  readonly statusText: string | null;
}

interface DashboardSearchProps {
  readonly onSearch: (query: string) => void;
  readonly onValueChange: (value: string) => void;
  readonly value: string;
}

interface DashboardModuleNavigationItemProps {
  readonly currentModuleId: string | undefined;
  readonly module: DashboardNavigationItem;
}

interface DashboardDeploymentNavigationItemProps {
  readonly deployment: ShellUnavailableDeployment;
}

interface DashboardNavigationProps {
  readonly currentModuleId: string | undefined;
  readonly homeCurrent: boolean | undefined;
  readonly navigation: readonly DashboardNavigationItem[];
  readonly unavailableDeployments: readonly ShellUnavailableDeployment[];
}

interface DashboardHeaderProps {
  readonly identity: DashboardAccount;
  readonly logoutPending: boolean;
  readonly onLogout: () => void;
  readonly title: string | undefined;
}

const selectorStatus = (failed: boolean, unavailable: boolean): 'default' | 'error' | 'warning' => {
  if (failed) {
    return 'error';
  }
  return unavailable ? 'warning' : 'default';
};

const selectorStatusText = (
  pending: boolean,
  failed: boolean,
  unavailable: boolean,
  messages: {
    readonly failed: string;
    readonly pending: string;
    readonly unavailable: string;
  },
): string | null => {
  if (pending) {
    return messages.pending;
  }
  if (failed) {
    return messages.failed;
  }
  return unavailable ? messages.unavailable : null;
};

const DashboardSelector = ({
  ariaLabel,
  currentValue,
  disabled,
  items,
  label,
  name,
  onChange,
  placeholder,
  status,
  statusId,
  statusText,
}: DashboardSelectorProps) => (
  <Select
    disabled={disabled}
    items={items}
    name={name}
    onValueChange={({ value }) => {
      const [selected] = value;
      if (value.length === 1 && selected !== undefined && selected !== currentValue) {
        onChange(selected);
      }
    }}
    validateStatus={status}
    value={currentValue === undefined ? [] : [currentValue]}
  >
    <Select.Label>{label}</Select.Label>
    <Select.Control>
      <Select.Trigger
        aria-describedby={statusText === null ? undefined : statusId}
        aria-label={ariaLabel}
      >
        <Select.ValueText placeholder={placeholder} />
      </Select.Trigger>
    </Select.Control>
    <Select.Positioner>
      <Select.Content>
        {items.map((item) => (
          <Select.Item item={item} key={item.value}>
            <Select.ItemText />
            <Select.ItemIndicator />
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Positioner>
    {statusText === null ? null : (
      <Select.StatusText aria-live="polite" id={statusId} showIcon status={status}>
        {statusText}
      </Select.StatusText>
    )}
  </Select>
);

const DashboardTenantSelector = ({
  currentTenantId,
  onTenantChange,
  tenantChoices,
  tenantState,
  tenantSwitchFailed,
  tenantSwitchPending,
}: DashboardTenantSelectorProps) => {
  const { t } = useModernI18n();
  const tenantItems = tenantChoices.map(({ name, tenantId }) => ({
    displayValue: name,
    label: name,
    value: tenantId,
  }));
  const tenantUnavailable = tenantState === 'unavailable';
  const accessibleLabel = t('shell.dashboard.tenant.accessibleLabel');
  const unavailableText = t('shell.dashboard.tenant.unavailable');

  return (
    <DashboardSelector
      ariaLabel={accessibleLabel}
      currentValue={currentTenantId}
      disabled={
        tenantUnavailable ||
        tenantSwitchPending ||
        !tenantItems.some((item) => item.value !== currentTenantId)
      }
      items={tenantItems}
      label={accessibleLabel}
      name="tenant"
      onChange={onTenantChange}
      placeholder={unavailableText}
      status={selectorStatus(tenantSwitchFailed, tenantUnavailable)}
      statusId="tenant-switch-status"
      statusText={selectorStatusText(tenantSwitchPending, tenantSwitchFailed, tenantUnavailable, {
        failed: t('shell.dashboard.tenant.failed'),
        pending: t('shell.dashboard.tenant.pending'),
        unavailable: unavailableText,
      })}
    />
  );
};

const DashboardLegalEntitySelector = ({
  currentLegalEntityId,
  legalEntityChoices,
  legalEntityState,
  legalEntitySwitchFailed,
  legalEntitySwitchPending,
  onLegalEntityChange,
}: DashboardLegalEntitySelectorProps) => {
  const { t } = useModernI18n();
  const legalEntityItems = legalEntityChoices.map(({ legalEntityId, legalName }) => ({
    displayValue: legalName,
    label: legalName,
    value: legalEntityId,
  }));
  const legalEntityUnavailable = legalEntityState === 'unavailable';

  return (
    <DashboardSelector
      currentValue={currentLegalEntityId}
      disabled={legalEntityUnavailable || legalEntitySwitchPending}
      items={legalEntityItems}
      label={t('shell.dashboard.legalEntity.accessibleLabel')}
      name="legalEntity"
      onChange={onLegalEntityChange}
      placeholder={t('shell.dashboard.legalEntity.placeholder')}
      status={selectorStatus(legalEntitySwitchFailed, legalEntityUnavailable)}
      statusId="legal-entity-switch-status"
      statusText={selectorStatusText(
        legalEntitySwitchPending,
        legalEntitySwitchFailed,
        legalEntityUnavailable,
        {
          failed: t('shell.dashboard.legalEntity.failed'),
          pending: t('shell.dashboard.legalEntity.pending'),
          unavailable: t('shell.dashboard.legalEntity.unavailable'),
        },
      )}
    />
  );
};

const DashboardSearch = ({ onSearch, onValueChange, value }: DashboardSearchProps) => {
  const { t } = useModernI18n();

  return (
    <SearchForm
      onSubmit={(event) => {
        event.preventDefault();
        const query = value.trim();
        if (query.length > 0) {
          onSearch(query);
        }
      }}
      onValueChange={onValueChange}
      value={value}
    >
      <SearchForm.Label>{t('shell.search.label')}</SearchForm.Label>
      <SearchForm.Control>
        <SearchForm.Input />
        <SearchForm.ClearButton />
        <SearchForm.Button showSearchIcon>{t('shell.search.submit')}</SearchForm.Button>
      </SearchForm.Control>
    </SearchForm>
  );
};

const DashboardModuleNavigationItem = ({
  currentModuleId,
  module,
}: DashboardModuleNavigationItemProps) => {
  const { t } = useModernI18n();

  return (
    <li className="shell:flex shell:flex-wrap shell:items-center shell:gap-2">
      {module.enabled && module.href !== undefined ? (
        <Link
          aria-current={currentModuleId === module.moduleId ? 'page' : undefined}
          as={LocalizedLink}
          to={module.href}
        >
          {module.label}
        </Link>
      ) : (
        <span>{module.label}</span>
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
  );
};

const DashboardDeploymentNavigationItem = ({
  deployment,
}: DashboardDeploymentNavigationItemProps) => {
  const { t } = useModernI18n();

  return (
    <li className="shell:flex shell:flex-wrap shell:items-center shell:gap-2">
      <span>{deployment.appId}</span>
      <StatusText showIcon size="sm" status="warning">
        {t(
          `shell.modules.discovery.${
            deployment.status === 'unavailable' ? deployment.reason : deployment.status
          }`,
        )}
      </StatusText>
    </li>
  );
};

const DashboardNavigation = ({
  currentModuleId,
  homeCurrent = true,
  navigation,
  unavailableDeployments,
}: DashboardNavigationProps) => {
  const { t } = useModernI18n();

  return (
    <nav aria-label={t('shell.dashboard.navigation.label')}>
      <ul className="shell:flex shell:flex-col shell:gap-2">
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
          <DashboardModuleNavigationItem
            currentModuleId={currentModuleId}
            key={module.moduleId}
            module={module}
          />
        ))}
        {unavailableDeployments.map((deployment) => (
          <DashboardDeploymentNavigationItem deployment={deployment} key={deployment.appId} />
        ))}
      </ul>
    </nav>
  );
};

const DashboardHeader = ({ identity, logoutPending, onLogout, title }: DashboardHeaderProps) => {
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
    <Header aria-label={t('shell.dashboard.header.label')}>
      {title === undefined ? null : (
        <Header.Container position="start">
          <h1>{title}</h1>
        </Header.Container>
      )}
      <Header.Container position="end">
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
      </Header.Container>
    </Header>
  );
};

export const AuthenticatedDashboardLayout = (props: AuthenticatedDashboardLayoutProps) => {
  const { t } = useModernI18n();
  const [searchValue, setSearchValue] = useState('');
  const { tenantSwitchFailed } = props;

  useEffect(() => {
    if (tenantSwitchFailed) {
      document.querySelector('#tenant-switch-status')?.scrollIntoView({ block: 'nearest' });
    }
  }, [tenantSwitchFailed]);

  return (
    <div className="shell:flex shell:min-h-screen shell:min-w-0 shell:flex-col shell:overflow-x-hidden shell:bg-(--color-page-bg) shell:text-(--color-page-fg) shell:md:flex-row">
      <aside
        aria-label={t('shell.dashboard.sidebar.label')}
        className="shell:flex shell:w-full shell:shrink-0 shell:flex-col shell:gap-6 shell:bg-(--color-surface) shell:p-4 shell:md:w-64"
      >
        <p>{t('shell.dashboard.brand')}</p>
        <DashboardTenantSelector
          currentTenantId={props.currentTenantId}
          onTenantChange={props.onTenantChange}
          tenantChoices={props.tenantChoices}
          tenantState={props.tenantState}
          tenantSwitchFailed={props.tenantSwitchFailed}
          tenantSwitchPending={props.tenantSwitchPending}
        />
        <DashboardLegalEntitySelector
          currentLegalEntityId={props.currentLegalEntityId}
          legalEntityChoices={props.legalEntityChoices}
          legalEntityState={props.legalEntityState}
          legalEntitySwitchFailed={props.legalEntitySwitchFailed}
          legalEntitySwitchPending={props.legalEntitySwitchPending}
          onLegalEntityChange={props.onLegalEntityChange}
        />
        <DashboardSearch
          onSearch={props.onSearch}
          onValueChange={setSearchValue}
          value={searchValue}
        />
        <DashboardNavigation
          currentModuleId={props.currentModuleId}
          homeCurrent={props.homeCurrent}
          navigation={props.navigation}
          unavailableDeployments={props.unavailableDeployments}
        />
      </aside>
      <main className="shell:flex shell:min-w-0 shell:flex-1 shell:flex-col">
        <DashboardHeader
          identity={props.identity}
          logoutPending={props.logoutPending}
          onLogout={props.onLogout}
          title={props.title}
        />
        <div className="shell:min-w-0 shell:flex-1 shell:px-2 shell:py-4">{props.children}</div>
      </main>
    </div>
  );
};
