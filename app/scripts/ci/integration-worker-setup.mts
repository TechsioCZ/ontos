import { Option, Result, Schema } from 'effect';
import { IntegrationWorkerSettingsSchema, integrationWorkerEnvironment } from './integration-worker-environment.mts';

// This is the Rstest process-start adapter, before test imports or Effect roots exist.
// Its child processes must inherit the same slot-owned services as the test itself.
const nodeProcess = process.getBuiltinModule('node:process');
const settings = Result.getOrThrow(Schema.decodeUnknownResult(IntegrationWorkerSettingsSchema)(nodeProcess.env));
const overrides = integrationWorkerEnvironment(settings);
if (Option.isSome(overrides)) {
  Object.assign(nodeProcess.env, overrides.value);
}
