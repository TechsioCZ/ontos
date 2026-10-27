import { defineScopedRoutine } from '@app/core-runtime';
import { Schema } from 'effect';

const nonEmpty = Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed());
const SnapshotRowSchema = Schema.Struct({
  payload: Schema.Struct({
    nextApplicabilityBoundary: Schema.OptionFromNullOr(nonEmpty),
  }),
});

// The routine decodes SQL null into None without changing its encoded null/string contract.
export const snapshotRoutine = defineScopedRoutine({
  name: 'read_market_snapshot',
  ownerModuleKey: 'demo.market',
  parameters: [{ source: 'tenantId', type: 'uuid' }],
  resultSchema: SnapshotRowSchema,
  routineKey: 'market.read-snapshot',
  schema: 'demo_market',
});
