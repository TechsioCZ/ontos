import { Link as LocalizedLink, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Icon } from '@techsio/ui-kit/atoms/icon';
import type { IconType } from '@techsio/ui-kit/atoms/icon';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Tooltip } from '@techsio/ui-kit/atoms/tooltip';
import { Menu } from '@techsio/ui-kit/molecules/menu';
import type { MenuItem } from '@techsio/ui-kit/molecules/menu';
import { SearchForm } from '@techsio/ui-kit/molecules/search-form';
import { Select } from '@techsio/ui-kit/molecules/select';
import type { SelectItem } from '@techsio/ui-kit/molecules/select';
import { Header } from '@techsio/ui-kit/organisms/header';
import { Sidebar } from '@techsio/ui-kit/organisms/sidebar';
import type { SidebarExpandedChangeDetails, SidebarSide } from '@techsio/ui-kit/organisms/sidebar';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ComponentProps, CSSProperties, ReactNode } from 'react';

import type { ShellUnavailableDeployment } from '../../shared/api.ts';
import { navigationHrefFromPath, usePendingNavigationPath } from './use-pending-navigation.ts';

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

/** Siampark-only verticals stay installed but never appear in the sales demo navigation. */
const hiddenNavigationModuleIds: ReadonlySet<string> = new Set([
  propertyModuleId,
  'siampark.occupancy',
  'siampark.agreements',
  'siampark.relationships',
]);

interface DemoNavigationItemPresentation {
  /** Page entrypoint keys that mark this destination as current. */
  readonly entrypoints: readonly string[];
  /** Module-contributed hrefs this destination accepts, most specific first. */
  readonly hrefs: readonly string[];
  readonly icon: IconType;
  readonly key: string;
  readonly moduleId: string;
}

interface DemoNavigationGroupPresentation {
  readonly icon: IconType;
  readonly items: readonly DemoNavigationItemPresentation[];
  readonly key: string;
}

/**
 * Sales demo navigation. Destinations still come from module-contributed entries: an item links only when its
 * module publishes an enabled entry with one of the accepted hrefs (or, for single-page modules, any entry).
 */
const demoNavigationPresentation: readonly DemoNavigationGroupPresentation[] = [
  {
    icon: 'icon-[mdi--handshake-outline]',
    items: [
      {
        entrypoints: ['demo.sales-pipeline.page.records', 'demo.sales-pipeline.page.opportunities'],
        hrefs: ['/prodej/prilezitosti'],
        icon: 'icon-[mdi--target-account]',
        key: 'opportunities',
        moduleId: 'demo.sales-pipeline',
      },
      {
        // The contacts page has its own link under other modules, so it must not also mark Customers current.
        entrypoints: ['party.registry.page.customers'],
        hrefs: ['/prodej/zakaznici', '/zakaznici', '/customers', '/contacts'],
        icon: 'icon-[mdi--domain]',
        key: 'customers',
        moduleId: 'party.registry',
      },
      {
        entrypoints: ['demo.merchandise.page.orders'],
        hrefs: ['/prodej/objednavky'],
        icon: 'icon-[mdi--cart-outline]',
        key: 'orders',
        moduleId: 'demo.merchandise',
      },
      {
        entrypoints: ['siampark.billing-finance.page.records'],
        hrefs: ['/siampark/finance', '/prodej/faktury'],
        icon: 'icon-[mdi--receipt-text-outline]',
        key: 'invoices',
        moduleId: 'siampark.billing-finance',
      },
    ],
    key: 'sales',
  },
  {
    icon: 'icon-[mdi--cog-transfer-outline]',
    items: [
      {
        entrypoints: ['siampark.work.page.records'],
        hrefs: ['/siampark/work', '/provoz/ukoly'],
        icon: 'icon-[mdi--clipboard-check-outline]',
        key: 'tasks',
        moduleId: 'siampark.work',
      },
      {
        entrypoints: ['demo.workforce.page.records', 'demo.workforce.page.employees'],
        hrefs: ['/prodej/zamestnanci', '/provoz/zamestnanci'],
        icon: 'icon-[mdi--badge-account-horizontal-outline]',
        key: 'employees',
        moduleId: 'demo.workforce',
      },
      {
        entrypoints: ['demo.merchandise.page.products'],
        hrefs: ['/provoz/produkty'],
        icon: 'icon-[mdi--package-variant-closed]',
        key: 'products',
        moduleId: 'demo.merchandise',
      },
    ],
    key: 'operations',
  },
  {
    icon: 'icon-[mdi--chart-box-outline]',
    items: [
      {
        entrypoints: ['demo.sales-insights.page.records', 'demo.sales-insights.page.statistics'],
        hrefs: ['/prehledy/statistiky', '/statistiky'],
        icon: 'icon-[mdi--chart-line]',
        key: 'statistics',
        moduleId: 'demo.sales-insights',
      },
    ],
    key: 'insights',
  },
  {
    icon: 'icon-[mdi--tune-variant]',
    items: [
      {
        entrypoints: ['demo.tagging.page.records', 'demo.tagging.page.tags'],
        hrefs: ['/nastaveni/stitky'],
        icon: 'icon-[mdi--tag-multiple-outline]',
        key: 'tags',
        moduleId: 'demo.tagging',
      },
    ],
    key: 'settings',
  },
];

