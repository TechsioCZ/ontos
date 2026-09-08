import { Schema } from "effect";

// The audit target: declare the Schema first, derive the type from it.
export const TenantSchema = Schema.Struct({ tenantId: Schema.String });
export type Tenant = typeof TenantSchema.Type;

export const SessionSchema = Schema.Union([
	Schema.Struct({ _tag: Schema.Literal("anonymous") }),
	Schema.Struct({ _tag: Schema.Literal("authenticated"), tenant: TenantSchema }),
]);
export type Session = typeof SessionSchema.Type;

// Schema.Class / TaggedError entities carry their own type authority.
export class Contact extends Schema.Class<Contact>("Contact")({
	id: Schema.String,
	name: Schema.String,
}) {}

export class ContactNotFound extends Schema.TaggedError<ContactNotFound>()("ContactNotFound", {
	id: Schema.String,
}) {}

// Re-annotating with the *derived* type is not a competing authority.
export const TenantSchemaAlias: Schema.Codec<typeof TenantSchema.Type> = TenantSchema;
