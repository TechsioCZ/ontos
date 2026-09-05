// The Effect v4 target shape: real Schemas for the composition contract, decoded through the
// Effect-native codec entry points. Nothing here is shape-free JSON.
import { Schema } from 'effect';

export const ReferenceTopology = Schema.Struct({
  revision: Schema.String,
  verticals: Schema.Array(Schema.Struct({ id: Schema.String, kind: Schema.Literal('vertical') })),
});

export const DeploymentAllowlist = Schema.Record(Schema.String, Schema.String);

export const decodeReferenceTopology = Schema.decodeUnknownEffect(ReferenceTopology);
export const decodeDeploymentAllowlist = Schema.decodeUnknownEffect(DeploymentAllowlist);

export type ReferenceTopologyDocument = Schema.Schema.Type<typeof ReferenceTopology>;
