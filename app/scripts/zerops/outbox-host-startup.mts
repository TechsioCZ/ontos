import { receiveModuleCredentialHandover } from './module-credentials.mts';
import { startProcessObservability } from './process-observability.mts';
import { Effect } from 'effect';
import { startEmailDispatchTrigger } from '../email-dispatch-trigger.mts';
import { startProcessDatabasePools } from './process-database-pools.mts';
import { startSearchDerivedStampSweep } from './search-derived-stamp-sweep.mts';

export const startZeropsOutboxHost = () =>
  Effect.andThen(
    // Before any worker runs: each hosted owner reads only its own module credential from the host's handover.
    Effect.andThen(startProcessObservability('outbox'), receiveModuleCredentialHandover),
    Effect.andThen(
      startProcessDatabasePools,
      Effect.andThen(startEmailDispatchTrigger(), startSearchDerivedStampSweep()),
    ),
  );
