// expect-count: 3
// Evasion: the three cheap indirections around an otherwise-detected shape.
//  1. the literal side of the comparison is a `const`, not a Literal node;
//  2. the default is a `?:` instead of the `??` / `||` the rule already follows;
//  3. the required-value guard is `!value.length`, a UnaryExpression, not a comparison.
declare const environment: Record<string, string | undefined>;
declare const useReplica: boolean;

const PRODUCTION = 'production';

export const isProduction = environment['NODE_ENV'] === PRODUCTION;

const rawUrl = useReplica ? environment['REPLICA_URL'] : environment['PRIMARY_URL'];
export const databaseUrl = new URL(rawUrl ?? '');

export const secretMissing = !environment['BETTER_AUTH_SECRET']?.length;
