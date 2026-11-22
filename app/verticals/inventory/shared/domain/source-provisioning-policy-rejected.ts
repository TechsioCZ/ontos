import { Schema } from 'effect';

import { SourceProvisioningConflictRefSchema } from './source-provisioning-conflict-ref.ts';

export class SourceProvisioningPolicyRejected extends Schema.TaggedError<SourceProvisioningPolicyRejected>()(
  'SourceProvisioningPolicyRejected',
  {
    code: Schema.Literal('source_provisioning_policy_rejected'),
    /** The existing record the request collides with, when there is one. */
    conflictRef: Schema.optionalKey(SourceProvisioningConflictRefSchema),
    reason: Schema.Literals([
      'TENANT_SCOPE_MISMATCH',
      'OWNER_CONFIGURATION_NOT_FOUND',
      'OWNER_CONFIGURATION_NOT_EXTERNAL',
      'POLICY_ALREADY_DEFINED',
      'STOCK_LOCATION_NOT_FOUND',
      'STOCK_LOCATION_NOT_ACTIVE',
      'LOCATION_CORRELATION_CONFLICT',
    ]),
  },
) {}
