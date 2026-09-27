import type { EffectDrizzleAuthAdapter } from '@app/better-auth-effect-drizzle/server';
import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';

import type { commercePortalAuthRelations } from './portal-auth-tables.ts';

export type CommercePortalAuthDatabaseExecutor = EffectPgDatabase<typeof commercePortalAuthRelations>;
export type CommercePortalAuthDatabaseAdapter = EffectDrizzleAuthAdapter;