interface ShellNavigationLink {
  readonly current: boolean;
  readonly enabled: boolean;
  readonly href: string | null;
  readonly icon: IconType;
  /** No module publishes this destination yet (not installed, inactive or not permitted). */
  readonly inactive: boolean;
  readonly key: string;
  readonly label: string;
  /** Typed reason text when the destination cannot be opened. */
  readonly notice: string | null;
  readonly state: DashboardNavigationItem['state'];
}

interface ShellNavigationGroup {
  readonly icon: IconType;
  readonly key: string;
  readonly label: string;
  readonly links: readonly ShellNavigationLink[];
}

interface ShellNavigationModel {
  readonly current: { readonly group: ShellNavigationGroup; readonly link: ShellNavigationLink } | undefined;
  readonly groups: readonly ShellNavigationGroup[];
  readonly home: ShellNavigationLink;
}

type Translate = (key: string) => string;

/**
 * LinkButton always forwards `href`; the localized router link derives it from `to`, so drop the empty one.
 * The router preloads every link in the viewport by default, and each shell route loader reads the session,
 * composition, tenants and legal entities, so a page load ran that for every visible navigation item at once.
 * Shell links preload on intent only.
 */
const ShellRouteLink = ({
  href: _unusedHref,
  ...props
}: ComponentProps<typeof LocalizedLink> & { readonly href?: string | undefined }) => (
  <LocalizedLink prefetch="intent" {...props} />
);

const presentationOrder = (entry: DashboardNavigationItem) => {
  const index = siamparkNavigationPresentation.findIndex(
    (item) => item.moduleId === entry.moduleId && item.href === entry.href,
  );
  return index === -1 ? siamparkNavigationPresentation.length : index;
};

const entryNotice = (entry: DashboardNavigationItem | undefined, t: Translate): string | null => {
  if (entry === undefined) {
    return t('shell.dashboard.navigation.inactive');
  }
  return entry.unavailable ? t('shell.modules.unavailable') : null;
};

/** How a destination relates to the rendered page: its own entrypoint, or only the same module. */
type MatchedNavigationLink = Omit<ShellNavigationLink, 'current'> & {
  readonly entrypointMatch: boolean;
  readonly moduleMatch: boolean;
};

