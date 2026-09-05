// A local `Schema` that is not Effect's Schema must not report.
const Schema = {
  NullOr: (value: string) => value,
  Struct: (fields: Record<string, unknown>) => fields,
};

export const RowSchema = Schema.Struct({
  archivedAt: Schema.NullOr('x'),
});

export function build(Schema2: { NullOr: (value: string) => string }) {
  return Schema2.NullOr('y');
}
