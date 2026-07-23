import { Schema } from '@modern-js/plugin-bff/effect-client';
export declare const searchEligiblePeoplePayloadSchema: Schema.Struct<{
    readonly collectionId: Schema.String;
    readonly query: Schema.String;
}>;
export declare const eligiblePersonDirectoryEntrySchema: Schema.Struct<{
    readonly displayName: Schema.optional<Schema.String>;
    readonly email: Schema.optional<Schema.String>;
    readonly login: Schema.optional<Schema.String>;
    readonly principalId: Schema.String;
}>;
export declare const searchEligiblePeopleResponseSchema: Schema.Struct<{
    readonly people: Schema.$Array<Schema.Struct<{
        readonly displayName: Schema.optional<Schema.String>;
        readonly email: Schema.optional<Schema.String>;
        readonly login: Schema.optional<Schema.String>;
        readonly principalId: Schema.String;
    }>>;
}>;
export type SearchEligiblePeoplePayload = typeof searchEligiblePeoplePayloadSchema.Type;
export type SearchEligiblePeopleResponse = typeof searchEligiblePeopleResponseSchema.Type;