const buildShellNavigation = (
  props: Pick<
    AuthenticatedDashboardLayoutProps,
    'currentEntrypointKey' | 'currentModuleId' | 'homeCurrent' | 'navigation' | 'unavailableDeployments'
  > & {
    /** Destination href of a navigation whose page is still loading; it alone is current until the page settles. */
    readonly pendingHref?: string | undefined;
  },
  t: Translate,
): ShellNavigationModel => {
  const { currentEntrypointKey, currentModuleId, homeCurrent = true, pendingHref } = props;
  const visible = props.navigation.filter((entry) => !hiddenNavigationModuleIds.has(entry.moduleId));
  const demoItems = demoNavigationPresentation.flatMap((group) => group.items);
  const claimed = new Map<DemoNavigationItemPresentation, DashboardNavigationItem>();
  const isClaimed = (entry: DashboardNavigationItem) => [...claimed.values()].includes(entry);
  const soleModuleItem = (item: DemoNavigationItemPresentation) =>
    demoItems.filter((candidate) => candidate.moduleId === item.moduleId).length === 1;

  for (const item of demoItems) {
    const byHref = item.hrefs
      .map((href) => visible.find((entry) => entry.href === href && !isClaimed(entry)))
      .find((entry) => entry !== undefined);
    if (byHref !== undefined) {
      claimed.set(item, byHref);
    }
  }
  for (const item of demoItems) {
    if (!claimed.has(item) && soleModuleItem(item)) {
      const moduleEntries = visible.filter((entry) => entry.moduleId === item.moduleId && !isClaimed(entry));
      const byModule = moduleEntries.find((entry) => entry.enabled) ?? moduleEntries[0];
      if (byModule !== undefined) {
        claimed.set(item, byModule);
      }
    }
  }

  const demoGroups = demoNavigationPresentation.map((group) => ({
    icon: group.icon,
    key: group.key,
    label: t(`shell.dashboard.navigation.groups.${group.key}`),
    links: group.items.map((item): MatchedNavigationLink => {
      const entry = claimed.get(item);
      const entrypointCurrent = currentEntrypointKey !== undefined && item.entrypoints.includes(currentEntrypointKey);
      const moduleCurrent =
        entry !== undefined &&
        soleModuleItem(item) &&
        currentModuleId !== undefined &&
        currentModuleId === entry.moduleId;
      return {
        enabled: entry !== undefined && entry.enabled && entry.href !== undefined,
        entrypointMatch: entrypointCurrent,
        href: entry?.href ?? null,
        icon: item.icon,
        inactive: entry === undefined,
        key: item.key,
        label: t(`shell.dashboard.navigation.items.${item.key}`),
        moduleMatch: moduleCurrent,
        notice: entryNotice(entry, t),
        state: entry?.state ?? 'active',
      };
    }),
  }));

  const otherLinks = visible
    .filter((entry) => !isClaimed(entry))
    .toSorted((left, right) => presentationOrder(left) - presentationOrder(right))
    .map((entry): MatchedNavigationLink => {
      const presentation = siamparkNavigationPresentation.find(
        (item) => item.moduleId === entry.moduleId && item.href === entry.href,
      );
      const exact = currentEntrypointKey !== undefined && presentation !== undefined;
      return {
        enabled: entry.enabled && entry.href !== undefined,
        entrypointMatch: exact && presentation.entrypoint === currentEntrypointKey,
        href: entry.href ?? null,
        icon: presentation?.icon ?? 'icon-[mdi--view-grid-outline]',
        inactive: false,
        key: entry.href ?? entry.moduleId,
        label:
          presentation === undefined ? entry.label : t(`shell.dashboard.navigation.siampark.${presentation.label}`),
        moduleMatch: !exact && currentModuleId === entry.moduleId,
        notice: entryNotice(entry, t),
        state: entry.state,
      };
    });
  const deploymentLinks = props.unavailableDeployments.map((deployment): MatchedNavigationLink => ({
    enabled: false,
    entrypointMatch: false,
    href: null,
    icon: 'icon-[mdi--cloud-off-outline]',
    inactive: false,
    key: `deployment:${deployment.appId}`,
    label: deployment.appId,
    moduleMatch: false,
    notice: t(`shell.modules.discovery.${deployment.status === 'unavailable' ? deployment.reason : deployment.status}`),
    state: 'active',
  }));
  const otherGroup = {
    icon: 'icon-[mdi--view-grid-outline]' as const,
    key: 'other',
    label: t('shell.dashboard.navigation.groups.other'),
    links: [...otherLinks, ...deploymentLinks],
  };
  const candidates = otherGroup.links.length === 0 ? demoGroups : [...demoGroups, otherGroup];
  // A page's own destination wins over destinations that only share its module, so one link is current.
  const exactMatch = candidates.some((group) => group.links.some((link) => link.entrypointMatch));
  const settleLink = ({ entrypointMatch, moduleMatch, ...link }: MatchedNavigationLink): ShellNavigationLink => {
    if (pendingHref !== undefined) {
      return { ...link, current: link.enabled && link.href === pendingHref };
    }
    return { ...link, current: exactMatch ? entrypointMatch : moduleMatch };
  };
  const groups: ShellNavigationGroup[] = candidates.map((group) => ({
    icon: group.icon,
    key: group.key,
    label: group.label,
    links: group.links.map(settleLink),
  }));
  const currentGroup = groups.find((group) => group.links.some((link) => link.current));
  const currentLink = currentGroup?.links.find((link) => link.current);

  return {
    current:
      currentGroup === undefined || currentLink === undefined ? undefined : { group: currentGroup, link: currentLink },
    groups,
    home: {
      current: pendingHref === undefined ? homeCurrent && currentModuleId === undefined : pendingHref === '/',
      enabled: true,
      href: '/',
      icon: 'icon-[mdi--home-outline]',
      inactive: false,
      key: 'home',
      label: t('shell.dashboard.navigation.home'),
      notice: null,
      state: 'active',
    },
  };
};

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
    <Select.Label className="font-medium text-fg-secondary text-xs uppercase tracking-wide">{label}</Select.Label>
    <Select.Control>
      <Select.Trigger aria-label={ariaLabel}>
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

