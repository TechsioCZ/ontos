// @effect-diagnostics asyncFunction:off
import { loadRemote } from '@module-federation/runtime';
import { lazy, Suspense, useMemo } from 'react';
import type { ComponentType, ReactNode } from 'react';
import type { ModuleFederationComponentLocator, PublicComponentDescriptor } from './index.ts';

interface FederatedPublicComponentProps<TProps extends Record<string, unknown>> {
  readonly descriptor: PublicComponentDescriptor;
  readonly fallback: ReactNode;
  readonly props: TProps;
}

const remoteSpecifier = (locator: ModuleFederationComponentLocator) =>
  `${locator.remote}/${locator.exposedModule.replace(/^\.\//u, '')}`;

const loadFederatedComponent = async <TProps extends Record<string, unknown>>(
  descriptor: PublicComponentDescriptor,
) => {
  const { id, locator } = descriptor;
  if (locator?.kind !== 'module-federation') {
    throw new Error(`${id} does not declare a Module Federation locator.`);
  }

  const { exportName } = locator;
  const moduleExports = await loadRemote<Record<string, unknown>>(remoteSpecifier(locator));
  const component = moduleExports?.[exportName];
  if (typeof component !== 'function') {
    throw new TypeError(`${id} did not expose ${exportName}.`);
  }

  return component as ComponentType<TProps>;
};

export const FederatedPublicComponent = <TProps extends Record<string, unknown>>({
  descriptor,
  fallback,
  props,
}: FederatedPublicComponentProps<TProps>) => {
  const Component = useMemo(
    () =>
      lazy(async () => ({
        default: await loadFederatedComponent<TProps>(descriptor),
      })),
    [descriptor],
  );

  return (
    <Suspense fallback={fallback}>
      <Component {...props} />
    </Suspense>
  );
};
