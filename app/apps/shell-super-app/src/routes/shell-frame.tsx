import { ChoiceField, FormBuilder, FormReact, FormRoot, useAtomSet, useAtomSubscribe } from '@app/core-runtime/ui/form';
import { Link as LocalizedLink, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Menu } from '@techsio/ui-kit/molecules/menu';
import type { MenuItem } from '@techsio/ui-kit/molecules/menu';
import { SearchForm } from '@techsio/ui-kit/molecules/search-form';
import { Header } from '@techsio/ui-kit/organisms/header';
import { Effect, Schema } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import type { Atom } from 'effect/reactivity';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { ShellUnavailableDeployment } from '../../shared/browser-api.ts';
import { browserAtomRuntime } from '../runtime/browser-effect-runtime.ts';
import { useHydrated } from './use-hydrated.ts';

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

/** The access administration pages in navigation order. */
const AccessAdministrationPageSchema = Schema.Literals(['roles', 'people', 'changes', 'approvals', 'why']);
export type AccessAdministrationPage = typeof AccessAdministrationPageSchema.Type;

export interface AuthenticatedDashboardLayoutProps {
  readonly children: ReactNode;
  readonly compositionRevision?: string;
  readonly currentAccessPage?: AccessAdministrationPage;
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

/**
 * A one-field switch form per session choice: picking another value submits it at once, and the
 * Shell controls switch the session to it. The form shows the session's choice again whenever a
 * switch starts or settles.
 */
const tenantSwitchForm = FormReact.make(FormBuilder.empty.addField('tenantId', Schema.String), {
  fields: { tenantId: ChoiceField },
  mode: { autoSubmit: true, validation: 'onChange' },
  onSubmit: (_submit, { decoded }) => Effect.succeed(decoded.tenantId),
  runtime: browserAtomRuntime,
});

const legalEntitySwitchForm = FormReact.make(FormBuilder.empty.addField('legalEntityId', Schema.String), {
  fields: { legalEntityId: ChoiceField },
  mode: { autoSubmit: true, validation: 'onChange' },
  onSubmit: (_submit, { decoded }) => Effect.succeed(decoded.legalEntityId),
  runtime: browserAtomRuntime,
});

/** Hands a submitted choice to the Shell controls, unless it is the session's current one. */
const useSwitchOnSubmit = (
  submit: Atom.Atom<AsyncResult.AsyncResult<string, unknown>>,
  currentValue: string | undefined,
  onChange: (value: string) => void,
) =>
  useAtomSubscribe(submit, (result) => {
    if (AsyncResult.isSuccess(result) && !result.waiting && result.value !== '' && result.value !== currentValue) {
      onChange(result.value);
    }
  });

const SelectorStatus = ({
  id,
  status,
  text,
}: {
  readonly id: string;
  readonly status: 'default' | 'error' | 'warning';
  readonly text: string | null;
}) =>
  text === null ? null : (
    <StatusText aria-live="polite" id={id} showIcon status={status}>
      {text}
    </StatusText>
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
  const tenantItems = tenantChoices.map(({ name, tenantId }) => ({ label: name, value: tenantId }));
  const tenantUnavailable = tenantState === 'unavailable';
  const unavailableText = t('shell.dashboard.tenant.unavailable');
  const statusId = 'tenant-switch-status';
  const statusText = selectorStatusText(tenantSwitchPending, tenantSwitchFailed, tenantUnavailable, {
    failed: t('shell.dashboard.tenant.failed'),
    pending: t('shell.dashboard.tenant.pending'),
    unavailable: unavailableText,
  });
  useSwitchOnSubmit(tenantSwitchForm.submit, currentTenantId, onTenantChange);
  const showTenant = useAtomSet(tenantSwitchForm.setValues);
  // The form stays mounted, so the sidebar keeps its layout and scroll position; once a switch
  // settles, the select shows the session's tenant again.
  useEffect(() => {
    if (!tenantSwitchPending) {
      showTenant({ tenantId: currentTenantId });
    }
  }, [currentTenantId, showTenant, tenantSwitchPending]);

  return (
    <FormRoot
      defaultValues={{ tenantId: currentTenantId }}
      form={tenantSwitchForm}
      translateMessage={(message) => t(message, { defaultValue: t('shell.dashboard.tenant.failed') })}
    >
      <tenantSwitchForm.tenantId
        describedBy={statusText === null ? undefined : statusId}
        disabled={
          tenantUnavailable || tenantSwitchPending || !tenantItems.some((item) => item.value !== currentTenantId)
        }
        invalid={tenantSwitchFailed}
        items={tenantItems}
        label={t('shell.dashboard.tenant.accessibleLabel')}
        placeholder={unavailableText}
      />
      <SelectorStatus id={statusId} status={selectorStatus(tenantSwitchFailed, tenantUnavailable)} text={statusText} />
    </FormRoot>
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
    label: legalName,
    value: legalEntityId,
  }));
  const legalEntityUnavailable = legalEntityState === 'unavailable';
  const statusId = 'legal-entity-switch-status';
  const statusText = selectorStatusText(legalEntitySwitchPending, legalEntitySwitchFailed, legalEntityUnavailable, {
    failed: t('shell.dashboard.legalEntity.failed'),
    pending: t('shell.dashboard.legalEntity.pending'),
    unavailable: t('shell.dashboard.legalEntity.unavailable'),
  });
  useSwitchOnSubmit(legalEntitySwitchForm.submit, currentLegalEntityId, onLegalEntityChange);
  const showLegalEntity = useAtomSet(legalEntitySwitchForm.setValues);
  useEffect(() => {
    if (!legalEntitySwitchPending) {
      showLegalEntity({ legalEntityId: currentLegalEntityId ?? '' });
    }
  }, [currentLegalEntityId, legalEntitySwitchPending, showLegalEntity]);

  return (
    <FormRoot
      defaultValues={{ legalEntityId: currentLegalEntityId ?? '' }}
      form={legalEntitySwitchForm}
      translateMessage={(message) => t(message, { defaultValue: t('shell.dashboard.legalEntity.failed') })}
    >
      <legalEntitySwitchForm.legalEntityId
        describedBy={statusText === null ? undefined : statusId}
        disabled={legalEntityUnavailable || legalEntitySwitchPending}
        invalid={legalEntitySwitchFailed}
        items={legalEntityItems}
        label={t('shell.dashboard.legalEntity.accessibleLabel')}
        placeholder={t('shell.dashboard.legalEntity.placeholder')}
      />
      <SelectorStatus
        id={statusId}
        status={selectorStatus(legalEntitySwitchFailed, legalEntityUnavailable)}
        text={statusText}
      />
    </FormRoot>
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

const DashboardModuleNavigationItem = ({ currentModuleId, module }: DashboardModuleNavigationItemProps) => {
  const { t } = useModernI18n();

  return (
    <li className="flex flex-wrap items-center gap-150">
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
        <Badge severity="warning" size="sm">
          {t('shell.modules.state.readOnly')}
        </Badge>
      ) : null}
      {module.state === 'deprecated' ? (
        <Badge severity="warning" size="sm">
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
    <li className="flex flex-wrap items-center gap-150">
      <span>{deployment.appId}</span>
      <StatusText showIcon size="sm" status="warning">
        {t(`shell.modules.discovery.${deployment.status === 'unavailable' ? deployment.reason : deployment.status}`)}
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
      <ul className="flex flex-col gap-150">
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
          <DashboardModuleNavigationItem currentModuleId={currentModuleId} key={module.moduleId} module={module} />
        ))}
        {unavailableDeployments.map((deployment) => (
          <DashboardDeploymentNavigationItem deployment={deployment} key={deployment.appId} />
        ))}
      </ul>
    </nav>
  );
};

