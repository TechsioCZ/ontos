import type { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import type { Effect } from 'effect';

import type { coreRelations } from './schema.ts';

export type CoreDatabaseExecutor = Effect.Success<ReturnType<typeof makeWithDefaults<typeof coreRelations>>>;

type CoreTransactionCallback = Parameters<CoreDatabaseExecutor['transaction']>[0];

export type CoreTransaction = Parameters<CoreTransactionCallback>[0];

export type CoreDbExecutor = CoreDatabaseExecutor | CoreTransaction;
