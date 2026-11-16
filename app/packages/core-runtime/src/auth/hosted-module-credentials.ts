import { Schema } from 'effect';
import type { Effect, Option, Redacted } from 'effect';

export { HostedModuleCredentialsSealedError } from './hosted-module-credentials-sealed-error.ts';

/** A topology app id, the identity a module credential is bound to. */
export const ModuleAppIdSchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,99}$/u)).pipe(
  Schema.brand('ModuleAppId'),
);

const MINIMUM_KEY_LENGTH = 16;
const UUID = String.raw`[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}`;
const WORKLOAD_ENTRY = new RegExp(
  `^[a-z][a-z0-9-]{0,99}/[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+/${UUID}/${UUID}$`,
  'u',
);

/**
 * The handover entry of one internal workload credential: the module, its workload, and the tenant and company the
 * workload acts for (one active workload binding acts for one company, so each company has its own key).
 */
export const internalWorkloadEntryId = (entry: {
  readonly appId: string;
  readonly legalEntityId: string;
  readonly tenantId: string;
  readonly workloadKey: string;
}): string => `${entry.appId}/${entry.workloadKey}/${entry.tenantId}/${entry.legalEntityId}`;

/** Owners' internal workload credentials (O73), keyed `<app id>/<workload key>/<tenant id>/<company id>`. */
export const WorkloadCredentialsSchema = Schema.Record(
  Schema.String,
  Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(MINIMUM_KEY_LENGTH))),
).check(
  Schema.makeFilter((workloads) =>
    Object.keys(workloads).every((entry) => WORKLOAD_ENTRY.test(entry))
      ? undefined
      : 'Workload credentials are keyed by app id, workload key, tenant and company',
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
   * Owners' internal workload credentials, keyed `<app id>/<workload key>/<tenant id>/<company id>`: the key of the
   * principal the platform registered for one of the owner's own workloads in one company of one tenant (O73).
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

/**
 * A claimed store copy, as only its one-time claimer holds it: the receiver, and the copy's own reader (the very read
 * an owner's delegated client makes), so the host and the build can prove a handed key reaches that module and only it.
 */
export interface HostedModuleCredentialCopy extends HostedModuleCredentialReceiver {
  readonly read: (appId: string) => Effect.Effect<Option.Option<Redacted.Redacted>>;
}
