// expect-count: 3
import { Predicate } from 'effect';

/** `decoded['meta']['kind']` is reported; dot notation on the same document is not. */
export const kindOf = (decoded: { readonly meta: { readonly kind: unknown } }): boolean =>
  typeof decoded.meta.kind === 'string';

export const itemsOf = (parsed: { readonly spec: { readonly items: unknown } }): boolean =>
  Array.isArray(parsed.spec.items);

export const displayNameOf = (payload: { readonly profile: { readonly displayName: unknown } }): boolean =>
  Predicate.isString(payload.profile.displayName);
