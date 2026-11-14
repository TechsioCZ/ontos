import { Schema } from 'effect';

import { OntosDeploymentAppIdSchema } from '../modules/manifest.ts';

/**
 * One hosted owner's compiled identity and the last composition revision its polling loop completed a
 * successful cycle under. Identity stays None until the loop reports it. JSON carries None as null.
 */
export const OutboxWorkerOwnerStatusSchema = Schema.Struct({
  admittedRevision: Schema.OptionFromNullOr(Schema.String),
  appId: Schema.OptionFromNullOr(OntosDeploymentAppIdSchema),
  buildMarker: Schema.OptionFromNullOr(Schema.String),
  lastSuccessAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
  ready: Schema.Boolean,
});
export type OutboxWorkerOwnerStatus = typeof OutboxWorkerOwnerStatusSchema.Type;

/**
 * Every hosted owner's admission, so a release can confirm that each owner admitted the composition it
 * published. No configuration values.
 */
export const OutboxWorkerHostStatusSchema = Schema.Struct({
  owners: Schema.Array(OutboxWorkerOwnerStatusSchema),
});
export type OutboxWorkerHostStatus = typeof OutboxWorkerHostStatusSchema.Type;

/** The JSON body the health server's /status route returns verbatim. */
export type OutboxWorkerHostStatusJson = typeof OutboxWorkerHostStatusSchema.Encoded;
