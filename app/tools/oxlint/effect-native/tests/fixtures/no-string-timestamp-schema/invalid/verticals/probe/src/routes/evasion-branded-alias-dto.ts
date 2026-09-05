// expect-count: 2
// Evasion: a brand and an alias chain do not turn a string into a `DateTime.Utc` — exactly as
// `Schema.String.pipe(Schema.brand(...))` is still reported in a field bag.
type NullableIsoTimestamp = IsoTimestamp | null | undefined;
type IsoTimestamp = string;

export interface AuditRow {
  readonly auditId: string;
  // 1 a branded ISO string
  readonly createdAt: string & { readonly _brand: unique symbol };
  // 2 an alias of an alias, unioned with null
  readonly expiresAt: NullableIsoTimestamp;
  readonly actor: string;
}
