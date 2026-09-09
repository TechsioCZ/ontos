import type { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2';
import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';

import type { authRelations } from './schema.ts';

export type AuthDatabaseExecutor = EffectPgDatabase<typeof authRelations>;
export type BetterAuthDatabaseAdapter = ReturnType<typeof drizzleAdapter>;
