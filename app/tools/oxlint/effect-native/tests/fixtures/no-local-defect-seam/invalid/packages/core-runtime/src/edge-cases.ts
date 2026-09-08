// expect-count: 6
// Import-shape edge cases: submodule namespace, root barrel, direct member import,
// aliased named import, computed access and optional chaining are all the same seam.
import * as CauseNs from 'effect/Cause';
import * as EffectAll from 'effect';
import { hasDies } from 'effect/Cause';
import { Effect as Fx } from 'effect';

declare const cause: unknown;
declare const program: unknown;

export const viaSubmoduleNamespace = CauseNs.hasDies(cause as never);
export const viaRootBarrel = EffectAll.Cause.findErrorOption(cause as never);
export const viaDirectMemberImport = hasDies(cause as never);
export const viaAliasedNamed = Fx.catchDefect(program as never, () => program as never);
export const viaComputedAccess = CauseNs['squash'](cause as never);
export const viaOptionalChaining = CauseNs?.dieOption(cause as never);
