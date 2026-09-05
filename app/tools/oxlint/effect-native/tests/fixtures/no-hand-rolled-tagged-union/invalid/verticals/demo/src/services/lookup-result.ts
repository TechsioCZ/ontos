// expect-count: 6
export type LookupResult<Value> =
  | Readonly<{ readonly _tag: 'found'; readonly value: Value }>
  | Readonly<{ readonly _tag: 'not_found' }>;

export type LifecycleResult<Value> =
  | LookupResult<Value>
  | Readonly<{ readonly _tag: 'conflict'; readonly value: Value }>;

/** A closed status vocabulary declared outside Schema.Literal. */
export type PersistenceOutcome = {
  readonly _tag: 'ok' | 'degraded' | 'unavailable';
  readonly checkedAt: string;
};

export interface Envelope {
  /** Nested object types are declarations too. */
  readonly outcome: { readonly _tag: 'ok' } | { readonly _tag: 'err'; readonly reason: string };
}
