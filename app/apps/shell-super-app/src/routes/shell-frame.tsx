import { Link as LocalizedLink, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Icon } from '@techsio/ui-kit/atoms/icon';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Menu } from '@techsio/ui-kit/molecules/menu';
import type { MenuItem } from '@techsio/ui-kit/molecules/menu';
import { SearchForm } from '@techsio/ui-kit/molecules/search-form';
import { Select } from '@techsio/ui-kit/molecules/select';
import type { SelectItem } from '@techsio/ui-kit/molecules/select';
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
  readonly compositionRevision?: string;
  readonly currentEntrypointKey?: string;
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
  readonly currentEntrypointKey: string | undefined;
  readonly currentModuleId: string | undefined;
  readonly module: DashboardNavigationItem;
}

interface DashboardDeploymentNavigationItemProps {
  readonly deployment: ShellUnavailableDeployment;
}

interface DashboardNavigationProps {
  readonly currentEntrypointKey: string | undefined;
  readonly currentModuleId: string | undefined;
  readonly homeCurrent: boolean | undefined;
  readonly navigation: readonly DashboardNavigationItem[];
  readonly unavailableDeployments: readonly ShellUnavailableDeployment[];
}

interface DashboardHeaderProps extends DashboardSearchProps {
  readonly identity: DashboardAccount;
  readonly logoutPending: boolean;
  readonly onLogout: () => void;
  readonly title: string | undefined;
}

const propertyModuleId = 'siampark.property';
const siamparkNavigationPresentation = [
  {
    entrypoint: 'siampark.property.page.overview',
    href: '/siampark/overview',
    icon: 'icon-[mdi--view-dashboard-outline]',
    label: 'overview',
    moduleId: propertyModuleId,
  },
  {
    entrypoint: 'siampark.property.page.records',
    href: '/siampark/properties',
    icon: 'icon-[mdi--office-building-outline]',
    label: 'properties',
    moduleId: propertyModuleId,
  },
  {
    entrypoint: 'siampark.occupancy.page.records',
    href: '/siampark/occupancy',
    icon: 'icon-[mdi--key-outline]',
    label: 'occupancy',
    moduleId: 'siampark.occupancy',
  },
  {
    entrypoint: 'siampark.agreements.page.records',
    href: '/siampark/agreements',
    icon: 'icon-[mdi--file-document-outline]',
    label: 'agreements',
    moduleId: 'siampark.agreements',
  },
  {
    entrypoint: 'siampark.billing-finance.page.records',
    href: '/siampark/finance',
    icon: 'icon-[mdi--receipt-text-outline]',
    label: 'finance',
    moduleId: 'siampark.billing-finance',
  },
  {
    entrypoint: 'siampark.work.page.records',
    href: '/siampark/work',
    icon: 'icon-[mdi--clipboard-check-outline]',
    label: 'work',
    moduleId: 'siampark.work',
  },
  {
    entrypoint: 'siampark.relationships.page.records',
    href: '/siampark/relationships',
    icon: 'icon-[mdi--account-group-outline]',
    label: 'relationships',
    moduleId: 'siampark.relationships',
  },
  {
    entrypoint: 'party.registry.page.contacts',
    href: '/contacts',
    icon: 'icon-[mdi--card-account-details-outline]',
    label: 'contacts',
    moduleId: 'party.registry',
  },
  {
    entrypoint: 'siampark.property.page.integrations',
    href: '/siampark/integrations',
    icon: 'icon-[mdi--connection]',
    label: 'integrations',
    moduleId: propertyModuleId,
  },
] as const;

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
    size="sm"
    validateStatus={status}
    value={currentValue === undefined ? [] : [currentValue]}
  >
    <Select.Label className="shell:text-xs shell:text-(--color-fg-secondary)">{label}</Select.Label>
    <Select.Control>
      <Select.Trigger aria-describedby={statusText === null ? undefined : statusId} aria-label={ariaLabel}>
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
      disabled={tenantUnavailable || tenantSwitchPending || !tenantItems.some((item) => item.value !== currentTenantId)}
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
      statusText={selectorStatusText(legalEntitySwitchPending, legalEntitySwitchFailed, legalEntityUnavailable, {
        failed: t('shell.dashboard.legalEntity.failed'),
        pending: t('shell.dashboard.legalEntity.pending'),
        unavailable: t('shell.dashboard.legalEntity.unavailable'),
      })}
    />
  );
};