type DashboardContextSelectorsProps = Pick<
  AuthenticatedDashboardLayoutProps,
  | 'currentLegalEntityId'
  | 'currentTenantId'
  | 'legalEntityChoices'
  | 'legalEntityState'
  | 'legalEntitySwitchFailed'
  | 'legalEntitySwitchPending'
  | 'onLegalEntityChange'
  | 'onTenantChange'
  | 'tenantChoices'
  | 'tenantState'
  | 'tenantSwitchFailed'
  | 'tenantSwitchPending'
>;

/** Tenant and legal-entity switchers; the shell keeps them at the foot of the navigation. */
const DashboardContextSelectors = (props: DashboardContextSelectorsProps) => {
  const { t } = useModernI18n();
  const tenantItems = props.tenantChoices.map(({ name, tenantId }) => ({
    displayValue: name,
    label: name,
    value: tenantId,
  }));
  const tenantUnavailable = props.tenantState === 'unavailable';
  const tenantLabel = t('shell.dashboard.tenant.accessibleLabel');
  const tenantUnavailableText = t('shell.dashboard.tenant.unavailable');
  const legalEntityItems = props.legalEntityChoices.map(({ legalEntityId, legalName }) => ({
    displayValue: legalName,
    label: legalName,
    value: legalEntityId,
  }));
  const legalEntityUnavailable = props.legalEntityState === 'unavailable';

  return (
    <div className="grid gap-100">
      <DashboardSelector
        ariaLabel={tenantLabel}
        currentValue={props.currentTenantId}
        disabled={
          tenantUnavailable ||
          props.tenantSwitchPending ||
          !tenantItems.some((item) => item.value !== props.currentTenantId)
        }
        items={tenantItems}
        label={tenantLabel}
        name="tenant"
        onChange={props.onTenantChange}
        placeholder={tenantUnavailableText}
        status={selectorStatus(props.tenantSwitchFailed, tenantUnavailable)}
        statusId="tenant-switch-status"
        statusText={selectorStatusText(props.tenantSwitchPending, props.tenantSwitchFailed, tenantUnavailable, {
          failed: t('shell.dashboard.tenant.failed'),
          pending: t('shell.dashboard.tenant.pending'),
          unavailable: tenantUnavailableText,
        })}
      />
      <DashboardSelector
        currentValue={props.currentLegalEntityId}
        disabled={legalEntityUnavailable || props.legalEntitySwitchPending}
        items={legalEntityItems}
        label={t('shell.dashboard.legalEntity.accessibleLabel')}
        name="legalEntity"
        onChange={props.onLegalEntityChange}
        placeholder={t('shell.dashboard.legalEntity.placeholder')}
        status={selectorStatus(props.legalEntitySwitchFailed, legalEntityUnavailable)}
        statusId="legal-entity-switch-status"
        statusText={selectorStatusText(
          props.legalEntitySwitchPending,
          props.legalEntitySwitchFailed,
          legalEntityUnavailable,
          {
            failed: t('shell.dashboard.legalEntity.failed'),
            pending: t('shell.dashboard.legalEntity.pending'),
            unavailable: t('shell.dashboard.legalEntity.unavailable'),
          },
        )}
      />
    </div>
  );
};

