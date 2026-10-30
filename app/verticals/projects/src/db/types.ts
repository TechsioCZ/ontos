import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';
import type { projectsRelations } from './schema.ts';

export type ProjectsDatabaseExecutor = EffectPgDatabase<typeof projectsRelations>;
type ProjectsTransactionCallback = Parameters<ProjectsDatabaseExecutor['transaction']>[0];
export type ProjectsTransaction = Pick<Parameters<ProjectsTransactionCallback>[0], 'insert' | 'select' | 'update'>;
