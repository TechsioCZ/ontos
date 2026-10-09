import type { EffectDrizzleAuthAdapter } from '@app/better-auth-effect-drizzle/server';
import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';

import type { authRelations } from './schema.ts';

export type AuthDatabaseExecutor = EffectPgDatabase<typeof authRelations>;
export type BetterAuthDatabaseAdapter = EffectDrizzleAuthAdapter;
