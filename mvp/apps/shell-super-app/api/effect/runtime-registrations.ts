import { propertyRegistryRegistration } from '@mvp/property-registry/vertical.registration';
import { accountingCoreRegistration } from '@mvp/accounting-core/vertical.registration';

export const serverInstalledVerticalRegistrations = [
  propertyRegistryRegistration,
  accountingCoreRegistration,
] as const;
