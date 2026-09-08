// expect-count: 3
// Aliased named import plus optional-chained, computed and `as const` call shapes.
import { Schema as S } from 'effect';

const Kind = S.Literals(['service', 'integration']);

export const A = S.Struct({ kind: Kind });
// Member order is irrelevant: same vocabulary.
export const B = S.Struct({ kind: S.Literals(['integration', 'service']) });
export const C = S.Struct({ kind: S?.Literals?.(['service', 'integration']) });
export const D = S.Struct({ kind: S['Literals'](['service', 'integration'] as const) });
