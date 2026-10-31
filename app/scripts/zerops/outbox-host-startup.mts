import { Effect } from 'effect';
import { startEmailDispatchTrigger } from '../email-dispatch-trigger.mts';
import { startProcessDatabasePools } from './process-database-pools.mts';

export const startZeropsOutboxHost = () => Effect.andThen(startProcessDatabasePools, startEmailDispatchTrigger());
