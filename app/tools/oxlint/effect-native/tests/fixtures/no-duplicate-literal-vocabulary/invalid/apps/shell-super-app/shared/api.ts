// expect-count: 3
// Mirrors apps/shell-super-app/shared/api.ts: Schema comes from the BFF effect-client barrel and the
// same principal / API-key status vocabularies are inlined again next to their named declaration.
import { Schema } from '@modern-js/plugin-bff/effect-client';

const principalStatus = Schema.Literals(['active', 'disabled', 'archived']);
const identityReason = Schema.String;

export const ChangePrincipalStatusPayloadSchema = Schema.Struct({
  expectedStatus: principalStatus,
  newStatus: Schema.Literals(['disabled', 'archived']),
  reason: identityReason,
});

// Re-inlines the `principalStatus` vocabulary instead of referencing the constant.
export const ManagedApiKeyListItemSchema = Schema.Struct({
  kind: Schema.Literals(['service', 'integration']),
  principalStatus: Schema.Literals(['active', 'disabled', 'archived']),
});

const MutableApiKeyBindingStatusSchema = Schema.Literals(['active', 'disabled']);

export const SetApiKeyStatusPayloadSchema = Schema.Struct({
  expectedStatus: MutableApiKeyBindingStatusSchema,
  newStatus: Schema.Literals(['active', 'disabled']),
});

export const SetManagedApiKeyStatusPayloadSchema = Schema.Struct({
  expectedStatus: MutableApiKeyBindingStatusSchema,
  newStatus: Schema.Literals(['active', 'disabled']),
});

// A superset of the `kind` vocabulary above: a strict superset is not a duplicate.
export const CreateNonHumanPrincipalPayloadSchema = Schema.Struct({
  kind: Schema.Literals(['service', 'integration', 'system']),
});
