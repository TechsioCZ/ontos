// A generic constraint does not establish an open dictionary as configuration authority.
export function identity<T extends Record<string, string | undefined>>(value: T): T {
  return value;
}
namespace Domain {
  type Record<K, V> = { readonly kind: 'domain'; readonly value: V };
  export type Payload = Record<string, string | undefined>;
}
// Closed mapped keys and native maps remain valid; no type-checker equivalence is inferred.
export type Fields = { [K in 'issuer' | 'audience']?: string };
export type Cache = ReadonlyMap<string, string | undefined>;
