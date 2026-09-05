// expect-count: 3
// Evasion: two levels of shared-column objects, neither named `*Fields`, plus a template-literal
// computed member on the constructor.
import * as Schema from 'effect/Schema';

const timestampColumns = {
  // 1 createdAt
  createdAt: Schema.String,
  // 2 updatedAt
  updatedAt: Schema.String,
};

const auditColumns = {
  ...timestampColumns,
  actor: Schema.String,
};

export const CustomerSchema = Schema[`Struct`]({
  ...auditColumns,
  // 3 archivedAt
  archivedAt: Schema.NullOr(Schema.String),
  name: Schema.String,
});
