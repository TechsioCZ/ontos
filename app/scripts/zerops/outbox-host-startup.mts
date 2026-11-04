import { startProcessObservability } from './process-observability.mts';
import { Effect } from 'effect';
import { startEmailDispatchTrigger } from '../email-dispatch-trigger.mts';
import { startProcessDatabasePools } from './process-database-pools.mts';
import { startSearchDerivedStampSweep } from './search-derived-stamp-sweep.mts';

export const startZeropsOutboxHost = () =>
  Effect.andThen(
    startProcessObservability('outbox'),
    Effect.andThen(
      startProcessDatabasePools,
      Effect.andThen(startEmailDispatchTrigger(), startSearchDerivedStampSweep()),
    ),
  );
