import {
  StorefrontApplicationIdSchema,
  StorefrontChannelSchema,
  StorefrontRegistryInstantSchema,
} from '@app/storefront-registry-contracts';
import { DateTime, Schema } from 'effect';
import { StorefrontApplicationRefSchema } from './resources/storefront-application.ts';

const positiveRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const generation = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const reason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500), Schema.isTrimmed());
const channels = Schema.Array(StorefrontChannelSchema).check(
  Schema.isMinLength(1),
  Schema.makeFilter((values) => new Set(values).size === values.length || 'Allowed channels must be unique'),
);

export const StorefrontApplicationLifecycleSchema = Schema.Literals(['DRAFT', 'ACTIVE', 'SUSPENDED', 'RETIRED']);

export const StorefrontApplicationEffectiveIntervalSchema = Schema.Struct({
  effectiveFrom: StorefrontRegistryInstantSchema,
  effectiveTo: Schema.optionalKey(StorefrontRegistryInstantSchema),
}).check(
  Schema.makeFilter(({ effectiveFrom, effectiveTo }) =>
    effectiveTo === undefined ||
    DateTime.toEpochMillis(DateTime.makeUnsafe(effectiveFrom)) <
      DateTime.toEpochMillis(DateTime.makeUnsafe(effectiveTo))
      ? undefined
      : 'Effective interval end must be after its start',
  ),
);

export const RegisterStorefrontApplicationPayloadSchema = Schema.Struct({
  allowedChannels: channels,
  effectiveInterval: StorefrontApplicationEffectiveIntervalSchema,
  lifecycle: Schema.Literals(['DRAFT', 'ACTIVE']),
  reason,
  storefrontAppId: StorefrontApplicationIdSchema,
});
export type RegisterStorefrontApplicationPayload = typeof RegisterStorefrontApplicationPayloadSchema.Type;

export const RegisterStorefrontApplicationResultSchema = Schema.Struct({
  created: Schema.Boolean,
  generation,
  revision: Schema.Literal(1),
  storefrontApplicationRef: StorefrontApplicationRefSchema,
});

export const ReviseStorefrontApplicationPayloadSchema = Schema.Struct({
  allowedChannels: channels,
  effectiveInterval: StorefrontApplicationEffectiveIntervalSchema,
  expectedRevision: positiveRevision,
  lifecycle: StorefrontApplicationLifecycleSchema,
  reason,
  storefrontApplicationRef: StorefrontApplicationRefSchema,
});
export type ReviseStorefrontApplicationPayload = typeof ReviseStorefrontApplicationPayloadSchema.Type;

export const ReviseStorefrontApplicationResultSchema = Schema.Struct({
  changed: Schema.Boolean,
  generation,
  previousRevision: positiveRevision,
  revision: positiveRevision,
  storefrontApplicationRef: StorefrontApplicationRefSchema,
});

export class StorefrontApplicationCommandRejected extends Schema.TaggedError<StorefrontApplicationCommandRejected>()(
  'StorefrontApplicationCommandRejected',
  {
    code: Schema.Literals([
      'application_already_registered',
      'application_not_found',
      'revision_conflict',
      'retired_lifecycle_terminal',
    ]),
    reason,
  },
) {}