const DashboardSearch = ({ onSearch, onValueChange, value }: DashboardSearchProps) => {
  const { t } = useModernI18n();
  const searchLabel = t('shell.search.label');

  return (
    <SearchForm
      className="w-full"
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
      <SearchForm.Label className="sr-only">{searchLabel}</SearchForm.Label>
      <SearchForm.Control>
        <SearchForm.Input aria-label={searchLabel} placeholder={t('shell.search.placeholder')} />
        <SearchForm.ClearButton aria-label={t('shell.search.clear')} />
        <SearchForm.Button aria-label={t('shell.search.submit')} showSearchIcon variant="primary" />
      </SearchForm.Control>
    </SearchForm>
  );
};

const DashboardAccountMenu = ({
  identity,
  logoutPending,
  onLogout,
}: Pick<AuthenticatedDashboardLayoutProps, 'identity' | 'logoutPending' | 'onLogout'>) => {
  const { t } = useModernI18n();
  const accountItems: MenuItem[] = [
    {
      disabled: logoutPending,
      icon: 'icon-[mdi--logout]',
      label: t(logoutPending ? 'shell.auth.logout.pending' : 'shell.auth.logout.action'),
      type: 'action',
      value: 'logout',
    },
  ];
  return (
    <Menu
      aria-label={t('shell.dashboard.account.label')}
      customTrigger={
        <Button
          aria-label={identity.displayName}
          className="hover:bg-overlay"
          icon="icon-[mdi--account-circle-outline]"
          size="sm"
          theme="unstyled"
          variant="secondary"
        >
          <span className="hidden md:inline">{identity.displayName}</span>
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
  );
};

/** Workspace identity: brand mark, product name and the workspace it serves. */
const DashboardBrand = () => {
  const { t } = useModernI18n();
  return (
    <span className="flex min-w-0 items-center gap-150">
      <span className="flex size-icon-control-lg shrink-0 items-center justify-center rounded-md bg-primary text-fg-primary">
        <Icon icon="icon-[mdi--hexagon-multiple-outline]" size="md" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-semibold text-sm">{t('shell.dashboard.brand')}</span>
        <span className="truncate text-fg-secondary text-xs">{t('shell.dashboard.workspace')}</span>
      </span>
    </span>
  );
};

/** Where am I: group and destination of the current page, shown in the top bar. */
const DashboardTrail = ({ model }: { readonly model: ShellNavigationModel }) => {
  const { t } = useModernI18n();
  if (model.current === undefined) {
    return null;
  }
  return (
    <nav
      aria-label={t('shell.dashboard.breadcrumb.label')}
      className="hidden min-w-0 items-center gap-100 text-fg-secondary text-sm md:flex"
    >
      <span className="truncate">{model.current.group.label}</span>
      <Icon icon="icon-[mdi--chevron-right]" size="sm" />
      <span aria-current="page" className="truncate font-medium text-fg-primary">
        {model.current.link.label}
      </span>
    </nav>
  );
};

/** Navigation destination as a real link; unavailable destinations stay visible with their reason. */
const DashboardNavigationLink = ({
  collapsedSide,
  link,
}: {
  /** Show a tooltip with the label when the icon rail is collapsed. */
  readonly collapsedSide?: boolean;
  readonly link: ShellNavigationLink;
}) => {
  const { t } = useModernI18n();
  const badge =
    link.state === 'read_only' || link.state === 'deprecated' ? (
      <Badge size="sm" variant="warning">
        {t(link.state === 'read_only' ? 'shell.modules.state.readOnly' : 'shell.modules.state.deprecated')}
      </Badge>
    ) : null;
  const destination =
    link.enabled && link.href !== null ? (
      <Sidebar.Context>
        {(sidebar) => (
          <LinkButton
            aria-current={link.current ? 'page' : undefined}
            as={ShellRouteLink}
            block
            className={link.current ? 'justify-start font-semibold' : 'justify-start hover:bg-overlay'}
            icon={link.icon}
            // Below the breakpoint the navigation is a drawer; choosing a destination dismisses it.
            onClick={() => sidebar.closeMobile()}
            size="sm"
            theme={link.current ? 'light' : 'unstyled'}
            to={link.href}
            variant={link.current ? 'primary' : 'secondary'}
          >
            <Sidebar.Label className="min-w-0 flex-1 truncate text-start">{link.label}</Sidebar.Label>
          </LinkButton>
        )}
      </Sidebar.Context>
    ) : (
      <span className="flex h-form-control-sm items-center gap-button-sm p-button-sm text-button-sm text-fg-secondary">
        <Icon icon={link.icon} size="sm" />
        <Sidebar.Label className="min-w-0 flex-1 truncate">{link.label}</Sidebar.Label>
        {link.inactive && link.notice !== null ? (
          <Sidebar.Expanded>
            <Badge size="sm" variant="outline">
              {link.notice}
            </Badge>
          </Sidebar.Expanded>
        ) : null}
      </span>
    );
  const content =
    badge === null && (link.notice === null || link.inactive) ? (
      destination
    ) : (
      <div className="grid gap-50">
        {destination}
        <Sidebar.Expanded className="flex flex-wrap items-center gap-100 ps-150">
          {badge}
          {link.notice === null ? null : (
            <StatusText showIcon size="sm" status="warning">
              {link.notice}
            </StatusText>
          )}
        </Sidebar.Expanded>
      </div>
    );
  if (collapsedSide !== true) {
    return content;
  }
  return (
    <Sidebar.Context>
      {(api) =>
        !api.isDesktop || api.isExpanded('start') ? (
          content
        ) : (
          <Tooltip content={link.label} placement="right">
            {content}
          </Tooltip>
        )
      }
    </Sidebar.Context>
  );
};

const navigationToggleKey = 'shell.dashboard.navigation.toggle';

/** Grouped navigation panel: labelled groups on desktop, icon rail when collapsed, drawer below lg. */
const GroupedSidebarPanel = ({
  model,
  selectors,
}: {
  readonly model: ShellNavigationModel;
  readonly selectors: ReactNode;
}) => {
  const { t } = useModernI18n();
  return (
    <Sidebar.Panel aria-label={t('shell.dashboard.sidebar.label')} side="start">
      <Sidebar.Content>
        <div className="flex justify-end">
          <Sidebar.CloseTrigger aria-label={t('shell.dashboard.navigation.close')} />
        </div>
        <nav aria-label={t('shell.dashboard.navigation.label')} className="grid gap-150">
          <Sidebar.Menu>
            <Sidebar.Item>
              <DashboardNavigationLink collapsedSide link={model.home} />
            </Sidebar.Item>
          </Sidebar.Menu>
          {model.groups.map((group) => (
            <Sidebar.Group key={group.key}>
              <Sidebar.Expanded>
                <Sidebar.GroupLabel>{group.label}</Sidebar.GroupLabel>
              </Sidebar.Expanded>
              <Sidebar.GroupContent>
                <Sidebar.Menu>
                  {group.links.map((link) => (
                    <Sidebar.Item key={link.key}>
                      <DashboardNavigationLink collapsedSide link={link} />
                    </Sidebar.Item>
                  ))}
                </Sidebar.Menu>
              </Sidebar.GroupContent>
            </Sidebar.Group>
          ))}
        </nav>
      </Sidebar.Content>
      <Sidebar.Footer>
        <Sidebar.Expanded>{selectors}</Sidebar.Expanded>
      </Sidebar.Footer>
    </Sidebar.Panel>
  );
};

const sidebarStorageKey = 'ontos.shell.sidebar';
const sidebarChoiceEvent = 'ontos:shell-sidebar-choice';
const expandedSidesByDefault: readonly SidebarSide[] = ['start'];
const collapsedSides: readonly SidebarSide[] = [];

// Same-tab writes notify through a window event; other tabs arrive through the native storage event.
const subscribeSidebarChoice = (listener: () => void) => {
  window.addEventListener(sidebarChoiceEvent, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(sidebarChoiceEvent, listener);
    window.removeEventListener('storage', listener);
  };
};
const readSidebarCollapsed = () => window.localStorage.getItem(sidebarStorageKey) === 'collapsed';
const serverSidebarCollapsed = () => false;
const writeSidebarCollapsed = (next: boolean) => {
  window.localStorage.setItem(sidebarStorageKey, next ? 'collapsed' : 'expanded');
  window.dispatchEvent(new Event(sidebarChoiceEvent));
};
const handleSidebarExpandedChange = ({ expanded }: SidebarExpandedChangeDetails) => {
  writeSidebarCollapsed(!expanded.includes('start'));
};

type SidebarOffsetStyle = CSSProperties & {
  '--height-sidebar-viewport'?: string;
  '--spacing-sidebar-offset'?: string;
};
/**
 * The kit derives `--height-sidebar-viewport` from the offset at `:root`, so an offset set on the root element alone
 * leaves the panel a full viewport tall below the top bar and clips its footer. Re-derive both on the frame.
 */
const topBarOffsetStyle: SidebarOffsetStyle = {
  '--height-sidebar-viewport': 'calc(100dvh - var(--spacing-700))',
  '--spacing-sidebar-offset': 'var(--spacing-700)',
};

/**
 * Akros admin frame: a compact full-width top bar (brand, search, current trail, account) above a collapsible,
 * grouped navigation Sidebar. Below the Sidebar breakpoint the same panel opens as a drawer from the top bar.
 * Routed content renders in `<main>` with token spacing and no max width, so dense tables use the full column.
 */
export const AuthenticatedDashboardLayout = (props: AuthenticatedDashboardLayoutProps) => {
  const { language, t } = useModernI18n();
  const [searchValue, setSearchValue] = useState('');
  const { tenantSwitchFailed } = props;
  const pendingPath = usePendingNavigationPath();
  const pendingHref = pendingPath === undefined ? undefined : navigationHrefFromPath(pendingPath, language ?? '');
  const model = buildShellNavigation({ ...props, pendingHref }, t);

  useEffect(() => {
    if (tenantSwitchFailed) {
      document.querySelector('#tenant-switch-status')?.scrollIntoView({ block: 'nearest' });
    }
  }, [tenantSwitchFailed]);

  // The server renders expanded; the saved choice is read on the client without an effect-driven state copy.
  const collapsed = useSyncExternalStore(subscribeSidebarChoice, readSidebarCollapsed, serverSidebarCollapsed);
  const expandedSides = collapsed ? collapsedSides : expandedSidesByDefault;

  return (
    <>
      {props.compositionRevision === undefined ? null : (
        <meta content={props.compositionRevision} name="ontos-composition-revision" />
      )}
      <Sidebar
        className="min-h-dvh flex-col overflow-x-clip bg-base text-fg-primary"
        collapsible={{ start: 'icon' }}
        expanded={expandedSides}
        onExpandedChange={handleSidebarExpandedChange}
        style={topBarOffsetStyle}
      >
        <Header
          aria-label={t('shell.dashboard.header.label')}
          className="sticky top-0 z-20 w-full max-w-none gap-200 border-border-primary border-b bg-base px-200"
          size="sm"
          style={{ height: 'var(--spacing-700)' }}
        >
          <Header.Container className="flex w-auto min-w-0 flex-1 flex-nowrap items-center gap-200" position="start">
            <Sidebar.Trigger aria-label={t(navigationToggleKey)} side="start" tooltip={t(navigationToggleKey)} />
            {/* The brand is not a navigation item: the router would mark it current on every page. */}
            <LocalizedLink aria-current={false} className="hidden no-underline md:flex" prefetch="intent" to="/">
              <DashboardBrand />
            </LocalizedLink>
            <div className="min-w-0 max-w-md flex-1">
              <DashboardSearch onSearch={props.onSearch} onValueChange={setSearchValue} value={searchValue} />
            </div>
            <DashboardTrail model={model} />
          </Header.Container>
          <Header.Container className="ms-auto w-auto shrink-0" position="end">
            <Header.Actions>
              <Header.ActionItem>
                <DashboardAccountMenu
                  identity={props.identity}
                  logoutPending={props.logoutPending}
                  onLogout={props.onLogout}
                />
              </Header.ActionItem>
            </Header.Actions>
          </Header.Container>
        </Header>
        <div className="flex min-h-0 flex-1">
          <GroupedSidebarPanel
            model={model}
            selectors={
              <DashboardContextSelectors
                currentTenantId={props.currentTenantId}
                legalEntityChoices={props.legalEntityChoices}
                legalEntityState={props.legalEntityState}
                legalEntitySwitchFailed={props.legalEntitySwitchFailed}
                legalEntitySwitchPending={props.legalEntitySwitchPending}
                onLegalEntityChange={props.onLegalEntityChange}
                onTenantChange={props.onTenantChange}
                tenantChoices={props.tenantChoices}
                tenantState={props.tenantState}
                tenantSwitchFailed={props.tenantSwitchFailed}
                tenantSwitchPending={props.tenantSwitchPending}
                {...(props.currentLegalEntityId === undefined
                  ? {}
                  : { currentLegalEntityId: props.currentLegalEntityId })}
              />
            }
          />
          <Sidebar.Inset className="flex min-w-0 flex-1 flex-col">
            <div className="isolate flex min-w-0 flex-1 flex-col gap-250 p-250">
              {pendingHref === undefined ? null : (
                <StatusText aria-live="polite" showIcon status="default">
                  {t('shell.dashboard.navigation.pending')}
                </StatusText>
              )}
              {/* The router keeps the previous page until the next one loads; hide it instead of showing it under
                  the new URL, but keep it mounted so a cancelled navigation returns to it intact. */}
              <div className={pendingHref === undefined ? 'contents' : 'hidden'}>
                {props.title === undefined ? null : <h1 className="font-semibold text-xl">{props.title}</h1>}
                {props.children}
              </div>
            </div>
          </Sidebar.Inset>
        </div>
      </Sidebar>
    </>
  );
};
