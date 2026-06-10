import { PropertyRegistryPage } from '@mvp/property-registry/module-page';
import ShellFrame from '../../shell-frame';
import { CORE_TENANT_MODULE_STATES } from '../../../verticals/module-discovery.ts';
import { installedVerticalRegistrations } from '../../../verticals/installed.registry.ts';
import { findShellNavigationItem } from '../../../verticals/route-model.ts';

const routeItem = findShellNavigationItem({
  moduleId: 'property.registry',
  registrations: installedVerticalRegistrations,
  tenantModuleStates: CORE_TENANT_MODULE_STATES,
});

export default function PropertyRegistryRoute() {
  return (
    <ShellFrame>
      <PropertyRegistryPage state={routeItem?.state ?? 'inactive'} />
    </ShellFrame>
  );
}
