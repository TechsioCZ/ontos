import { MODULE_CREDENTIAL_CALLERS, receiveModuleCredentialHandover } from './module-credentials.mts';
import { startProcessObservability } from './process-observability.mts';
import { Effect } from 'effect';
import { startEmailDispatchTrigger } from '../email-dispatch-trigger.mts';
import { startProcessDatabasePools } from './process-database-pools.mts';
import { startProcessCompositionSourceReads } from './process-composition-source-reads.mts';
import { startSearchDerivedStampSweep } from './search-derived-stamp-sweep.mts';

export const startZeropsOutboxHost = () =>
  Effect.andThen(
    // Before any worker runs: each hosted owner reads only its own module credential from the host's handover.
    Effect.andThen(startProcessObservability('outbox'), receiveModuleCredentialHandover(MODULE_CREDENTIAL_CALLERS)),
    Effect.andThen(
      Effect.andThen(startProcessDatabasePools, startProcessCompositionSourceReads),
      Effect.andThen(startEmailDispatchTrigger(), startSearchDerivedStampSweep()),
    ),
  );

/** Fails once this process's module credential channel can no longer be read; the Outbox Worker host then stops. */
export { moduleCredentialChannelLost as watchZeropsOutboxHost } from './module-credentials.mts';
