import { Schema } from 'effect';
import type { Effect } from 'effect';

export { HostedModuleCredentialsSealedError } from './hosted-module-credentials-sealed-error.ts';

/** A topology app id, the identity a module credential is bound to. */
export const ModuleAppIdSchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,99}$/u)).pipe(
  Schema.brand('ModuleAppId'),
);

/** The variable every module deployment reads as its own module credential. */
export const MODULE_CREDENTIAL_VARIABLE = 'ONTOS_GATEWAY_MODULE_API_KEY';

const MINIMUM_KEY_LENGTH = 16;
const WORKLOAD_ENTRY =
  /^[a-z][a-z0-9-]{0,99}\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+\/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u;

/** Owners' internal workload credentials (O73), keyed `<app id>/<workload key>/<tenant id>`. */
export const WorkloadCredentialsSchema = Schema.Record(
  Schema.String,
  Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(MINIMUM_KEY_LENGTH))),
).check(
  Schema.makeFilter((workloads) =>
    Object.keys(workloads).every((entry) => WORKLOAD_ENTRY.test(entry))
      ? undefined
      : 'Workload credentials are keyed by app id, workload key and tenant',
  ),
);

/**
 * What a host hands a process that serves several owners: owners' module credentials, keyed by app id. It travels on
 * that process's private handover channel and is kept only in its memory, never in an environment variable.
 */
export const HostedModuleCredentialsSchema = Schema.Struct({
  credentials: Schema.Record(
    Schema.String,
    Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(MINIMUM_KEY_LENGTH))),
  ).check(
    // Refuse rather than drop: a handover naming something other than a topology app id is not this host's.
    Schema.makeFilter((credentials) =>
      Object.keys(credentials).every(Schema.is(ModuleAppIdSchema)) ? undefined : 'Credentials are keyed by app id',
    ),
  ),
  schemaVersion: Schema.Literal(1),
  /**
   * Owners' internal workload credentials, keyed `<app id>/<workload key>/<tenant id>`: the key of the principal the
   * operator registered for one of the owner's own workloads in one tenant (O73).
   */
  workloads: Schema.optionalKey(WorkloadCredentialsSchema),
});
export type HostedModuleCredentials = typeof HostedModuleCredentialsSchema.Type;

/** The app id a workload credential entry belongs to. */
export const workloadEntryAppId = (entry: string): string => entry.slice(0, entry.indexOf('/'));

/** What one handover changed: the owners whose slot now holds the handed key, and the entries it refused. */
export interface HostedModuleCredentialAcceptance {
  readonly accepted: readonly string[];
  readonly refused: readonly string[];
}

/** The one receiver of a multi-owner process: only the host code that claimed it fills or replaces owners' keys. */
export interface HostedModuleCredentialReceiver {
  readonly accept: (handover: HostedModuleCredentials) => Effect.Effect<HostedModuleCredentialAcceptance>;
  readonly owners: readonly string[];
}
