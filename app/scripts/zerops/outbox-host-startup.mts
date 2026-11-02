import { startProcessObservability } from './process-observability.mts';
import { Effect } from 'effect';
import { startEmailDispatchTrigger } from '../email-dispatch-trigger.mts';
import { startProcessDatabasePools } from './process-database-pools.mts';

export const startZeropsOutboxHost = () =>
  Effect.andThen(
    startProcessObservability('outbox'),
    Effect.andThen(startProcessDatabasePools, startEmailDispatchTrigger()),
  );
