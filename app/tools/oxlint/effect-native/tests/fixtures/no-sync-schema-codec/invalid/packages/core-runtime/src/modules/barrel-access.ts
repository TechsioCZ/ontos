// expect-count: 2
// The Effect barrel reaches the same members: `Effect.Schema.decodeUnknownSync`.
import * as Effect from 'effect';

const TopologySchema = Effect.Schema.Struct({ id: Effect.Schema.String });

export const decodeTopology = (value: unknown): { readonly id: string } =>
	Effect.Schema.decodeUnknownSync(TopologySchema)(value);

export const decodeTopologyStrict = (value: unknown): { readonly id: string } =>
	Effect.Schema.decodeSync(TopologySchema)(value as never);
