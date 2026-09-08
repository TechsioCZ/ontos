// expect-count: 1
// `import { ReadonlyRecord as EnvRecord }` — the member imported under an alias.
import type { ReadonlyRecord as EnvRecord } from 'effect/Record';

export type AliasedEnvironment = EnvRecord<string, string | undefined>;

export const readUrl = (environment: AliasedEnvironment): string | undefined => environment['ONTOS_DATABASE_URL'];
