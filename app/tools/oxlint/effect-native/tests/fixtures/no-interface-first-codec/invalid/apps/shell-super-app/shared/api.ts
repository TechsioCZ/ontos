// expect-count: 5
import { Schema } from "effect";

export interface SafeTenantIdentity {
	readonly tenantId: string;
}
export interface CurrentSession {
	readonly tenant: SafeTenantIdentity;
}
export interface SignInPayload {
	readonly email: string;
}
export interface ShellNavigationItem {
	readonly href: string;
}
export interface ShellSearchResponse {
	readonly items: ReadonlyArray<ShellNavigationItem>;
}

// 1. the canonical A2 shape: interface first, Schema annotated to match it.
export const SafeTenantIdentitySchema: Schema.Codec<SafeTenantIdentity> = Schema.Struct({
	tenantId: Schema.String,
});

// 2. union constructor, same second authority.
export const CurrentSessionSchema: Schema.Codec<CurrentSession> = Schema.Union([
	Schema.Struct({ tenant: SafeTenantIdentitySchema }),
]);

// 3. multi-line annotation spanning the declarator.
export const SignInPayloadSchema: Schema.Codec<SignInPayload> =
	Schema.Struct({ email: Schema.String });

// 4. pipe chain initializer still hides behind a prior interface.
export const ShellNavigationItemSchema: Schema.Codec<ShellNavigationItem> = Schema.Struct({
	href: Schema.String,
}).pipe(Schema.annotate({ title: "nav" }));

// 5. two-argument codec form.
export const ShellSearchResponseSchema: Schema.Codec<ShellSearchResponse, unknown> = Schema.Struct({
	items: Schema.Array(ShellNavigationItemSchema),
});
