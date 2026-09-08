// expect-count: 5
// Evasion probe: the body is a *single* `Predicate.*` / `Array.isArray` / `Schema.is(S)(…)` call, so
// the delegation allowance fires — but the call never tests the value the predicate narrows. Each of
// these is the one-line rewrite of a currently-reported A2 site (e.g.
// `apps/shell-super-app/api/modules/shell-governed-reads.ts:140 hasLegalEntity`) that silences the
// rule without moving a single rule into the owning Schema.
import { Predicate, Schema } from 'effect';

export interface OperationalScope {
  readonly legalEntityId?: string;
  readonly tags?: unknown;
  readonly name?: unknown;
}
export interface NamedScope {
  readonly name: string;
}

declare const NameSchema: Schema.Codec<string, string>;
declare const unrelated: unknown;

// The refinement is on a projection, not on the guarded value.
export const hasLegalEntity = (
  scope: OperationalScope,
): scope is OperationalScope & { readonly legalEntityId: string } => Predicate.isString(scope.legalEntityId);

export const hasTagList = (
  scope: OperationalScope,
): scope is OperationalScope & { readonly tags: readonly string[] } => Array.isArray(scope.tags);

export const isNamedScope = (scope: OperationalScope): scope is OperationalScope & NamedScope =>
  Schema.is(NameSchema)(scope.name as string);

// The delegate does not even look at the parameter.
export const isNamedByAmbient = (scope: OperationalScope): scope is OperationalScope & NamedScope =>
  Schema.is(NameSchema)(unrelated as string);

// A delegate call with no argument at all still counts as "delegation" today.
export const isAnythingNamed = (scope: OperationalScope): scope is OperationalScope & NamedScope =>
  Predicate.isString();
