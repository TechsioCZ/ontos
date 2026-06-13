import { moduleFederationRemoteSpecifier, resolveVisibleVerticals } from '@mvp/shared-contracts';
import type { ModuleFederationComponentLocator } from '@mvp/shared-contracts';
import {
  CORE_TENANT_MODULE_STATES,
  installedVerticalRegistrations,
  shellVerticalWidgetSurfaces,
} from './installed.registry';

const activeRegistrations = resolveVisibleVerticals(
  installedVerticalRegistrations,
  CORE_TENANT_MODULE_STATES,
);

const shellVerticalWidgetSurfacesByModuleId: Readonly<
  Record<string, ModuleFederationComponentLocator>
> = shellVerticalWidgetSurfaces;

export const visibleInstalledVerticals = activeRegistrations.flatMap((registration) => {
  const tenantState = CORE_TENANT_MODULE_STATES.find(
    (item) => item.moduleId === registration.manifest.moduleId,
  );
  return tenantState === undefined ? [] : [{ ...registration, tenantState }];
});

export const activeInstalledVerticals = visibleInstalledVerticals;

export type VisibleInstalledVertical = (typeof visibleInstalledVerticals)[number];

export const findInstalledVerticalByModuleId = (moduleId: string) =>
  visibleInstalledVerticals.find((vertical) => vertical.manifest.moduleId === moduleId);

export const findInstalledVerticalByPath = (path: string) =>
  visibleInstalledVerticals.find((vertical) =>
    vertical.routes.some((route) => route.path === path),
  );

export const getVerticalRouteSpecifier = (moduleId: string) => {
  const registration = findInstalledVerticalByModuleId(moduleId);
  const route = registration?.routes.at(0);
  return route === undefined ? undefined : moduleFederationRemoteSpecifier(route.moduleFederation);
};

export const getVerticalWidgetSpecifier = (moduleId: string) => {
  const locator = shellVerticalWidgetSurfacesByModuleId[moduleId];
  return locator === undefined ? undefined : moduleFederationRemoteSpecifier(locator);
};

export const getVerticalPublicComponentSpecifier = (moduleId: string, componentKey: string) => {
  const registration = findInstalledVerticalByModuleId(moduleId);
  const component = registration?.manifest.publicComponents.find(
    (item) => item.key === componentKey,
  );
  return component === undefined
    ? undefined
    : moduleFederationRemoteSpecifier(component.moduleFederation);
};

export const visibleNavigationItems = visibleInstalledVerticals.map((registration) => ({
  label: registration.navigation.label,
  moduleId: registration.manifest.moduleId,
  route: registration.navigation.route,
  state: registration.tenantState.state,
}));
