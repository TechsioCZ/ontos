import { Schema } from 'effect';
import {
  StorefrontAdministrationReasonSchema,
  StorefrontApplicationChannelsSchema,
  StorefrontApplicationEffectiveIntervalSchema,
  StorefrontApplicationLifecycleSchema,
  StorefrontApplicationRevisionSchema,
  StorefrontRegistryGenerationSchema,
} from '../action-contracts.ts';
import { StorefrontApplicationRefSchema } from '../resources/storefront-application.ts';

export const ReviseStorefrontApplicationPayloadSchema = Schema.Struct({
  allowedChannels: StorefrontApplicationChannelsSchema,
  effectiveInterval: StorefrontApplicationEffectiveIntervalSchema,
  expectedRevision: StorefrontApplicationRevisionSchema,
  lifecycle: StorefrontApplicationLifecycleSchema,
  reason: StorefrontAdministrationReasonSchema,
  storefrontApplicationRef: StorefrontApplicationRefSchema,
});
export type ReviseStorefrontApplicationPayload = typeof ReviseStorefrontApplicationPayloadSchema.Type;

export const ReviseStorefrontApplicationResultSchema = Schema.Struct({
  changed: Schema.Boolean,
  generation: StorefrontRegistryGenerationSchema,
  previousRevision: StorefrontApplicationRevisionSchema,
  revision: StorefrontApplicationRevisionSchema,
  storefrontApplicationRef: StorefrontApplicationRefSchema,
});
