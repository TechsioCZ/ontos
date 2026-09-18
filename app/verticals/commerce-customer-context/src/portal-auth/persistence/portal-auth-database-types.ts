import type { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2';
import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';

import type { commercePortalAuthRelations } from './portal-auth-tables.ts';

export type CommercePortalAuthDatabaseExecutor = EffectPgDatabase<typeof commercePortalAuthRelations>;
export type CommercePortalAuthDatabaseAdapter = ReturnType<typeof drizzleAdapter>;
