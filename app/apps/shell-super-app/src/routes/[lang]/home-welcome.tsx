import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Icon } from '@techsio/ui-kit/atoms/icon';
import type { IconType } from '@techsio/ui-kit/atoms/icon';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';

import type { ShellUnavailableDeployment } from '../../../shared/api.ts';
import { buildShellNavigation, ShellRouteLink } from '../shell-frame';
import type { AuthenticatedDashboardLayoutProps, ShellNavigationLink } from '../shell-frame';

/** Company profile shown on Home, keyed by the last three digits of the demo legal entity id. */
const companyProfiles: Readonly<Record<string, { readonly icon: IconType; readonly key: string }>> = {
  '020': { icon: 'icon-[mdi--storefront-outline]', key: 'trading' },
  '021': { icon: 'icon-[mdi--home-city-outline]', key: 'siampark' },
  '022': { icon: 'icon-[mdi--account-group-outline]', key: 'crm' },
  '023': { icon: 'icon-[mdi--coffee-outline]', key: 'eshop' },
};

/** The destination each kind of work usually starts from; the first one the persona can open is offered. */
const preferredStart = [
  'crmPlan',
  'crmClients',
  'opsOverview',
  'occupancy',
  'invoices',
  'orders',
  'opsAgenda',
  'opportunities',
  'tasks',
  'products',
] as const;

const groupDescriptionKeys = new Set(['crm', 'insights', 'operations', 'sales', 'settings', 'siamparkOps']);

export interface HomeWelcomeProps {
  readonly companyName: string | undefined;
  readonly displayName: string;
  readonly legalEntityId: string | undefined;
  readonly navigation: AuthenticatedDashboardLayoutProps['navigation'];
  readonly unavailableDeployments: readonly ShellUnavailableDeployment[];
}

const DestinationRow = ({ link }: { readonly link: ShellNavigationLink }) =>
  link.href === null || !link.enabled ? null : (
    <li>
      <LinkButton
        as={ShellRouteLink}
        block
        className="justify-start hover:bg-overlay"
        icon={link.icon}
        size="sm"
        theme="unstyled"
        to={link.href}
        variant="secondary"
      >
        <span className="min-w-0 flex-1 truncate text-start">{link.label}</span>
        <Icon className="text-fg-secondary" icon="icon-[mdi--chevron-right]" size="sm" />
      </LinkButton>
    </li>
  );

/** Home for personas without a module Home component: who and where I am, where to start, and every area I can open. */
export const HomeWelcome = ({
  companyName,
  displayName,
  legalEntityId,
  navigation,
  unavailableDeployments,
}: HomeWelcomeProps) => {
  const { t } = useModernI18n();
  const model = buildShellNavigation({ homeCurrent: true, navigation, unavailableDeployments }, t);
  const groups = model.groups
    .map((group) => ({ ...group, links: group.links.filter((link) => link.enabled && link.href !== null) }))
    .filter((group) => group.links.length > 0);
  const links = groups.flatMap((group) => group.links);
  const start =
    preferredStart.map((key) => links.find((link) => link.key === key)).find((link) => link !== undefined) ?? links[0];
  const profile = companyProfiles[legalEntityId?.slice(-3) ?? ''];

  return (
    <div className="grid w-full max-w-5xl gap-300">
      <section className="ontos-tile rounded-lg bg-surface [&_.ontos-tile]:bg-base flex flex-col gap-250 p-300 md:flex-row md:items-center">
        <span className="flex size-icon-control-lg shrink-0 items-center justify-center rounded-md bg-primary text-fg-primary">
          <Icon icon={profile?.icon ?? 'icon-[mdi--hexagon-multiple-outline]'} size="md" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-100">
          <div className="flex flex-wrap items-center gap-100">
            <span className="text-fg-secondary text-xs uppercase tracking-wide">
              {t('shell.dashboard.home.welcomeKicker')}
            </span>
            {companyName === undefined ? null : (
              <Badge size="sm" variant="outline">
                {companyName}
              </Badge>
            )}
          </div>
          <h2 className="font-semibold text-fg-primary text-xl">{t('shell.dashboard.home.welcomeTitle')}</h2>
          <p className="text-fg-secondary text-sm">{displayName}</p>
          <p className="text-fg-secondary text-sm">
            {profile === undefined
              ? t('shell.dashboard.home.welcomeHint')
              : t(`shell.dashboard.home.company.${profile.key}`)}
          </p>
        </div>
        {start?.href === undefined || start.href === null ? null : (
          <LinkButton
            as={ShellRouteLink}
            className="shrink-0"
            icon={start.icon}
            size="md"
            theme="solid"
            to={start.href}
            variant="primary"
          >
            {t('shell.dashboard.home.start', { destination: start.label })}
          </LinkButton>
        )}
      </section>
      {groups.length === 0 ? (
        <p className="text-fg-secondary text-sm">{t('shell.dashboard.home.noAreas')}</p>
      ) : (
        <section aria-label={t('shell.dashboard.home.areas')} className="grid gap-200">
          <h3 className="font-semibold text-fg-primary text-md">{t('shell.dashboard.home.areas')}</h3>
          <div className="grid gap-200 md:grid-cols-2 xl:grid-cols-3">
            {groups.map((group) => (
              <article
                className="ontos-card rounded-lg border border-border-primary/60 bg-base [&_.ontos-card]:border-0 [&_.ontos-card]:bg-transparent [&_.ontos-card]:p-0 flex flex-col gap-150 p-250"
                key={group.key}
              >
                <header className="flex items-start gap-150">
                  <span className="flex size-icon-control-md shrink-0 items-center justify-center rounded-md bg-surface text-fg-primary">
                    <Icon icon={group.icon} size="sm" />
                  </span>
                  <div className="flex min-w-0 flex-col">
                    <span className="font-semibold text-fg-primary text-sm">{group.label}</span>
                    {groupDescriptionKeys.has(group.key) ? (
                      <span className="text-fg-secondary text-xs">
                        {t(`shell.dashboard.home.groupHints.${group.key}`)}
                      </span>
                    ) : null}
                  </div>
                </header>
                <ul className="grid gap-50">
                  {group.links.map((link) => (
                    <DestinationRow key={link.key} link={link} />
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
