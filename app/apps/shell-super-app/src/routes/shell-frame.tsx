import { Helmet } from '@modern-js/runtime/head';
import { Link as LocalizedLink, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useNavigate, useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Icon } from '@techsio/ui-kit/atoms/icon';
import type { IconType } from '@techsio/ui-kit/atoms/icon';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Tooltip } from '@techsio/ui-kit/atoms/tooltip';
import { Menu } from '@techsio/ui-kit/molecules/menu';
import type { MenuItem } from '@techsio/ui-kit/molecules/menu';
import { Select } from '@techsio/ui-kit/molecules/select';
import type { SelectItem } from '@techsio/ui-kit/molecules/select';
import { Header } from '@techsio/ui-kit/organisms/header';
import { Sidebar } from '@techsio/ui-kit/organisms/sidebar';
import type { SidebarExpandedChangeDetails, SidebarSide } from '@techsio/ui-kit/organisms/sidebar';
import { useEffect, useEffectEvent, useSyncExternalStore } from 'react';
import type { ComponentProps, CSSProperties, ReactNode } from 'react';

import type { ShellLabel, ShellUnavailableDeployment } from '../../shared/api.ts';
import { DemoGuidePanel, DemoGuideToggleButton, demoGuidePageAttribute } from '../demo-guide/demo-guide-panel.tsx';
import { demoGuideFor } from '../demo-guide/demo-guide-registry.ts';
import { guideWidthCss, useDemoGuideOpen, useDemoGuideWidth } from '../demo-guide/demo-guide-store.ts';
import { navigationHrefFromPath, usePendingNavigationPath } from './use-pending-navigation.ts';
import { useIdleRoutePreload } from './use-idle-route-preload.ts';

interface DashboardAccount {
  readonly displayName: string;
  /** Sign-in e-mail; the demo guide marks steps whose persona is already signed in. */
  readonly email?: string;
}

