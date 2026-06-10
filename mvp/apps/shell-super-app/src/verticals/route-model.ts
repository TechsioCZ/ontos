import type { TenantModuleState, VerticalRuntimeRegistration } from '@mvp/shared-contracts';
import { discoverVisibleVerticals } from './module-discovery.ts';

export const getShellNavigationItems = ({
  registrations,
  tenantModuleStates,
}: {
  readonly registrations: readonly VerticalRuntimeRegistration[];
  readonly tenantModuleStates: readonly TenantModuleState[];
}) =>
  discoverVisibleVerticals({
    registrations,
    tenantModuleStates,
  }).map((vertical) => ({
    displayName: vertical.manifest.displayName,
    folderName: vertical.route.boundaryMarker.folderName,
    moduleId: vertical.manifest.id,
    navigationLabel: vertical.route.navigationLabel,
    path: vertical.route.path,
    renderedFrom: vertical.route.boundaryMarker.renderedFrom,
    state: vertical.tenantState.state,
  }));

export const findShellNavigationItem = ({
  moduleId,
  registrations,
  tenantModuleStates,
}: {
  readonly moduleId: string;
  readonly registrations: readonly VerticalRuntimeRegistration[];
  readonly tenantModuleStates: readonly TenantModuleState[];
}) =>
  getShellNavigationItems({
    registrations,
    tenantModuleStates,
  }).find((item) => item.moduleId === moduleId);
