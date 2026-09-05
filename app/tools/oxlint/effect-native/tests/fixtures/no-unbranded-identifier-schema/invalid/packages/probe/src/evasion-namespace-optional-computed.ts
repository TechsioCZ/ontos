// expect-count: 4
import * as Schema from 'effect/Schema';

// 1 — optional chaining on the namespace and on the leaf.
export const SessionSchema = Schema?.Struct({
  tenantId: Schema?.String,
  label: Schema.String,
});

// 2 — computed member access on the constructor, the leaf and the key.
export const RowSchema = Schema['Struct']({
  ['principalId']: Schema['String'],
});

// 3 — `as const` field bag wrapper.
export const OwnerSchema = Schema.Struct({
  legalEntityId: Schema.String.check(Schema.isUUID()),
} as const);

// 4 — shared identifier schema behind a `satisfies` wrapper.
export const ActionIdSchema = Schema.NonEmptyString satisfies unknown;
