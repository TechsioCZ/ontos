// Backtick members are collected like quoted ones, but a single declaration never reports,
// and a `let` array is not a `const` authority (so its set is simply not collected).
import { Schema } from 'effect';

let mutableMembers = ['draft', 'published'];
mutableMembers = ['published', 'draft'];

export const Phase = Schema.Literals([`plan`, `apply`]);
export const MutablePhase = Schema.Literals(mutableMembers);
export const Interpolated = Schema.Literals([`plan-${String(1)}`, `apply`]);
export const Document = Schema.Struct({ phase: Phase, previous: Phase });
