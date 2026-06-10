import { AccountingCorePage } from '@mvp/accounting-core/module-page';
import ShellFrame from '../../shell-frame';
import { CORE_TENANT_MODULE_STATES } from '../../../verticals/module-discovery.ts';
import { installedVerticalRegistrations } from '../../../verticals/installed.registry.ts';
import { findPublicComponentDescriptor } from '../../../verticals/public-components.tsx';
import { findShellNavigationItem } from '../../../verticals/route-model.ts';

const routeItem = findShellNavigationItem({
  moduleId: 'accounting.core',
  registrations: installedVerticalRegistrations,
  tenantModuleStates: CORE_TENANT_MODULE_STATES,
});
const propertyUnitCard = findPublicComponentDescriptor({
  componentId: 'PropertyUnitCard',
  moduleId: 'property.registry',
  registrations: installedVerticalRegistrations,
});

export default function AccountingCoreRoute() {
  return (
    <ShellFrame>
      <AccountingCorePage
        propertyUnitCard={propertyUnitCard}
        state={routeItem?.state ?? 'inactive'}
      />
    </ShellFrame>
  );
}
