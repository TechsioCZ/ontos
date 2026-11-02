import { Context, Effect, Schema } from 'effect';

import { LegacyCompletionPublicationError } from './legacy-completion-publication-error.ts';
import { OntosModuleIdSchema } from './manifest.ts';

export { LegacyCompletionPublicationError } from './legacy-completion-publication-error.ts';

export const LegacyCompletionTransactionIdSchema = Schema.String.pipe(Schema.brand('LegacyCompletionTransactionId'));

export const LegacyCompletionRuntimeTargetSchema = Schema.Struct({
  databaseName: Schema.String,
  host: Schema.String,
  port: Schema.Int,
  user: Schema.String,
});
export type LegacyCompletionRuntimeTarget = typeof LegacyCompletionRuntimeTargetSchema.Type;

export const LegacyCompletionNativeBindingSchema = Schema.Struct({
  databaseName: Schema.String,
  databaseOid: Schema.String,
  databaseUser: Schema.String,
  observedAt: Schema.DateTimeUtc,
  runtimeRoleOid: Schema.String,
  runtimeTarget: LegacyCompletionRuntimeTargetSchema,
  runtimeUser: Schema.String,
  systemIdentifier: Schema.String,
  transactionId: LegacyCompletionTransactionIdSchema,
});
export type LegacyCompletionNativeBinding = typeof LegacyCompletionNativeBindingSchema.Type;

export const LegacyCompletionPublicationBindingSchema = Schema.Struct({
  ...LegacyCompletionNativeBindingSchema.fields,
  expectedRevision: Schema.OptionFromNullOr(Schema.String),
});
export type LegacyCompletionPublicationBinding = typeof LegacyCompletionPublicationBindingSchema.Type;

export interface LegacyCompletionMessageEvidence {
  readonly completionConsumerModuleKey: string | null;
  readonly completionOriginalRevision: string | null;
  readonly deliveries: readonly {
    readonly consumerModuleKey: string;
    readonly status: string;
    readonly workerKey: string;
  }[];
  readonly outboxMessageId: string;
  readonly payloadJson: unknown;
  readonly tenantId: string;
}

export interface LegacyCompletionPublicationObservation {
  readonly binding: LegacyCompletionPublicationBinding;
  readonly complete: boolean;
  readonly evidenceReference: string;
  readonly messages: readonly LegacyCompletionMessageEvidence[];
}

export const LegacyCompletionStatusSchema = Schema.Literals(['VERIFIED_ABSENT', 'UNRESOLVED', 'UNKNOWN']);

export interface LegacyCompletionOwnerResult {
  readonly binding: LegacyCompletionPublicationBinding;
  readonly evidenceReference: string;
  readonly status: typeof LegacyCompletionStatusSchema.Type;
}

export interface LegacyCompletionOwnerLease {
  readonly binding: LegacyCompletionNativeBinding;
  readonly verify: (
    observation: LegacyCompletionPublicationObservation,
  ) => Effect.Effect<LegacyCompletionOwnerResult, LegacyCompletionPublicationError>;
}

export interface LegacyCompletionOwnerVerifier {
  readonly producerModuleKey: string;
  readonly topic: string;
  readonly withLease: <Value, Failure, Requirements>(
    use: (lease: LegacyCompletionOwnerLease) => Effect.Effect<Value, Failure, Requirements>,
  ) => Effect.Effect<Value, Failure | LegacyCompletionPublicationError, Requirements>;
}

/** Only native bindings and the sanitized owner conclusion enter retained operator evidence. */
export const LegacyCompletionRetainedObservationSchema = Schema.Struct({
  binding: LegacyCompletionPublicationBindingSchema,
  evidenceReference: Schema.String,
  ownerBinding: LegacyCompletionNativeBindingSchema,
  producerModuleKey: OntosModuleIdSchema,
  status: LegacyCompletionStatusSchema,
  topic: OntosModuleIdSchema,
});
export type LegacyCompletionRetainedObservation = typeof LegacyCompletionRetainedObservationSchema.Type;

/** Deployment control plane only. This capability is never installed in business runtimes. */
export class LegacyCompletionPublication extends Context.Service<
  LegacyCompletionPublication,
  {
    readonly owners: readonly LegacyCompletionOwnerVerifier[];
    readonly retainEvidence: (
      observation: LegacyCompletionRetainedObservation,
    ) => Effect.Effect<void, LegacyCompletionPublicationError>;
    readonly runtimeTarget: LegacyCompletionRuntimeTarget;
    readonly runtimeUser: string;
  }
>()('@app/core-runtime/modules/legacy-completion-publication/LegacyCompletionPublication') {}

/** Separate owner/Core transactions must address the same physical database and runtime identity. */
export const sameLegacyCompletionDatabase = (
  owner: LegacyCompletionNativeBinding,
  core: LegacyCompletionNativeBinding,
): boolean =>
  owner.databaseName === core.databaseName &&
  owner.databaseOid === core.databaseOid &&
  owner.systemIdentifier === core.systemIdentifier &&
  owner.runtimeUser === core.runtimeUser &&
  owner.runtimeRoleOid === core.runtimeRoleOid &&
  owner.runtimeTarget.databaseName === core.runtimeTarget.databaseName &&
  owner.runtimeTarget.host === core.runtimeTarget.host &&
  owner.runtimeTarget.port === core.runtimeTarget.port &&
  owner.runtimeTarget.user === core.runtimeTarget.user;

/** Missing or replayed owner evidence cannot become an absence assertion. */
export const validateLegacyCompletionOwnerResult = (
  observation: LegacyCompletionPublicationObservation,
  ownerBinding: LegacyCompletionNativeBinding,
  result: LegacyCompletionOwnerResult,
): Effect.Effect<void, LegacyCompletionPublicationError> =>
  observation.complete &&
  sameLegacyCompletionDatabase(ownerBinding, observation.binding) &&
  result.binding === observation.binding &&
  result.evidenceReference === observation.evidenceReference &&
  result.evidenceReference.length > 0 &&
  result.status === 'VERIFIED_ABSENT'
    ? Effect.void
    : Effect.fail(new LegacyCompletionPublicationError({ reason: 'Legacy owner completion absence is unverified' }));