interface DashboardNavigationItem {
  /** Deployment of the destination; also the gateway audience of its module API. */
  readonly appId?: string;
  readonly enabled: boolean;
  readonly entrypointKey: string;
  /** Shell navigation section the module places the destination in. */
  readonly groupKey: string;
  readonly homeStart?: number | undefined;
  readonly href?: string;
  readonly icon: IconType;
  readonly label: ShellLabel;
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
  readonly onTenantContextChange?: (() => void) | undefined;
  readonly tenantChoices: readonly DashboardTenantItem[];
  readonly tenantContextActive?: boolean | undefined;
  readonly tenantContextAvailable?: boolean | undefined;
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

interface NavigationSection {
  readonly groupKey: string;
  readonly icon: IconType;
  /** Translation key below `shell.dashboard.navigation.groups`. */
  readonly key: string;
}

/**
 * Sidebar sections by functional area, in order. Modules place each destination in one by its navigation `groupKey`
 * and bring its label, icon and order; destinations of an unknown section are listed under „Další moduly“.
 */
export const navigationSections: readonly NavigationSection[] = [
  { groupKey: 'shell.navigation.real-estate', icon: 'icon-[mdi--home-city-outline]', key: 'realEstate' },
  { groupKey: 'shell.navigation.facility', icon: 'icon-[mdi--cog-transfer-outline]', key: 'facility' },
  { groupKey: 'shell.navigation.finance', icon: 'icon-[mdi--cash-multiple]', key: 'finance' },
  { groupKey: 'shell.navigation.sales', icon: 'icon-[mdi--handshake-outline]', key: 'sales' },
  { groupKey: 'shell.navigation.commerce', icon: 'icon-[mdi--storefront-outline]', key: 'commerce' },
  { groupKey: 'shell.navigation.team', icon: 'icon-[mdi--account-multiple-check-outline]', key: 'team' },
  { groupKey: 'shell.navigation.settings', icon: 'icon-[mdi--tune-variant]', key: 'settings' },
];

export interface ShellNavigationLink {
  readonly current: boolean;
  readonly enabled: boolean;
  /** Rank as the place to begin on Home (lower first); absent when the destination is no starting point. */
  readonly homeStart?: number | undefined;
  readonly href: string | null;
  readonly icon: IconType;
  readonly key: string;
  readonly label: string;
  /** Typed reason text when the destination cannot be opened. */
  readonly notice: string | null;
  readonly state: DashboardNavigationItem['state'];
}

export interface ShellNavigationGroup {
  readonly icon: IconType;
  readonly key: string;
  readonly label: string;
  readonly links: readonly ShellNavigationLink[];
}

export interface ShellNavigationModel {
  readonly current: { readonly group: ShellNavigationGroup; readonly link: ShellNavigationLink } | undefined;
  readonly groups: readonly ShellNavigationGroup[];
  readonly home: ShellNavigationLink;
}

type Translate = (key: string) => string;

/**
 * LinkButton always forwards `href`; the localized router link derives it from `to`, so drop the empty one.
 * Preload on user intent, not viewport visibility: opening one page must not compete with every sidebar
 * destination's owner reads. Idle warming handles the remaining menu after the current page has settled.
 */
export const ShellRouteLink = ({
  href: _unusedHref,
  ...props
}: ComponentProps<typeof LocalizedLink> & { readonly href?: string | undefined }) => (
  // Router-active styling matches a destination only when the location equals it. Without `exact`, the home link
  // ("/") counts as active on every page and is marked as the current page beside the real destination.
  <LocalizedLink activeOptions={{ exact: true }} prefetch="intent" {...props} />
);

const entryNotice = (entry: DashboardNavigationItem, t: Translate): string | null =>
  entry.unavailable ? t('shell.modules.unavailable') : null;

/** How a destination relates to the rendered page: its own entrypoint, or only the same module. */
type MatchedNavigationLink = Omit<ShellNavigationLink, 'current'> & {
  readonly entrypointMatch: boolean;
  readonly moduleMatch: boolean;
};

const navigationLink = (
  entry: DashboardNavigationItem,
  language: string,
  matches: Pick<MatchedNavigationLink, 'entrypointMatch' | 'moduleMatch'>,
  t: Translate,
): MatchedNavigationLink => ({
  enabled: entry.enabled && entry.href !== undefined,
  ...matches,
  homeStart: entry.homeStart,
  href: entry.href ?? null,
  icon: entry.icon,
  key: `${entry.entrypointKey}:${entry.href ?? ''}`,
  label: language === 'en' ? entry.label.en : entry.label.cs,
  notice: entryNotice(entry, t),
  state: entry.state,
});

export const buildShellNavigation = (
  props: Pick<
    AuthenticatedDashboardLayoutProps,
    'currentEntrypointKey' | 'currentModuleId' | 'homeCurrent' | 'navigation' | 'unavailableDeployments'
  > & {
    /** Page language; module-declared labels are shown in it. */
    readonly language: string;
    /** Destination href of a navigation whose page is still loading; it alone is current until the page settles. */
    readonly pendingHref?: string | undefined;
  },
  t: Translate,
): ShellNavigationModel => {
  const { currentEntrypointKey, currentModuleId, homeCurrent = true, language, pendingHref } = props;
  // The composition lists only destinations the principal may open, in module order: a role never sees a menu item
  // it cannot open, and a section without destinations is not shown.
  const visible = props.navigation;
  const known = new Set(navigationSections.map(({ groupKey }) => groupKey));
  const soleModuleEntry = (entry: DashboardNavigationItem) =>
    visible.filter((candidate) => candidate.moduleId === entry.moduleId).length === 1;
  const linkOf = (entry: DashboardNavigationItem) =>
    navigationLink(
      entry,
      language,
      {
        entrypointMatch: currentEntrypointKey !== undefined && entry.entrypointKey === currentEntrypointKey,
        moduleMatch: currentModuleId !== undefined && currentModuleId === entry.moduleId && soleModuleEntry(entry),
      },
      t,
    );
  const sectionGroups = navigationSections.flatMap((section) => {
    const links = visible.flatMap((entry) => (entry.groupKey === section.groupKey ? [linkOf(entry)] : []));
    return links.length === 0
      ? []
      : [
          {
            icon: section.icon,
            key: section.key,
            label: t(`shell.dashboard.navigation.groups.${section.key}`),
            links,
          },
        ];
  });

  const otherLinks = visible.flatMap((entry) => (known.has(entry.groupKey) ? [] : [linkOf(entry)]));
  const deploymentLinks = props.unavailableDeployments.map((deployment): MatchedNavigationLink => ({
    enabled: false,
    entrypointMatch: false,
    href: null,
    icon: 'icon-[mdi--cloud-off-outline]',
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
  const candidates = otherGroup.links.length === 0 ? sectionGroups : [...sectionGroups, otherGroup];
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
  | 'tenantContextActive'
  | 'tenantContextAvailable'
  | 'onTenantContextChange'
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
  if (props.tenantContextAvailable === true) {
    const tenantContextLabel = t('shell.dashboard.legalEntity.tenantContext');
    legalEntityItems.unshift({ displayValue: tenantContextLabel, label: tenantContextLabel, value: 'tenant' });
  }
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
        currentValue={props.tenantContextActive === true ? 'tenant' : props.currentLegalEntityId}
        disabled={legalEntityUnavailable || props.legalEntitySwitchPending}
        items={legalEntityItems}
        label={t('shell.dashboard.legalEntity.accessibleLabel')}
        name="legalEntity"
        onChange={(value) => {
          if (value === 'tenant') {
            props.onTenantContextChange?.();
          } else {
            props.onLegalEntityChange(value);
          }
        }}
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

const DashboardAccountMenu = ({
  identity,
  logoutPending,
  onLogout,
}: Pick<AuthenticatedDashboardLayoutProps, 'identity' | 'logoutPending' | 'onLogout'>) => {
  const { language, t } = useModernI18n();
  const accountItems: MenuItem[] = [
    {
      icon: 'icon-[mdi--account-cog-outline]',
      label: t('shell.profile.menu'),
      type: 'action',
      value: 'profile',
    },
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
        if (action === 'profile') {
          globalThis.location.assign(language === 'en' ? '/en/profile' : '/cs/profil');
        }
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
      </span>
    );
  const content =
    badge === null && link.notice === null ? (
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
          // The label sits close to the rail and closes as soon as the pointer leaves the icon, so it covers as
          // little of the page as possible.
          <Tooltip
            closeDelay={0}
            content={link.label}
            interactive={false}
            offset={{ crossAxis: 0, mainAxis: 8 }}
            placement="right"
            size="sm"
          >
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

/** Mounted once per route (keyed by pathname): closes the drawer when the route it was mounted for appears. */
const CloseDrawerOnMount = ({ onClose }: { readonly onClose: () => void }) => {
  const closeDrawer = useEffectEvent(() => onClose());
  useEffect(() => {
    closeDrawer();
  }, []);
  return null;
};

/**
 * The link's own click closes the drawer, but a click can be lost while the drawer slides in. Every route change
 * closes it as well, so a drawer never stays over the page the user just chose.
 */
const DrawerRouteSync = () => {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <Sidebar.Context>
      {(sidebar) => <CloseDrawerOnMount key={pathname} onClose={() => sidebar.closeMobile()} />}
    </Sidebar.Context>
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
  '--demo-guide-width'?: string;
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
  const { tenantSwitchFailed } = props;
  const pendingPath = usePendingNavigationPath();
  const pageLanguage = language ?? '';
  const pendingHref = pendingPath === undefined ? undefined : navigationHrefFromPath(pendingPath, pageLanguage);
  const model = buildShellNavigation({ ...props, language: pageLanguage, pendingHref }, t);
  useIdleRoutePreload(props.navigation, props.compositionRevision);

  // Back after sign-out or a tenant switch can restore this page from the back/forward cache with the old session's
  // navigation on screen. Hide it before the browser paints and load the document again, so the server decides.
  const navigate = useNavigate();
  const reloadDocument = useEffectEvent(() => {
    void navigate({ reloadDocument: true, to: '.' });
  });
  useEffect(() => {
    const reloadRestoredPage = (event: PageTransitionEvent) => {
      if (event.persisted) {
        document.documentElement.style.visibility = 'hidden';
        reloadDocument();
      }
    };
    window.addEventListener('pageshow', reloadRestoredPage);
    return () => window.removeEventListener('pageshow', reloadRestoredPage);
  }, []);

  useEffect(() => {
    if (tenantSwitchFailed) {
      document.querySelector('#tenant-switch-status')?.scrollIntoView({ block: 'nearest' });
    }
  }, [tenantSwitchFailed]);

  // The server renders expanded; the saved choice is read on the client without an effect-driven state copy.
  const collapsed = useSyncExternalStore(subscribeSidebarChoice, readSidebarCollapsed, serverSidebarCollapsed);
  const expandedSides = collapsed ? collapsedSides : expandedSidesByDefault;

  // Demo guide of the selected company: open state and width live in browser storage, so the panel stays open
  // while the presenter moves between pages (each route mounts its own frame).
  const guide = demoGuideFor(props.currentLegalEntityId);
  const guideOpen = useDemoGuideOpen();
  const guideWidth = useDemoGuideWidth();
  const guideVisible = guide !== undefined && guideOpen && !props.logoutPending;
  // The saved width is re-fitted to the current screen by CSS, next to the expanded or icon-only sidebar.
  const sidebarStyle: SidebarOffsetStyle = {
    ...topBarOffsetStyle,
    '--demo-guide-width': guideWidthCss(
      guideWidth,
      collapsed ? 'var(--width-sidebar-icon)' : 'var(--width-sidebar-expanded)',
    ),
  };

  return (
    <>
      <Helmet>
        <title>{`${props.title ?? model.current?.link.label ?? t('shell.dashboard.home.title')} | OntOS`}</title>
      </Helmet>
      {props.compositionRevision === undefined ? null : (
        <meta content={props.compositionRevision} name="ontos-composition-revision" />
      )}
      <Sidebar
        className="min-h-dvh flex-col overflow-x-clip bg-base text-fg-primary"
        collapsible={{ start: 'icon' }}
        expanded={expandedSides}
        onExpandedChange={handleSidebarExpandedChange}
        style={sidebarStyle}
      >
        <DrawerRouteSync />
        <Header
          aria-label={t('shell.dashboard.header.label')}
          className="sticky top-0 z-20 w-full max-w-none gap-200 border-border-primary border-b bg-base px-200"
          size="sm"
          style={{ height: 'var(--spacing-700)' }}
        >
          <Header.Container className="flex w-auto min-w-0 flex-1 flex-nowrap items-center gap-200" position="start">
            {/* Once sign-out has started, navigation, search and the page are hidden; only the account stays. */}
            {props.logoutPending ? null : (
              <Sidebar.Trigger aria-label={t(navigationToggleKey)} side="start" tooltip={t(navigationToggleKey)} />
            )}
            {/* The brand is not a navigation item: the router would mark it current on every page. */}
            <LocalizedLink aria-current={false} className="hidden no-underline md:flex" prefetch="intent" to="/">
              <DashboardBrand />
            </LocalizedLink>
            {/* Search lives in each governed agenda; do not advertise an unavailable global provider. */}
            {props.logoutPending ? null : <DashboardTrail model={model} />}
          </Header.Container>
          <Header.Container className="ms-auto w-auto shrink-0" position="end">
            <Header.Actions>
              {guide === undefined || props.logoutPending ? null : (
                <Header.ActionItem>
                  <DemoGuideToggleButton open={guideOpen} />
                </Header.ActionItem>
              )}
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
        <div className={props.logoutPending ? 'hidden' : 'flex min-h-0 flex-1'}>
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
                onTenantContextChange={props.onTenantContextChange}
                tenantChoices={props.tenantChoices}
                tenantContextActive={props.tenantContextActive}
                tenantContextAvailable={props.tenantContextAvailable}
                tenantState={props.tenantState}
                tenantSwitchFailed={props.tenantSwitchFailed}
                tenantSwitchPending={props.tenantSwitchPending}
                {...(props.currentLegalEntityId === undefined
                  ? {}
                  : { currentLegalEntityId: props.currentLegalEntityId })}
              />
            }
          />
          {/* On desktop the open guide docks beside the page instead of covering it. */}
          <Sidebar.Inset
            {...{ [demoGuidePageAttribute]: '' }}
            className={`relative flex min-w-0 flex-1 flex-col ${guideVisible ? 'lg:pe-(--demo-guide-width)' : ''}`}
          >
            {/* The router keeps the previous page visible until the next one is prepared (code and data); a thin bar
                shows a navigation that takes longer than a moment. */}
            {pendingHref === undefined ? null : (
              <div className="shell-navigation-progress">
                <progress aria-label={t('shell.dashboard.navigation.pending')} className="sr-only" />
              </div>
            )}
            <div aria-busy={pendingHref !== undefined} className="isolate flex min-w-0 flex-1 flex-col gap-250 p-250">
              {props.title === undefined ? null : <h1 className="font-semibold text-xl">{props.title}</h1>}
              {props.children}
            </div>
          </Sidebar.Inset>
        </div>
        {guideVisible ? <DemoGuidePanel guide={guide} identityEmail={props.identity.email} /> : null}
      </Sidebar>
    </>
  );
};
