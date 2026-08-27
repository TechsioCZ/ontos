import { Schema } from 'effect';
import type { ResolvedModuleTarget, ResolveModuleTargetPayload } from '../../shared/api.ts';

const stableEntrypointKeySchema = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
);

export const GovernedResolveModuleTargetPayloadSchema: Schema.Codec<ResolveModuleTargetPayload> =
  Schema.Struct({
    entrypointKey: Schema.optionalKey(stableEntrypointKeySchema),
    moduleId: Schema.String.check(Schema.isMinLength(3)),
  });

export const GovernedResolvedModuleTargetSchema: Schema.Codec<ResolvedModuleTarget> = Schema.Struct(
  {
    appId: Schema.String,
    componentKey: Schema.String,
    entrypointKey: Schema.String,
    moduleId: Schema.String,
    writable: Schema.Boolean,
  },
);
