import { getOrThrow as getResultOrThrow } from 'effect/Result';
import {
  Literal,
  Literals,
  String as StringSchema,
  Struct,
  Union,
  decodeUnknownResult,
  isMaxLength,
  isMinLength,
  isPattern,
} from 'effect/Schema';
import type { Schema } from 'effect/Schema';

export const ACTION_PROVISIONING_INTENTS = [
  'tenant_membership_default',
  'explicit',
  'principal_self_credentials',
] as const;

export const ActionProvisioningIntentSchema = Literals(ACTION_PROVISIONING_INTENTS);
export type ActionProvisioningIntent = Schema.Type<typeof ActionProvisioningIntentSchema>;

const stablePermissionSchema = StringSchema.check(
  isMinLength(3),
  isMaxLength(200),
  isPattern(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u),
);

export const IntentionalPublicAuthorizationSchema = Struct({
  kind: Literal('public'),
});

export const AuthenticatedPrincipalAuthorizationSchema = Struct({
  kind: Literal('authenticated_principal'),
});

export const ContextPermissionAuthorizationSchema = Struct({
  kind: Literal('context_permission'),
  permission: stablePermissionSchema,
});

export const ActionExecutionAuthorizationSchema = Struct({
  kind: Literal('action_execution'),
  provisioning: ActionProvisioningIntentSchema,
});

export const OwnerLocalBackgroundAuthorizationSchema = Struct({
  kind: Literal('owner_local_background'),
});

export const CapabilityIssuanceAuthorizationSchema = Struct({
  credential: Literals(['api_key', 'session']),
  kind: Literal('capability_issuance'),
});

export const EntrypointAuthorizationSchema = Union([
  IntentionalPublicAuthorizationSchema,
  AuthenticatedPrincipalAuthorizationSchema,
  ContextPermissionAuthorizationSchema,
  ActionExecutionAuthorizationSchema,
  OwnerLocalBackgroundAuthorizationSchema,
  CapabilityIssuanceAuthorizationSchema,
]);

export type EntrypointAuthorization = Schema.Type<typeof EntrypointAuthorizationSchema>;
export type ActionExecutionAuthorization = Schema.Type<typeof ActionExecutionAuthorizationSchema>;

export const decodeEntrypointAuthorization = <Input>(input: Input): EntrypointAuthorization =>
  Object.freeze(
    getResultOrThrow(
      decodeUnknownResult(EntrypointAuthorizationSchema, {
        onExcessProperty: 'error',
      })(input),
    ),
  );
