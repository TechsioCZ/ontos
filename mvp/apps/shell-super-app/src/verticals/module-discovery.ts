import type { TenantModuleState, VerticalRuntimeRegistration } from '@mvp/shared-contracts';
import { resolveVisibleVerticals } from '@mvp/shared-contracts';

export const CORE_TENANT_MODULE_STATES = [
  {
    moduleId: 'property.registry',
    state: 'active',
  },
  {
    moduleId: 'accounting.core',
    state: 'active',
  },
] as const satisfies readonly TenantModuleState[];

export const discoverVisibleVerticals = ({
  registrations,
  tenantModuleStates,
}: {
  readonly registrations: readonly VerticalRuntimeRegistration[];
  readonly tenantModuleStates: readonly TenantModuleState[];
}) =>
  resolveVisibleVerticals({
    registrations,
    tenantModuleStates,
  });
