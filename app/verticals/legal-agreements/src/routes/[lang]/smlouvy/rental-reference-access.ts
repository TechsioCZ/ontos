import { documentNavigationModules } from '@app/shared-contracts';
import { Effect } from 'effect';

/** Narrow optional rental reads; owner authorization remains authoritative for every request. */
export const rentalReferencesReadable = (modules?: ReadonlySet<string>) =>
  modules !== undefined && ['property.portfolio', 'property.leasing'].every((moduleId) => modules.has(moduleId));

/** Read from the module ids the shell pinned on the document; legal entity switches reload the document. */
export const rentalReferenceAccess = Effect.sync(() => rentalReferencesReadable(documentNavigationModules()));
