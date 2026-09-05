// FALSE POSITIVE regression: a *type-only* reference to a direct member import is not construction.
// `collectDirectMemberImports` ignores `ImportDeclaration.importKind === 'type'` (and inline
// `{ type make }`), and `isNonReferencePosition` does not treat `TSTypeQuery` as a type position, so
// `typeof make` reports "constructs a runtime" even though the binding is erased at compile time.
// The namespace spelling `typeof ManagedRuntime.make` is correctly silent (TSQualifiedName), so the
// two spellings currently disagree.
import type { make } from 'effect/ManagedRuntime';
import { make as valueMake } from 'effect/ManagedRuntime';

export type BootFn = typeof make;
export type BootFnFromValue = typeof valueMake;
