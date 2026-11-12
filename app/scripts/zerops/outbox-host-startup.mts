import { holdOwnStoreCopy, MODULE_CREDENTIAL_CALLERS, receiveModuleCredentialHandover } from './module-credentials.mts';
import { startProcessObservability } from './process-observability.mts';
import { Effect } from 'effect';
import { startEmailDispatchTrigger } from '../email-dispatch-trigger.mts';
import { startProcessDatabasePools } from './process-database-pools.mts';
import { startProcessCompositionSourceReads } from './process-composition-source-reads.mts';
import { startSearchDerivedStampSweep } from './search-derived-stamp-sweep.mts';

export const startZeropsOutboxHost = () =>
  Effect.andThen(
    // Before any worker runs. The workers run inside this host's own bundle (worker.mjs), which carries one store
    // copy; it is claimed for the callers here and gets their keys from the host's handover.
    Effect.andThen(
      startProcessObservability('outbox'),
      receiveModuleCredentialHandover(MODULE_CREDENTIAL_CALLERS).pipe(
        Effect.flatMap((holders) => holdOwnStoreCopy(holders, MODULE_CREDENTIAL_CALLERS)),
      ),
    ),
    Effect.andThen(
      Effect.andThen(startProcessDatabasePools, startProcessCompositionSourceReads),
      Effect.andThen(startEmailDispatchTrigger(), startSearchDerivedStampSweep()),
    ),
  );

/** Fails once this process's module credential channel can no longer be read; the Outbox Worker host then stops. */
export { moduleCredentialChannelLost as watchZeropsOutboxHost } from './module-credentials.mts';
