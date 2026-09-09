import { createRequire } from 'node:module';

import { Layer, Result, Schema } from 'effect';
import type { Command } from 'effect/unstable/cli';

export const loadCoreNodeServices = () => {
  const loadFromCoreRuntime = createRequire(new URL('../../packages/core-runtime/package.json', import.meta.url));
  const nodePlatform: unknown = loadFromCoreRuntime('@effect/platform-node');
  const AnyLayerSchema = Schema.declare(Layer.isLayer);
  const NodeServicesLayerSchema = Schema.declare<Layer.Layer<Command.Environment>>(
    (value): value is Layer.Layer<Command.Environment> => Schema.is(AnyLayerSchema)(value),
  );
  const NodePlatformSchema = Schema.Struct({
    NodeServices: Schema.Struct({ layer: NodeServicesLayerSchema }),
  });
  const { NodeServices } = Result.getOrThrow(Schema.decodeUnknownResult(NodePlatformSchema)(nodePlatform));
  return NodeServices;
};
