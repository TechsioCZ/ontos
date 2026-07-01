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
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';

interface RemoteComponentModule {
  default: ComponentType<RemoteComponentProps>;
}

export type RemoteComponentProps = Readonly<Record<string, unknown>>;

const emptyRemoteComponentProps: RemoteComponentProps = {};

const loadRemoteComponent = (specifier: string) =>
  loadRemote<RemoteComponentModule>(specifier) as Promise<RemoteComponentModule>;

const createRemoteFallback =
  (specifier: string) =>
  ({ error }: { error: Error }) => {
    const { i18nInstance } = useModernI18n();
    const t = i18nInstance['t'].bind(i18nInstance);
    const classification = classifyModuleFederationFallback(error);
    const entry = typeof window === 'undefined' ? undefined : window.location.href;
    const telemetry = createModuleFederationFallbackTelemetry({
      appName: 'shell-super-app',
      classification,
      error,
      eventName: 'mf.client.remote.fallback',
      exportName: 'default',
      ...(entry === undefined ? {} : { entry }),
      phase: 'load',
      remote: specifier,
      status: 'degraded',
    });

    useEffect(() => {
      void emitModuleFederationFallbackTelemetry({
        appName: telemetry.appName,
        classification,
        error,
        eventName: telemetry.eventName,
        exportName: 'default',
        metadata: telemetry.metadata,
        ...(telemetry.entry === undefined ? {} : { entry: telemetry.entry }),
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

const createHydratedRemote = (specifier: string) =>
  function HydratedRemote(props: RemoteComponentProps) {
    const [hydrated, setHydrated] = useState(false);

    useEffect(() => {
      setHydrated(true);
    }, []);

    const FederatedComponent = useMemo<ComponentType<RemoteComponentProps> | null>(() => {
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
        loading: null,
      }) as ComponentType<RemoteComponentProps>;
    }, [hydrated]);

    if (FederatedComponent === null) {
      return null;
    }

    return (
      <Suspense fallback={null}>
        <FederatedComponent {...props} />
      </Suspense>
    );
  };

export const RemoteSlot = ({
  componentProps,
  specifier,
}: {
  readonly componentProps?: RemoteComponentProps | undefined;
  readonly specifier: string;
}) => {
  const Remote = useMemo(() => createHydratedRemote(specifier), [specifier]);
  const props = componentProps ?? emptyRemoteComponentProps;

  return <Remote {...props} />;
};
