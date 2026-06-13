// @effect-diagnostics asyncFunction:off
import { loadRemote } from '@module-federation/modern-js-v3/runtime';
import { moduleFederationRemoteSpecifier } from '@mvp/shared-contracts';
import type { ModuleFederationComponentLocator } from '@mvp/shared-contracts';
import { useEffect, useState } from 'react';
import type { ComponentType } from 'react';

interface PropertyUnitCardModule {
  PropertyUnitCard?: ComponentType;
  default?: ComponentType;
}

const propertyUnitCardLocator = {
  exportName: 'PropertyUnitCard',
  exposedModule: './PropertyUnitCard',
  kind: 'module-federation',
  remote: 'propertyRegistry',
} as const satisfies ModuleFederationComponentLocator;
const propertyUnitCardSpecifier = moduleFederationRemoteSpecifier(propertyUnitCardLocator);

export const RemotePropertyUnitCard = () => {
  const [RemoteComponent, setRemoteComponent] = useState<ComponentType | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');

  useEffect(() => {
    let cancelled = false;

    const loadComponent = async () => {
      try {
        const module = await loadRemote<PropertyUnitCardModule>(propertyUnitCardSpecifier);
        if (cancelled) {
          return;
        }
        if (module === null) {
          setStatus('unavailable');
          return;
        }

        const loadedComponent = module.PropertyUnitCard ?? module.default ?? null;
        setRemoteComponent(() => loadedComponent);
        setStatus(loadedComponent === null ? 'unavailable' : 'ready');
      } catch {
        if (cancelled) {
          return;
        }
        setStatus('unavailable');
      }
    };

    void loadComponent();

    return () => {
      cancelled = true;
    };
  }, []);

  if (RemoteComponent !== null) {
    return (
      <div
        data-cross-microvertical-consumer="accounting.core"
        data-cross-microvertical-provider="property.registry"
        data-mf-remote-specifier={propertyUnitCardSpecifier}
      >
        <RemoteComponent />
      </div>
    );
  }

  return (
    <aside
      className="accountingcore:rounded-lg accountingcore:border accountingcore:border-dashed accountingcore:border-stone-900/25 accountingcore:bg-stone-50 accountingcore:p-4 accountingcore:text-sm accountingcore:text-stone-700"
      data-cross-microvertical-consumer="accounting.core"
      data-cross-microvertical-provider="property.registry"
      data-mf-remote-specifier={propertyUnitCardSpecifier}
      data-mf-remote-status={status}
    >
      <p className="accountingcore:font-bold accountingcore:text-stone-950">
        property.registry public component
      </p>
      <p className="accountingcore:mt-1">
        Loading via Module Federation specifier {propertyUnitCardSpecifier}.
      </p>
    </aside>
  );
};
