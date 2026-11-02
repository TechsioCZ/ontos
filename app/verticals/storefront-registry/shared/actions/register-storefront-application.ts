import { StorefrontApplicationIdSchema } from '@app/storefront-registry-contracts';
import { Schema } from 'effect';
import {
  StorefrontAdministrationReasonSchema,
  StorefrontApplicationChannelsSchema,
  StorefrontApplicationEffectiveIntervalSchema,
  StorefrontRegistryGenerationSchema,
} from '../action-contracts.ts';
import { StorefrontApplicationRefSchema } from '../resources/storefront-application.ts';

export const RegisterStorefrontApplicationPayloadSchema = Schema.Struct({
  allowedChannels: StorefrontApplicationChannelsSchema,
  effectiveInterval: StorefrontApplicationEffectiveIntervalSchema,
  lifecycle: Schema.Literals(['DRAFT', 'ACTIVE']),
  reason: StorefrontAdministrationReasonSchema,
  storefrontAppId: StorefrontApplicationIdSchema,
});
export type RegisterStorefrontApplicationPayload = typeof RegisterStorefrontApplicationPayloadSchema.Type;

export const RegisterStorefrontApplicationResultSchema = Schema.Struct({
  created: Schema.Boolean,
  generation: StorefrontRegistryGenerationSchema,
  revision: Schema.Literal(1),
  storefrontApplicationRef: StorefrontApplicationRefSchema,
});
