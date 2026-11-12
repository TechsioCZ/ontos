import { Schema } from 'effect';

import { PaymentReasonSchema, PaymentRevisionSchema } from '../domain/payment-identifiers.ts';
import {
  GatewayCredentialRevisionViewSchema,
  GatewayCredentialSecretRefSchema,
  GatewayHttpsUrlSchema,
  GatewayMerchantIdentitySchema,
  GatewayProviderAccountBindingViewSchema,
  GatewayProviderAccountRefSchema,
} from '../domain/psp-configuration.ts';
import { GatewayEnvironmentSchema } from '../domain/psp-vocabulary.ts';

/**
 * Configure one Provider Account Binding of the trusted Selling Legal Entity (#1155). Tenant and Selling
 * Legal Entity come from the Core-verified scope, never from this payload. The gateway family is the
 * merchant identity's own tag, so only that family's identity shape is accepted. Account identity
 * (family, environment, merchant identity, `pab_` ref) is fixed when the binding is created; a different
 * merchant account is a new binding that replaces the Current one for new Payment intents only.
 */

/** The Current binding a new binding replaces, decided against its revision. */
const ReplacedBindingSchema = Schema.Struct({
  expectedRevision: PaymentRevisionSchema,
  providerAccountRef: GatewayProviderAccountRefSchema,
});

/**
 * Creates a binding with credential revision 1. When the family and environment already have a Current
 * binding, `replaces` must name it at its Current revision; it is then retired for new intents in the
 * same transaction and stays addressable for its historical operations.
 */
const CreateProviderAccountBindingSchema = Schema.TaggedStruct('CREATE', {
  environment: GatewayEnvironmentSchema,
  merchantIdentity: GatewayMerchantIdentitySchema,
  notificationUrl: GatewayHttpsUrlSchema,
  reason: PaymentReasonSchema,
  replaces: Schema.optionalKey(ReplacedBindingSchema),
  /** Name of the credential material in the deployment secret store; never the secret itself. */
  secretRef: GatewayCredentialSecretRefSchema,
});

/** Retires a Current binding for new Payment intents. Existing operations keep resolving it. */
const RetireProviderAccountBindingSchema = Schema.TaggedStruct('RETIRE', {
  expectedRevision: PaymentRevisionSchema,
  providerAccountRef: GatewayProviderAccountRefSchema,
  reason: PaymentReasonSchema,
});

export const ProviderAccountBindingChangeSchema = Schema.Union([
  CreateProviderAccountBindingSchema,
  RetireProviderAccountBindingSchema,
]);
export type ProviderAccountBindingChange = typeof ProviderAccountBindingChangeSchema.Type;

export const ConfigureProviderAccountBindingPayloadSchema = Schema.Struct({
  change: ProviderAccountBindingChangeSchema,
});
export type ConfigureProviderAccountBindingPayload = typeof ConfigureProviderAccountBindingPayloadSchema.Type;

/** No secret and no secret reference is ever returned. */
export const ConfigureProviderAccountBindingResultSchema = Schema.Struct({
  /** The created binding (CREATE) or the retired binding (RETIRE). */
  binding: GatewayProviderAccountBindingViewSchema,
  /** Actual time of the change; never backdated. */
  configuredAt: Schema.DateTimeUtcFromString,
  /** The binding's ACTIVE credential revision. */
  credential: GatewayCredentialRevisionViewSchema,
  /** The previously Current binding a CREATE retired for new intents. */
  replaced: Schema.optionalKey(GatewayProviderAccountBindingViewSchema),
});
export type ConfigureProviderAccountBindingResult = typeof ConfigureProviderAccountBindingResultSchema.Type;

const PROVIDER_ACCOUNT_BINDING_CONFLICT_CODES = [
  /** `expectedRevision` is not the binding's Current revision (stale write). */
  'gateway_binding_revision_conflict',
  /** CREATE without `replaces` while the family and environment already have a Current binding. */
  'gateway_binding_current_exists',
  /** The named binding is already retired for new intents. */
  'gateway_binding_not_current',
  /** `replaces` names a binding of another family or environment, or not the Current one. */
  'gateway_binding_replacement_mismatch',
  /** A rotation named the secret reference the binding already uses. */
  'gateway_credential_unchanged',
] as const;

const makeBindingError = <const Tag extends string, const Fields extends Schema.Struct.Fields>(
  tag: Tag,
  fields: Fields,
) => {
  const schema = Schema.TaggedStruct(tag, fields);
  return Schema.TaggedError<Schema.Schema.Type<typeof schema>>()(tag, fields);
};

/** The binding changed meanwhile or the requested change does not apply to it. Nothing was written. */
export const ProviderAccountBindingConflict = makeBindingError('ProviderAccountBindingConflict', {
  code: Schema.Literals(PROVIDER_ACCOUNT_BINDING_CONFLICT_CODES),
  reason: Schema.String,
});
export type ProviderAccountBindingConflictError = Schema.Schema.Type<typeof ProviderAccountBindingConflict>;

export const providerAccountBindingConflict = (code: ProviderAccountBindingConflictError['code'], reason: string) =>
  new ProviderAccountBindingConflict({ code, reason });

/** No binding with this ref exists in the trusted Tenant and Selling Legal Entity. */
export const ProviderAccountBindingNotFound = makeBindingError('ProviderAccountBindingNotFound', {
  code: Schema.Literal('gateway_binding_not_found'),
  reason: Schema.String,
});
export type ProviderAccountBindingNotFoundError = Schema.Schema.Type<typeof ProviderAccountBindingNotFound>;

export const providerAccountBindingNotFound = (reason: string) =>
  new ProviderAccountBindingNotFound({ code: 'gateway_binding_not_found', reason });