/** Access administration is tenant work, so it is offered whether or not a company is selected. */
const AccessAdministrationNavigation = ({
  currentPage,
}: {
  readonly currentPage: AccessAdministrationPage | undefined;
}) => {
  const { t } = useModernI18n();
  const label = t('shell.accessAdmin.accessible.navigation');

  return (
    <section aria-label={label} className="flex flex-col gap-150">
      <p>{t('shell.accessAdmin.navigation.label')}</p>
      <nav aria-label={label}>
        <ul className="flex flex-col gap-150">
          {AccessAdministrationPageSchema.literals.map((page) => (
            <li key={page}>
              <Link aria-current={currentPage === page ? 'page' : undefined} as={LocalizedLink} to={`/access/${page}`}>
                {t(`shell.accessAdmin.navigation.${page}`)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </section>
  );
};

const DashboardHeader = ({ identity, logoutPending, onLogout, title }: DashboardHeaderProps) => {
  const { t } = useModernI18n();
  const hydrated = useHydrated();
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
          <Header.ActionItem data-hydrated={hydrated || undefined}>
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
    <div className="flex min-h-screen min-w-0 flex-col overflow-x-hidden bg-base text-fg-primary md:flex-row">
      {props.compositionRevision === undefined ? null : (
        <meta content={props.compositionRevision} name="ontos-composition-revision" />
      )}
      <aside
        aria-label={t('shell.dashboard.sidebar.label')}
        className="flex max-h-screen w-full shrink-0 flex-col gap-150 overflow-y-auto bg-surface p-200 md:max-h-none md:w-3xs md:gap-300 md:overflow-visible"
      >
        <div className="flex flex-col gap-150 md:gap-300">
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
          <DashboardSearch onSearch={props.onSearch} onValueChange={setSearchValue} value={searchValue} />
          <DashboardNavigation
            currentModuleId={props.currentModuleId}
            homeCurrent={props.homeCurrent}
            navigation={props.navigation}
            unavailableDeployments={props.unavailableDeployments}
          />
        </div>
        <AccessAdministrationNavigation currentPage={props.currentAccessPage} />
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <DashboardHeader
          identity={props.identity}
          logoutPending={props.logoutPending}
          onLogout={props.onLogout}
          title={props.title}
        />
        <div className="min-w-0 flex-1 px-150 py-200">{props.children}</div>
      </main>
    </div>
  );
};
