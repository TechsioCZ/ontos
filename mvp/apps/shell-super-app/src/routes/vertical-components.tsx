// @effect-diagnostics asyncFunction:off
import { createLazyComponent } from '@module-federation/bridge-react';
import { getInstance, loadRemote } from '@module-federation/modern-js-v3/runtime';
import { Link, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { DemoUserKey, RuntimeContext } from '@mvp/shared-effect-api';
import { Suspense, useEffect, useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import {
  checkProtectedResourceRead,
  getCurrentRuntimeContext,
  signInDemoUser,
  signOutDemoUser,
} from '../effect/day3-runtime-client';
import type { ProtectedResourceReadDecision } from '../effect/day3-runtime-client';
import { CORE_TENANT_MODULE_STATES } from '../verticals/installed.registry';
import {
  findInstalledVerticalByModuleId,
  getVerticalPublicComponentSpecifier,
  getVerticalRouteSpecifier,
  visibleInstalledVerticals,
} from '../verticals/module-discovery';

interface RemoteComponentModule {
  default?: ComponentType;
  [exportName: string]: ComponentType | undefined;
}

const loadRemoteComponent = (specifier: string) =>
  loadRemote<RemoteComponentModule>(specifier) as Promise<RemoteComponentModule>;

const RemoteUnavailable = ({ error }: { error: Error }) => (
  <div
    className="shell:rounded-lg shell:border shell:border-red-900/20 shell:bg-red-50 shell:px-4 shell:py-3 shell:text-sm shell:font-semibold shell:text-red-900"
    data-remote-error={error.name}
  >
    Remote surface unavailable
  </div>
);

const RemotePlaceholder = ({ label, specifier }: { label: string; specifier: string }) => (
  <div
    className="shell:rounded-lg shell:border shell:border-dashed shell:border-stone-900/20 shell:bg-stone-50 shell:p-4 shell:text-sm shell:text-stone-700"
    data-mf-remote-specifier={specifier}
    data-mf-remote-status="ssr-placeholder"
  >
    <p className="shell:font-black shell:text-stone-950">{label}</p>
    <p className="shell:mt-1 shell:font-semibold">{specifier}</p>
  </div>
);

const createHydratedRemote = (specifier: string, label: string, exportName = 'default') =>
  function HydratedRemote() {
    const [hydrated, setHydrated] = useState(false);

    useEffect(() => {
      setHydrated(true);
    }, []);

    const FederatedComponent = useMemo(() => {
      if (!hydrated) {
        return null;
      }

      const instance = getInstance();
      if (instance === null || instance === undefined) {
        return null;
      }

      return createLazyComponent({
        export: exportName,
        fallback: RemoteUnavailable,
        instance,
        loader: () => loadRemoteComponent(specifier),
        loading: <RemotePlaceholder label={label} specifier={specifier} />,
      });
    }, [hydrated]);

    if (FederatedComponent === null) {
      return <RemotePlaceholder label={label} specifier={specifier} />;
    }

    return (
      <Suspense fallback={<RemotePlaceholder label={label} specifier={specifier} />}>
        <FederatedComponent />
      </Suspense>
    );
  };

export const Header = () => {
  const { i18nInstance } = useModernI18n();
  const t = i18nInstance['t'].bind(i18nInstance);

  return (
    <header
      className="shell:flex shell:min-w-0 shell:flex-wrap shell:items-center shell:gap-x-6 shell:gap-y-2 shell:md:flex-1"
      data-modern-boundary-id="shellSuperApp"
      data-modern-mf-expose="shell/Header"
    >
      <Link
        className="shell:whitespace-nowrap shell:text-xl shell:font-black shell:tracking-normal shell:text-stone-950 shell:no-underline"
        to="/"
      >
        OntOS MVP
      </Link>
      <nav
        aria-label={t('shell.routes.home')}
        className="shell:flex shell:flex-wrap shell:items-center shell:gap-1"
      >
        <Link
          className="shell:rounded-md shell:px-3 shell:py-2 shell:text-sm shell:font-bold shell:text-stone-700 shell:no-underline shell:hover:bg-stone-100"
          to="/"
        >
          {t('shell.routes.home')}
        </Link>
        {visibleInstalledVerticals.map((vertical) => (
          <Link
            className="shell:rounded-md shell:px-3 shell:py-2 shell:text-sm shell:font-bold shell:text-stone-700 shell:no-underline shell:hover:bg-stone-100"
            data-nav-module-state={
              CORE_TENANT_MODULE_STATES.find((item) => item.moduleId === vertical.manifest.moduleId)
                ?.state
            }
            data-ontos-module-id={vertical.manifest.moduleId}
            key={vertical.manifest.moduleId}
            to={vertical.navigation.route}
          >
            {vertical.navigation.label}
          </Link>
        ))}
      </nav>
    </header>
  );
};

export const StatusBadge = () => (
  <span className="shell:inline-flex shell:h-10 shell:shrink-0 shell:items-center shell:justify-center shell:rounded-md shell:border shell:border-stone-900/15 shell:bg-white shell:px-4 shell:text-sm shell:font-extrabold shell:text-stone-950 shell:shadow-sm">
    {visibleInstalledVerticals.length} active modules
  </span>
);

const demoUserLabels = {
  'demo-admin-a': 'Admin A',
  'demo-admin-b': 'Admin B',
  'demo-viewer-a': 'Viewer A',
} as const satisfies Record<DemoUserKey, string>;

type ProtectedResourceId = 'resource-a' | 'resource-b' | 'resource-c';

const protectedResources = [
  {
    resourceId: 'resource-a',
    title: 'Resource A',
  },
  {
    resourceId: 'resource-b',
    title: 'Resource B',
  },
  {
    resourceId: 'resource-c',
    title: 'Resource C',
  },
] as const satisfies readonly {
  resourceId: ProtectedResourceId;
  title: string;
}[];

const protectedResourceExpectations = {
  'demo-admin-a': {
    'resource-a': {
      hint: 'Expected for Admin A: allowed by SpiceDB.',
      stage: 'allowed',
    },
    'resource-b': {
      hint: 'Expected for Admin A: denied by SpiceDB.',
      stage: 'spicedb',
    },
    'resource-c': {
      hint: 'Expected for Admin A: allowed.',
      stage: 'allowed',
    },
  },
  'demo-admin-b': {
    'resource-a': {
      hint: 'Expected for Admin B: denied by SpiceDB.',
      stage: 'spicedb',
    },
    'resource-b': {
      hint: 'Expected for Admin B: denied by SpiceDB.',
      stage: 'spicedb',
    },
    'resource-c': {
      hint: 'Expected for Admin B: denied by SpiceDB.',
      stage: 'spicedb',
    },
  },
  'demo-viewer-a': {
    'resource-a': {
      hint: 'Expected for Viewer A: denied by SpiceDB.',
      stage: 'spicedb',
    },
    'resource-b': {
      hint: 'Expected for Viewer A: allowed.',
      stage: 'allowed',
    },
    'resource-c': {
      hint: 'Expected for Viewer A: denied by policy.',
      stage: 'policy',
    },
  },
} as const satisfies Record<
  DemoUserKey,
  Record<
    ProtectedResourceId,
    {
      hint: string;
      stage: ProtectedResourceReadDecision['stage'];
    }
  >
>;

const demoUserKeyFromContext = (context: RuntimeContext | null): DemoUserKey | null => {
  const subjectId = context?.betterAuthUser.id;

  if (subjectId === 'ba-user-demo-admin-a') {
    return 'demo-admin-a';
  }

  if (subjectId === 'ba-user-demo-admin-b') {
    return 'demo-admin-b';
  }

  if (subjectId === 'ba-user-demo-viewer-a') {
    return 'demo-viewer-a';
  }

  return null;
};

const RuntimeContextPanel = () => {
  const [runtimeContext, setRuntimeContext] = useState<RuntimeContext | null>(null);
  const [status, setStatus] = useState('Loading runtime context...');
  const [pendingOperation, setPendingOperation] = useState<string | null>(null);
  const [readDecision, setReadDecision] = useState<ProtectedResourceReadDecision | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadRuntimeContext = async () => {
      try {
        const response = await getCurrentRuntimeContext();
        if (cancelled) {
          return;
        }
        setRuntimeContext(response.context);
        setStatus(`Signed in as ${response.context.betterAuthUser.email}.`);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setRuntimeContext(null);
        setStatus(error instanceof Error ? error.message : 'Runtime context unavailable.');
      }
    };

    void loadRuntimeContext();

    return () => {
      cancelled = true;
    };
  }, []);

  const runSignIn = async (demoUserKey: DemoUserKey) => {
    setPendingOperation(demoUserKey);
    setStatus(`Signing in as ${demoUserLabels[demoUserKey]}...`);

    try {
      const response = await signInDemoUser(demoUserKey);
      setRuntimeContext(response.context);
      setStatus(`Signed in as ${demoUserLabels[demoUserKey]}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Sign-in request failed.');
    } finally {
      setPendingOperation(null);
    }
  };

  const runSignOut = async () => {
    setPendingOperation('signOutDemoUser');
    setStatus('Signing out...');

    try {
      await signOutDemoUser();
      setRuntimeContext(null);
      setStatus('Signed out.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Sign-out request failed.');
    } finally {
      setPendingOperation(null);
    }
  };

  const runReadProbe = async (resourceId: ProtectedResourceId) => {
    const demoUserKey = demoUserKeyFromContext(runtimeContext);

    if (demoUserKey === null) {
      setStatus('Sign in before checking a protected resource.');
      return;
    }

    setPendingOperation(`${demoUserKey}:${resourceId}`);
    setReadDecision(null);
    setStatus(`${protectedResourceExpectations[demoUserKey][resourceId].hint} Checking now...`);

    try {
      const response = await checkProtectedResourceRead({
        resourceId,
      });
      setReadDecision(response.decision);
      setStatus(
        `${demoUserLabels[demoUserKey]} reading ${resourceId}: ${
          response.decision.allowed ? 'allowed' : 'denied'
        }.`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Protected resource read probe failed.');
    } finally {
      setPendingOperation(null);
    }
  };

  const activeDemoUser = demoUserKeyFromContext(runtimeContext);
  const moduleStates = runtimeContext?.moduleStates ?? [];

  return (
    <section
      className="shell:rounded-lg shell:border shell:border-stone-900/10 shell:bg-white shell:p-4"
      data-day3-runtime-context={runtimeContext === null ? 'signed-out' : 'read-only'}
      data-day3-active-demo-user={activeDemoUser ?? 'none'}
    >
      <p className="shell:text-xs shell:font-bold shell:uppercase shell:text-stone-500">
        Day 3 runtime context
      </p>
      <h2 className="shell:mt-1 shell:text-base shell:font-black shell:text-stone-950">
        BetterAuth subject resolves to OntOS tenant, legal entity, and principal
      </h2>
      <div className="shell:mt-4 shell:flex shell:flex-wrap shell:gap-2">
        {(['demo-admin-a', 'demo-viewer-a', 'demo-admin-b'] as const).map((demoUserKey) => (
          <button
            aria-pressed={activeDemoUser === demoUserKey}
            className={
              activeDemoUser === demoUserKey
                ? 'shell:h-9 shell:rounded-md shell:border shell:border-stone-900/15 shell:bg-stone-950 shell:px-3 shell:text-sm shell:font-bold shell:text-white'
                : 'shell:h-9 shell:rounded-md shell:border shell:border-stone-900/15 shell:bg-white shell:px-3 shell:text-sm shell:font-bold shell:text-stone-950'
            }
            data-effect-operation="signInDemoUser"
            data-demo-user={demoUserKey}
            disabled={pendingOperation !== null}
            key={demoUserKey}
            onClick={() => {
              void runSignIn(demoUserKey);
            }}
            type="button"
          >
            {demoUserLabels[demoUserKey]}
          </button>
        ))}
        <button
          className="shell:h-9 shell:rounded-md shell:border shell:border-red-900/20 shell:bg-red-50 shell:px-3 shell:text-sm shell:font-bold shell:text-red-950 shell:disabled:opacity-60"
          data-effect-operation="signOutDemoUser"
          disabled={pendingOperation !== null}
          onClick={() => {
            void runSignOut();
          }}
          type="button"
        >
          Sign out
        </button>
      </div>
      <p
        aria-live="polite"
        className="shell:mt-3 shell:text-sm shell:font-bold shell:text-stone-600"
        data-day3-runtime-status=""
      >
        {status}
      </p>
      <dl className="shell:mt-4 shell:grid shell:gap-3 shell:md:grid-cols-3">
        <div className="shell:rounded-md shell:bg-stone-50 shell:p-3">
          <dt className="shell:text-xs shell:font-bold shell:uppercase shell:text-stone-500">
            Demo subject
          </dt>
          <dd
            className="shell:mt-1 shell:text-sm shell:font-black shell:text-stone-950"
            data-day3-demo-subject=""
          >
            {runtimeContext?.betterAuthUser.email ?? 'signed-out'}
          </dd>
        </div>
        <div className="shell:rounded-md shell:bg-stone-50 shell:p-3">
          <dt className="shell:text-xs shell:font-bold shell:uppercase shell:text-stone-500">
            Tenant
          </dt>
          <dd
            className="shell:mt-1 shell:text-sm shell:font-black shell:text-stone-950"
            data-day3-tenant=""
          >
            {runtimeContext?.tenant.id ?? 'none'}
          </dd>
        </div>
        <div className="shell:rounded-md shell:bg-stone-50 shell:p-3">
          <dt className="shell:text-xs shell:font-bold shell:uppercase shell:text-stone-500">
            Principal
          </dt>
          <dd
            className="shell:mt-1 shell:text-sm shell:font-black shell:text-stone-950"
            data-day3-principal=""
          >
            {runtimeContext?.principal.id ?? 'none'}
          </dd>
        </div>
      </dl>
      <div className="shell:mt-4 shell:grid shell:gap-2 shell:md:grid-cols-2">
        {moduleStates.length === 0 ? (
          <p className="shell:rounded-md shell:bg-stone-50 shell:px-3 shell:py-2 shell:text-sm shell:font-bold shell:text-stone-700">
            No active runtime context.
          </p>
        ) : (
          moduleStates.map((item) => (
            <p
              className="shell:rounded-md shell:bg-emerald-50 shell:px-3 shell:py-2 shell:text-sm shell:font-bold shell:text-emerald-950"
              data-day3-module-state={item.state}
              data-ontos-module-id={item.moduleId}
              key={item.moduleId}
            >
              {item.moduleId}: {item.state}
            </p>
          ))
        )}
      </div>
      <section className="shell:mt-5 shell:border-t shell:border-stone-900/10 shell:pt-4">
        <h3 className="shell:text-sm shell:font-black shell:text-stone-950">
          Protected resource read probes
        </h3>
        <div className="shell:mt-3 shell:grid shell:gap-2 shell:md:grid-cols-3">
          {protectedResources.map((resource) => {
            const expectation =
              activeDemoUser === null
                ? {
                    hint: 'Sign in to see the expected result.',
                    stage: 'none',
                  }
                : protectedResourceExpectations[activeDemoUser][resource.resourceId];

            return (
              <button
                className="shell:min-h-16 shell:rounded-md shell:border shell:border-stone-900/15 shell:bg-white shell:px-3 shell:py-2 shell:text-left shell:text-sm shell:font-bold shell:text-stone-950 shell:hover:bg-stone-50 shell:disabled:opacity-60"
                data-day3-read-probe={expectation.stage}
                data-day3-resource-id={resource.resourceId}
                data-day3-user-id={activeDemoUser ?? 'none'}
                disabled={pendingOperation !== null || activeDemoUser === null}
                key={resource.resourceId}
                onClick={() => {
                  void runReadProbe(resource.resourceId);
                }}
                type="button"
              >
                <span className="shell:block">{resource.title}</span>
                <span className="shell:mt-1 shell:block shell:text-xs shell:font-semibold shell:leading-4 shell:text-stone-600">
                  {expectation.hint}
                </span>
              </button>
            );
          })}
        </div>
        <output
          className={
            readDecision?.allowed === true
              ? 'shell:mt-3 shell:block shell:rounded-md shell:bg-emerald-50 shell:px-3 shell:py-2 shell:text-sm shell:font-bold shell:text-emerald-950'
              : 'shell:mt-3 shell:block shell:rounded-md shell:bg-red-50 shell:px-3 shell:py-2 shell:text-sm shell:font-bold shell:text-red-950'
          }
          data-day3-read-decision-stage={readDecision?.stage ?? 'none'}
          data-day3-read-decision=""
        >
          {readDecision === null
            ? 'Select a protected resource read probe.'
            : `${readDecision.userId} reading ${readDecision.resourceId}: ${readDecision.allowed ? 'allowed' : 'denied'} at ${readDecision.stage}. ${readDecision.reason}`}
        </output>
      </section>
    </section>
  );
};

export const VerticalShowcase = () => (
  <section
    className="shell:mx-auto shell:mt-8 shell:grid shell:max-w-7xl shell:gap-4"
    data-modern-boundary-id="shellSuperApp"
  >
    <RuntimeContextPanel />
    <div className="shell:grid shell:gap-4 shell:lg:grid-cols-2">
      {visibleInstalledVerticals.map((vertical) => {
        const firstComponent = vertical.manifest.publicComponents.at(0);
        const publicComponentSpecifier =
          firstComponent === undefined
            ? undefined
            : getVerticalPublicComponentSpecifier(vertical.manifest.moduleId, firstComponent.key);
        const PublicComponent =
          publicComponentSpecifier === undefined || firstComponent === undefined
            ? null
            : createHydratedRemote(
                publicComponentSpecifier,
                firstComponent.label,
                firstComponent.moduleFederation.exportName ?? 'default',
              );
        const tenantState = CORE_TENANT_MODULE_STATES.find(
          (item) => item.moduleId === vertical.manifest.moduleId,
        );

        return (
          <article
            className="shell:rounded-lg shell:border shell:border-stone-900/10 shell:bg-white shell:p-4 shell:shadow-sm shell:[content-visibility:auto] shell:[contain-intrinsic-size:auto_360px]"
            data-ontos-module-id={vertical.manifest.moduleId}
            data-tenant-module-state={tenantState?.state}
            key={vertical.manifest.moduleId}
          >
            <div className="shell:flex shell:flex-wrap shell:items-center shell:justify-between shell:gap-3">
              <div>
                <p className="shell:text-xs shell:font-bold shell:uppercase shell:text-stone-500">
                  {vertical.manifest.folder}
                </p>
                <h2 className="shell:mt-1 shell:text-lg shell:font-black shell:text-stone-950">
                  {vertical.manifest.displayName}
                </h2>
              </div>
              <span className="shell:rounded-md shell:bg-emerald-50 shell:px-3 shell:py-1 shell:text-xs shell:font-bold shell:text-emerald-950">
                {tenantState?.state ?? 'unknown'}
              </span>
            </div>
            <div className="shell:mt-4 shell:grid shell:gap-3">
              {PublicComponent === null ? null : (
                <div
                  data-cross-microvertical-consumer="shell-super-app"
                  data-cross-microvertical-provider={vertical.manifest.moduleId}
                  data-mf-public-component={publicComponentSpecifier}
                >
                  <PublicComponent />
                </div>
              )}
            </div>
          </article>
        );
      })}
    </div>
  </section>
);

export const VerticalRouteSurface = ({ moduleId }: { moduleId: string }) => {
  const vertical = findInstalledVerticalByModuleId(moduleId);
  const specifier = getVerticalRouteSpecifier(moduleId);

  if (vertical === undefined || specifier === undefined) {
    return (
      <section className="shell:mx-auto shell:mt-8 shell:max-w-7xl shell:rounded-lg shell:bg-white shell:p-6">
        <p className="shell:text-sm shell:font-bold shell:text-stone-700">
          Module route unavailable.
        </p>
      </section>
    );
  }

  const tenantState = CORE_TENANT_MODULE_STATES.find(
    (item) => item.moduleId === vertical.manifest.moduleId,
  );
  const RemoteRoute = createHydratedRemote(specifier, `${vertical.manifest.displayName} route`);

  return (
    <section
      className="shell:mx-auto shell:mt-8 shell:max-w-7xl shell:rounded-lg shell:border shell:border-stone-900/10 shell:bg-white shell:p-4"
      data-ontos-module-id={vertical.manifest.moduleId}
      data-tenant-module-state={tenantState?.state}
    >
      <div className="shell:mb-4 shell:grid shell:gap-3 shell:md:grid-cols-4">
        <p className="shell:rounded-md shell:bg-stone-50 shell:p-3 shell:text-sm shell:font-bold">
          module: {vertical.manifest.moduleId}
        </p>
        <p className="shell:rounded-md shell:bg-stone-50 shell:p-3 shell:text-sm shell:font-bold">
          folder: {vertical.manifest.folder}
        </p>
        <p className="shell:rounded-md shell:bg-stone-50 shell:p-3 shell:text-sm shell:font-bold">
          state: {tenantState?.state ?? 'unknown'}
        </p>
        <p className="shell:rounded-md shell:bg-stone-50 shell:p-3 shell:text-sm shell:font-bold">
          mf: {specifier}
        </p>
      </div>
      <RemoteRoute />
    </section>
  );
};
