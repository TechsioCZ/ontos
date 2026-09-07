import { Schema } from 'effect';

const EntrypointKeySchema = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
).pipe(Schema.brand('EntrypointKey'));
const ModuleIdSchema = Schema.String.check(Schema.isMinLength(3)).pipe(Schema.brand('ModuleId'));
const AppIdSchema = Schema.String.pipe(Schema.brand('AppId'));
const ComponentKeySchema = Schema.String.pipe(Schema.brand('ComponentKey'));

export const GovernedResolveModuleTargetPayloadSchema = Schema.Struct({
  entrypointKey: Schema.optionalKey(EntrypointKeySchema),
  moduleId: ModuleIdSchema,
});

export const GovernedResolvedModuleTargetSchema = Schema.Struct({
  appId: AppIdSchema,
  componentKey: ComponentKeySchema,
  entrypointKey: EntrypointKeySchema,
  moduleId: ModuleIdSchema,
  writable: Schema.Boolean,
});
