import {
  classifyModuleFederationFallback,
  createModuleFederationFallbackTelemetry,
  emitModuleFederationFallbackTelemetry,
  toModuleFederationFallbackAttributes,
} from '@modern-js/runtime/module-federation';
import { createLazyComponent } from '@module-federation/bridge-react';
import { getInstance, loadRemote } from '@module-federation/modern-js-v3/runtime';
import { Suspense, useEffect, useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import TicketingWidgetServer from '@app/ticketing/Widget';
import { Link, useModernI18n } from '@modern-js/plugin-i18n/runtime';

const widgetCount = Number('1');

interface RemoteComponentModule {
  default: ComponentType;
}

const loadRemoteComponent = (specifier: string) =>
  loadRemote<RemoteComponentModule>(specifier) as Promise<RemoteComponentModule>;

const createRemoteFallback =
  (specifier: string) =>
  ({ error }: { error: Error }) => {
    const { t } = useModernI18n();
    const classification = classifyModuleFederationFallback(error);
    const telemetryEntry = typeof window === 'undefined' ? undefined : window.location.href;
    const telemetry = createModuleFederationFallbackTelemetry({
      appName: 'shell-super-app',
      classification,
      ...(telemetryEntry === undefined ? {} : { entry: telemetryEntry }),
      error,
      eventName: 'mf.client.remote.fallback',
      exportName: 'default',
      phase: 'load',
      remote: specifier,
      status: 'degraded',
    });

    useEffect(() => {
      void emitModuleFederationFallbackTelemetry({
        appName: telemetry.appName,
        classification,
        ...(telemetry.entry === undefined ? {} : { entry: telemetry.entry }),
        error,
        eventName: telemetry.eventName,
        exportName: 'default',
        metadata: telemetry.metadata,
        phase: telemetry.phase,
        remote: specifier,
        status: 'degraded',
      });
    }, [classification, error, telemetry]);

    return (
      <div
        className="shell:rounded-xl shell:border shell:border-red-900/20 shell:bg-red-50 shell:px-4 shell:py-3 shell:text-sm shell:font-semibold shell:text-red-900"
        data-remote-error={error.name}
        {...toModuleFederationFallbackAttributes(telemetry)}
      >
        {t('shell.remoteUnavailable')}
      </div>
    );
  };

const createHydratedRemote = (ServerComponent: ComponentType, specifier: string) =>
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
        export: 'default',
        fallback: createRemoteFallback(specifier),
        instance,
        loader: () => loadRemoteComponent(specifier),
        loading: <ServerComponent />,
      });
    }, [hydrated]);

    if (FederatedComponent === null) {
      return <ServerComponent />;
    }

    return (
      <Suspense fallback={<ServerComponent />}>
        <FederatedComponent />
      </Suspense>
    );
  };

const TicketingWidget = createHydratedRemote(TicketingWidgetServer, 'ticketing/Widget');

export const Header = () => {
  const { t } = useModernI18n();

  return (
    <header
      className="shell:flex shell:min-w-0 shell:flex-wrap shell:items-center shell:gap-x-8 shell:gap-y-2 shell:md:flex-1"
      data-modern-boundary-id="shellSuperApp"
      data-modern-mf-expose="shell/Header"
    >
      <Link
        className="shell:whitespace-nowrap shell:text-xl shell:font-black shell:tracking-normal shell:text-stone-950 shell:no-underline"
        to="/"
      >
        {t('shell.title')}
      </Link>
    </header>
  );
};

export const StatusBadge = () => {
  const { t } = useModernI18n();

  return (
    <span className="shell:inline-flex shell:h-10 shell:shrink-0 shell:items-center shell:justify-center shell:rounded-full shell:border shell:border-stone-900/15 shell:bg-white shell:px-4 shell:text-sm shell:font-extrabold shell:text-stone-950 shell:shadow-lg shell:shadow-stone-900/5">
      {widgetCount} {t('shell.hero.cardOneKicker')}
    </span>
  );
};

export const VerticalShowcase = () => {
  const { t } = useModernI18n();

  if (widgetCount === 0) {
    return (
      <section className="shell:mx-auto shell:mt-12 shell:max-w-7xl shell:rounded-2xl shell:bg-white/90 shell:p-6 shell:shadow-xl shell:shadow-stone-900/10">
        <p className="shell:text-lg shell:font-bold shell:text-stone-700">
          {t('shell.hero.empty')}
        </p>
      </section>
    );
  }

  return (
    <section
      className="shell:mx-auto shell:mt-12 shell:max-w-7xl"
      data-modern-boundary-id="shellSuperApp"
    >
      <div className="shell:grid shell:gap-4 shell:md:grid-cols-2">
        <TicketingWidget key="ticketing" />
      </div>
    </section>
  );
};
