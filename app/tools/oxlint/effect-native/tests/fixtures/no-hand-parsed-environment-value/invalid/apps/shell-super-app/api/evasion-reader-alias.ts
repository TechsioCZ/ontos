// expect-count: 2
// Evasion: `environmentReaders` is matched on the raw callee name, so renaming the binding at the
// import site hides the reader. Import-binding tracking (shared/effect-imports.ts style) is the fix.
import { getBuildConfigEnvironment as readBuild, readEnvironment as readEnv } from './environment.ts';

export const databaseUrl = new URL(readEnv('DATABASE_URL') ?? '');
export const port = Number(readBuild('SHELL_SUPER_APP_PORT') ?? 3020);
