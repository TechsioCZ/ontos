// expect-count: 5
import { Schema } from 'effect';

// 1 — field bag built inside a nested arrow body.
export const makeRowSchema = () => () => Schema.Struct({ customerId: Schema.String, label: Schema.String });

// 2 — `Schema.Class` field bag.
export class Deployment extends Schema.Class<Deployment>('Deployment')({
  deploymentId: Schema.String,
  name: Schema.String,
}) {}

// 3 — static class member.
export class Registry {
  static readonly schema = Schema.Struct({ moduleId: Schema.NonEmptyString });
}

// 4 — inside a JSX callback prop.
export const Panel = (): unknown => (
  <button onClick={() => Schema.Struct({ contributionKey: Schema.Trim })} type="button">
    go
  </button>
);

// 5 — nested field bag inside a TaggedRequest payload.
export class FetchRow extends Schema.TaggedRequest<FetchRow>()('FetchRow', {
  success: Schema.String,
  payload: Schema.Struct({ idempotencyKey: Schema.String }),
}) {}
