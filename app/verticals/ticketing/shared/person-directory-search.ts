import { Schema } from '@modern-js/plugin-bff/effect-client';

export const searchEligiblePeoplePayloadSchema = Schema.Struct({
  collectionId: Schema.String,
  query: Schema.String,
});

export const eligiblePersonDirectoryEntrySchema = Schema.Struct({
  displayName: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  login: Schema.optional(Schema.String),
  principalId: Schema.String,
});

export const searchEligiblePeopleResponseSchema = Schema.Struct({
  people: Schema.Array(eligiblePersonDirectoryEntrySchema),
});

export type SearchEligiblePeoplePayload = typeof searchEligiblePeoplePayloadSchema.Type;
export type SearchEligiblePeopleResponse = typeof searchEligiblePeopleResponseSchema.Type;
