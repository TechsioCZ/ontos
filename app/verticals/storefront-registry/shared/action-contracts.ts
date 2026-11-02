import { StorefrontChannelSchema, StorefrontRegistryInstantSchema } from '@app/storefront-registry-contracts';
import { DateTime, Schema } from 'effect';

export const StorefrontApplicationRevisionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export const StorefrontRegistryGenerationSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const StorefrontAdministrationReasonSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(500),
  Schema.isTrimmed(),
);
export const StorefrontApplicationChannelsSchema = Schema.Array(StorefrontChannelSchema).check(
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

export class StorefrontApplicationCommandRejected extends Schema.TaggedError<StorefrontApplicationCommandRejected>()(
  'StorefrontApplicationCommandRejected',
  {
    code: Schema.Literals([
      'application_already_registered',
      'application_not_found',
      'revision_conflict',
      'retired_lifecycle_terminal',
    ]),
    reason: StorefrontAdministrationReasonSchema,
  },
) {}
