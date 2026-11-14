import { moduleReleaseFetch as releaseTransport } from '#unit-service-fetch';
import { Effect } from 'effect';

import { refuseInsideDatabaseTransaction } from '../db/transaction-io-guard.ts';
import type { ModuleReleaseFetch } from './unit-service-fetch.ts';

export { ModuleReleaseTransportError } from './module-release-transport-error.ts';
export {
  ModuleReleaseIdentityError,
  moduleReleaseApiBaseUrl,
  moduleReleaseAssetWorkerName,
  moduleReleaseServiceBinding,
  moduleReleaseWorkerName,
} from './module-release-identity.ts';

/** The only way to an approved module release: the platform transport behind the transaction guard. */
export const moduleReleaseFetch: ModuleReleaseFetch = (request, module) =>
  refuseInsideDatabaseTransaction('module-transport', module.moduleId).pipe(
    Effect.andThen(Effect.suspend(() => releaseTransport(request, module))),
  );
