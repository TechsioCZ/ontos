import { accountingCoreRegistration } from '@mvp/accounting-core/registration';
import { propertyRegistryRegistration } from '@mvp/property-registry/registration';

export const installedVerticalRegistrations = [
  propertyRegistryRegistration,
  accountingCoreRegistration,
] as const;
