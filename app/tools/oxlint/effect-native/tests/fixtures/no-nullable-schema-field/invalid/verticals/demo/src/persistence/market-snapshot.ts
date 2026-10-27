// expect-count: 1
import { defineScopedRoutine } from '@app/core-runtime';
import { Schema } from 'effect';

const nonEmpty = Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed());
const SnapshotRowSchema = Schema.Struct({
  payload: Schema.Struct({
    nextApplicabilityBoundary: Schema.NullOr(nonEmpty),
  }),
});

// A native routine declaration is not an exemption for a raw nullable decoded model.
export const snapshotRoutine = defineScopedRoutine({
  name: 'read_market_snapshot',
  ownerModuleKey: 'demo.market',
  parameters: [{ source: 'tenantId', type: 'uuid' }],
  resultSchema: SnapshotRowSchema,
  routineKey: 'market.read-snapshot',
  schema: 'demo_market',
});
