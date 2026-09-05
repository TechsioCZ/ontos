// expect-count: 4
// Authorization rollout contract + would-deny readiness evidence read as opaque JSON in a script.
import * as Schema from 'effect/Schema';

const RolloutContractDocument = Schema.Record(Schema.String, Schema.Json);
const WouldDenyEvidence = Schema.Array(Schema.Json);

export const readRolloutContract = (raw: unknown) =>
  Schema.decodeUnknownEffect(RolloutContractDocument)(raw);

export const readWouldDenyEvidence = (raw: unknown) =>
  Schema.decodeUnknownEffect(WouldDenyEvidence)(raw);
