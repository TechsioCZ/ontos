// A local `Schema` that is not the Effect one must never be treated as Effect's.
const Schema = {
  Struct: (fields: Record<string, unknown>) => fields,
  String: 'string' as const,
};

export const RowSchema = Schema.Struct({
  createdAt: Schema.String,
  revokedAt: Schema.String,
});
