// @generated-starting-point by OntOS Codesmith Action v1
// Browser-safe Action transport schemas. Owner-private behavior remains under src/actions.
import { Schema } from 'effect';
import {
  ChangeManualFxRatePolicyCommandSchema,
  ChangeManualFxRatePolicyResultSchema,
  ManualFxRatePolicyConflict,
  ManualFxRatePolicyInvalid,
  ManualFxRatePolicyPersistenceUnavailable,
} from '../domain/manual-commercial-rate-policy.ts';

export const ChangeManualCommercialRatePolicyPayloadSchema = ChangeManualFxRatePolicyCommandSchema;
export type ChangeManualCommercialRatePolicyPayload =
  typeof ChangeManualCommercialRatePolicyPayloadSchema.Type;

export const ChangeManualCommercialRatePolicyResultSchema = ChangeManualFxRatePolicyResultSchema;
export type ChangeManualCommercialRatePolicyResult =
  typeof ChangeManualCommercialRatePolicyResultSchema.Type;

export const ChangeManualCommercialRatePolicyErrorSchema = Schema.Union([
  ManualFxRatePolicyConflict,
  ManualFxRatePolicyInvalid,
  ManualFxRatePolicyPersistenceUnavailable,
]);
export type ChangeManualCommercialRatePolicyError =
  typeof ChangeManualCommercialRatePolicyErrorSchema.Type;
