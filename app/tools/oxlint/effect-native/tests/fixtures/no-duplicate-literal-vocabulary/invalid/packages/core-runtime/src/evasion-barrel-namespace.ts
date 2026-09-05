// expect-count: 2
// Evasion: root barrel namespace import plus computed member access on both hops.
import * as Effect from 'effect';

export const MembershipKind = Effect.Schema.Literals(['owner', 'member', 'guest']);
export const Row = Effect.Schema.Struct({ kind: Effect.Schema.Literals(['guest', 'owner', 'member']) });
export const Patch = Effect.Schema.Struct({ kind: Effect['Schema']['Literals'](['member', 'guest', 'owner']) });
