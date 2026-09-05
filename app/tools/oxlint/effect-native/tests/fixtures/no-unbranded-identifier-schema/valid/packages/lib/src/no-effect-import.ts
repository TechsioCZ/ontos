const Schema = { String: 'string' as const, Struct: (fields: unknown) => fields };

export const FakeSchema = Schema.Struct({
  tenantId: Schema.String,
  principalId: Schema.String,
});
