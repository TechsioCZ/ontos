// expect-count: 2
// Evasion: the shared-column object is spread into a real field bag but is named `auditColumns`
// rather than `auditFields`, so the `*Fields` suffix heuristic no longer sees it.
import { Schema } from 'effect';

const auditColumns = {
  // 1 createdAt
  createdAt: Schema.String,
  // 2 updatedAt
  updatedAt: Schema.String,
  actor: Schema.String,
};

export const CustomerSchema = Schema.Struct({
  ...auditColumns,
  name: Schema.String,
});
