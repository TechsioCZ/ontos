import { Schema } from 'effect';

export const ACTION_PROVISIONING_INTENTS = ['tenant_membership_default', 'explicit'] as const;

export const ActionProvisioningIntentSchema = Schema.Literals(ACTION_PROVISIONING_INTENTS);
export type ActionProvisioningIntent = Schema.Schema.Type<typeof ActionProvisioningIntentSchema>;

const stablePermissionSchema = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u),
);

export const IntentionalPublicAuthorizationSchema = Schema.Struct({
  kind: Schema.Literal('public'),
});

export const AuthenticatedPrincipalAuthorizationSchema = Schema.Struct({
  kind: Schema.Literal('authenticated_principal'),
});

export const ContextPermissionAuthorizationSchema = Schema.Struct({
  kind: Schema.Literal('context_permission'),
  permission: stablePermissionSchema,
});

export const ActionExecutionAuthorizationSchema = Schema.Struct({
  kind: Schema.Literal('action_execution'),
  provisioning: ActionProvisioningIntentSchema,
});

export const OwnerLocalBackgroundAuthorizationSchema = Schema.Struct({
  kind: Schema.Literal('owner_local_background'),
});

export const CapabilityIssuanceAuthorizationSchema = Schema.Struct({
  credential: Schema.Literals(['api_key', 'session']),
  kind: Schema.Literal('capability_issuance'),
});

export const EntrypointAuthorizationSchema = Schema.Union([
  IntentionalPublicAuthorizationSchema,
  AuthenticatedPrincipalAuthorizationSchema,
  ContextPermissionAuthorizationSchema,
  ActionExecutionAuthorizationSchema,
  OwnerLocalBackgroundAuthorizationSchema,
  CapabilityIssuanceAuthorizationSchema,
]);

export type EntrypointAuthorization = Schema.Schema.Type<typeof EntrypointAuthorizationSchema>;
export type ActionExecutionAuthorization = Schema.Schema.Type<
  typeof ActionExecutionAuthorizationSchema
>;

export const decodeEntrypointAuthorization = <Input>(input: Input): EntrypointAuthorization =>
  Object.freeze(
    Schema.decodeUnknownSync(EntrypointAuthorizationSchema, {
      onExcessProperty: 'error',
    })(input),
  );
