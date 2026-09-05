// expect-count: 3
// Evasion: `as const`, `satisfies`, optional chaining and non-null wrappers around the same set.
import { Schema as S } from 'effect';

export const Level = S.Literals(['debug', 'info', 'warn'] as const);
export const A = S.Struct({ level: S.Literals(['warn', 'debug', 'info'] satisfies readonly string[]) });
export const B = S.Struct({ level: S?.Literals?.(['info', 'warn', 'debug']) });
export const C = S.Struct({ level: S.Literals(['debug' as const, 'warn', 'info'])! });
