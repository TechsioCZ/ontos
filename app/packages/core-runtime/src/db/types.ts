import type { db } from './client.ts';

type CoreTransactionCallback = Parameters<typeof db.transaction>[0];

export type CoreTransaction = Parameters<CoreTransactionCallback>[0];

export type CoreDbExecutor = typeof db | CoreTransaction;

export type CoreReadonlyDbExecutor = Pick<CoreDbExecutor, 'execute' | 'select'>;