const DashboardSearch = ({ onSearch, onValueChange, value }: DashboardSearchProps) => {
  const { t } = useModernI18n();
  const searchLabel = t('shell.search.label');

  return (
    <SearchForm
      className="shell:w-full shell:max-w-xl"
      onSubmit={(event) => {
        event.preventDefault();
        const query = value.trim();
        if (query.length > 0) {
          onSearch(query);
        }
      }}
      onValueChange={onValueChange}
      size="sm"
      value={value}
    >
      <SearchForm.Label className="shell:sr-only">{searchLabel}</SearchForm.Label>
      <SearchForm.Control>
        <SearchForm.Input aria-label={searchLabel} placeholder={searchLabel} />
        <SearchForm.ClearButton aria-label={t('shell.search.clear')} />
        <SearchForm.Button showSearchIcon variant="warning">
          {t('shell.search.submit')}
        </SearchForm.Button>
      </SearchForm.Control>
    </SearchForm>
  );
};

const DashboardModuleNavigationItem = ({
  currentEntrypointKey,
  currentModuleId,
  module,
}: DashboardModuleNavigationItemProps) => {
  const { t } = useModernI18n();

  const presentation = siamparkNavigationPresentation.find(
    (item) => item.moduleId === module.moduleId && item.href === module.href,
  );
  const current =
    currentEntrypointKey !== undefined && presentation !== undefined
      ? presentation.entrypoint === currentEntrypointKey
      : currentModuleId === module.moduleId;
  const label =
    presentation === undefined ? module.label : t(`shell.dashboard.navigation.siampark.${presentation.label}`);
  return (
    <li className="shell:flex shell:flex-wrap shell:items-center shell:gap-2">
      {module.enabled && module.href !== undefined ? (
        <Link
          aria-current={current ? 'page' : undefined}
          as={LocalizedLink}
          className="shell:flex shell:w-full shell:items-center shell:gap-3 shell:rounded-md shell:px-3 shell:py-2 shell:text-sm shell:font-medium shell:no-underline shell:hover:bg-(--color-overlay) shell:aria-[current=page]:bg-(--color-warning) shell:aria-[current=page]:text-(--color-page-fg)"
          to={module.href}
        >
          <Icon icon={presentation?.icon ?? 'icon-[mdi--view-grid-outline]'} size="sm" />
          <span>{label}</span>
        </Link>
      ) : (
        <span className="shell:px-3 shell:py-2 shell:text-sm shell:text-(--color-fg-secondary)">{label}</span>
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

const DashboardDeploymentNavigationItem = ({ deployment }: DashboardDeploymentNavigationItemProps) => {
  const { t } = useModernI18n();

  return (
    <li className="shell:flex shell:flex-wrap shell:items-center shell:gap-2">
      <span>{deployment.appId}</span>
      <StatusText showIcon size="sm" status="warning">
        {t(`shell.modules.discovery.${deployment.status === 'unavailable' ? deployment.reason : deployment.status}`)}
      </StatusText>
    </li>
  );
};

const DashboardNavigation = ({
  currentEntrypointKey,
  currentModuleId,
  homeCurrent = true,
  navigation,
  unavailableDeployments,
}: DashboardNavigationProps) => {
  const { t } = useModernI18n();

  return (
    <nav
      aria-label={t('shell.dashboard.navigation.label')}
      className="shell:min-h-0 shell:flex-1 shell:overflow-y-auto"
    >
      <ul className="shell:grid shell:grid-cols-2 shell:gap-1 shell:md:flex shell:md:flex-col">
        <li>
          <Link
            aria-current={homeCurrent && currentModuleId === undefined ? 'page' : undefined}
            as={LocalizedLink}
            className="shell:flex shell:items-center shell:gap-3 shell:rounded-md shell:px-3 shell:py-2 shell:text-sm shell:font-medium shell:no-underline shell:hover:bg-(--color-overlay) shell:aria-[current=page]:bg-(--color-warning) shell:aria-[current=page]:text-(--color-page-fg)"
            to="/"
          >
            <Icon icon="icon-[mdi--home-outline]" size="sm" />
            {t('shell.dashboard.navigation.home')}
          </Link>
        </li>
        {navigation
          .toSorted((left, right) => {
            const leftOrder = siamparkNavigationPresentation.findIndex(
              (item) => item.moduleId === left.moduleId && item.href === left.href,
            );
            const rightOrder = siamparkNavigationPresentation.findIndex(
              (item) => item.moduleId === right.moduleId && item.href === right.href,
            );
            return (
              (leftOrder === -1 ? siamparkNavigationPresentation.length : leftOrder) -
              (rightOrder === -1 ? siamparkNavigationPresentation.length : rightOrder)
            );
          })
          .map((module) => (
            <DashboardModuleNavigationItem
              currentEntrypointKey={currentEntrypointKey}
              currentModuleId={currentModuleId}
              key={module.href ?? module.moduleId}
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

const DashboardHeader = ({
  identity,
  logoutPending,
  onLogout,
  onSearch,
  onValueChange,
  title,
  value,
}: DashboardHeaderProps) => {
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
    <Header
      aria-label={t('shell.dashboard.header.label')}
      className="shell:sticky shell:top-0 shell:z-20 shell:flex-wrap shell:gap-3 shell:border-b shell:border-(--color-border-muted) shell:bg-(--color-surface) shell:px-4 shell:py-2 shell:md:px-6"
      size="sm"
    >
      <Header.Container
        className="shell:min-w-0 shell:basis-full shell:gap-4 shell:md:basis-auto shell:md:flex-1"
        position="start"
      >
        <DashboardSearch onSearch={onSearch} onValueChange={onValueChange} value={value} />
      </Header.Container>
      {title === undefined ? null : (
        <Header.Container className="shell:min-w-0 shell:w-auto shell:flex-1" position="start">
          <h1 className="shell:truncate shell:text-sm shell:font-semibold">{title}</h1>
        </Header.Container>
      )}
      <Header.Container className="shell:w-auto shell:min-w-0 shell:shrink-0" position="end">
        <Header.Actions>
          <Header.ActionItem>
            <Menu
              aria-label={t('shell.dashboard.account.label')}
              customTrigger={
                <Button icon="icon-[mdi--account-circle-outline]" size="sm" theme="borderless" variant="secondary">
                  {identity.displayName}
                </Button>
              }
              items={accountItems}
              onSelect={({ value: action }) => {
                if (action === 'logout') {
                  onLogout();
                }
              }}
              size="sm"
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
  const currentPresentation = siamparkNavigationPresentation.find(
    (item) =>
      item.entrypoint === props.currentEntrypointKey &&
      props.navigation.some((entry) => entry.enabled && entry.moduleId === item.moduleId && entry.href === item.href),
  );

  useEffect(() => {
    if (tenantSwitchFailed) {
      document.querySelector('#tenant-switch-status')?.scrollIntoView({ block: 'nearest' });
    }
  }, [tenantSwitchFailed]);

  return (
    <div className="shell:flex shell:min-h-screen shell:min-w-0 shell:flex-col shell:overflow-x-clip shell:scheme-light! shell:bg-(--color-surface) shell:text-(--color-page-fg) shell:md:flex-row">
      {props.compositionRevision === undefined ? null : (
        <meta content={props.compositionRevision} name="ontos-composition-revision" />
      )}
      <aside
        aria-label={t('shell.dashboard.sidebar.label')}
        className="shell:flex shell:w-full shell:shrink-0 shell:flex-col shell:gap-5 shell:border-b shell:border-(--color-border-muted) shell:bg-(--color-surface-subtle) shell:p-4 shell:md:sticky shell:md:top-0 shell:md:h-screen shell:md:w-64 shell:md:border-r shell:md:border-b-0"
      >
        <div className="shell:flex shell:items-center shell:gap-3 shell:py-1">
          <span className="shell:flex shell:size-10 shell:shrink-0 shell:items-center shell:justify-center shell:rounded-lg shell:bg-(--color-overlay)">
            <Icon icon="icon-[mdi--office-building-outline]" size="lg" />
          </span>
          <div className="shell:min-w-0">
            <p className="shell:font-semibold">{t('shell.dashboard.brand')}</p>
            <p className="shell:text-xs shell:text-(--color-fg-secondary)">{t('shell.dashboard.workspace')}</p>
          </div>
        </div>
        <DashboardNavigation
          currentEntrypointKey={props.currentEntrypointKey}
          currentModuleId={props.currentModuleId}
          homeCurrent={props.homeCurrent}
          navigation={props.navigation}
          unavailableDeployments={props.unavailableDeployments}
        />
        <div className="shell:grid shell:gap-4 shell:border-t shell:border-(--color-border-muted) shell:pt-4">
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
        </div>
      </aside>
      <main className="shell:flex shell:min-w-0 shell:flex-1 shell:flex-col">
        <DashboardHeader
          identity={props.identity}
          logoutPending={props.logoutPending}
          onLogout={props.onLogout}
          onSearch={props.onSearch}
          onValueChange={setSearchValue}
          title={props.title}
          value={searchValue}
        />
        <div className="shell:min-w-0 shell:flex-1 shell:space-y-5 shell:p-4 shell:md:p-6">
          {currentPresentation === undefined ? null : (
            <nav
              aria-label={t('shell.dashboard.breadcrumb.label')}
              className="shell:flex shell:items-center shell:gap-2 shell:rounded-md shell:bg-(--color-surface-subtle) shell:px-3 shell:py-2 shell:text-xs shell:text-(--color-fg-secondary)"
            >
              <Link aria-label={t('shell.dashboard.breadcrumb.home')} as={LocalizedLink} to="/">
                {t('shell.dashboard.navigation.home')}
              </Link>
              <Icon icon="icon-[mdi--chevron-right]" size="sm" />
              <span aria-current="page">{t(`shell.dashboard.navigation.siampark.${currentPresentation.label}`)}</span>
            </nav>
          )}
          {props.children}
        </div>
      </main>
    </div>
  );
};
