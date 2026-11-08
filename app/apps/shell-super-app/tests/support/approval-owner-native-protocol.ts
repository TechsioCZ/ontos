import { ActiveApplicationCompositionSnapshotSchema, OntosDeploymentIdentitySchema } from '@app/core-runtime';
import { Schema } from 'effect';

/** Private process input. Secrets are encoded only into the owned child's stdin, never diagnostics. */
export const NativeOwnerApprovalConfigurationSchema = Schema.Struct({
  compositionSnapshot: ActiveApplicationCompositionSnapshotSchema,
  databaseEnvironment: Schema.RedactedFromValue(Schema.Record(Schema.String, Schema.String)),
  expectedDeployment: OntosDeploymentIdentitySchema,
  issuer: Schema.String,
  publicJwks: Schema.String,
  spiceDbEnvironment: Schema.RedactedFromValue(Schema.Record(Schema.String, Schema.String)),
});

export const NativeOwnerApprovalListeningSchema = Schema.Struct({
  baseUrl: Schema.String,
  pid: Schema.Int,
  type: Schema.Literal('LISTENING'),
});

export const NativeOwnerApprovalReadySchema = Schema.Struct({
  baseUrl: Schema.String,
  deployment: OntosDeploymentIdentitySchema,
  pid: Schema.Int,
  type: Schema.Literal('READY'),
});
