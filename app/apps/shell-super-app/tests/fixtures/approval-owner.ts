import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { ActionKeySchema } from '@app/core-runtime/access/approvals/frozen-command';
import type { FrozenCommandRecord } from '@app/core-runtime/access/approvals/frozen-command';
import {
  AccessScopeIdSchema,
  CapabilityKeySchema,
  CommandDigestSchema,
  ProposalIdSchema,
  PrincipalIdSchema,
  TenantIdSchema,
} from '@app/core-runtime/access/ids';
import { Schema, Struct } from 'effect';

import type { ApprovalRecord } from '../../api/access-admin/approvals-contract.ts';

export const approvalOwnerModuleId = 'demo.governing-read';
export const approvalOwnerCompanyId = '00000000-0000-4000-8000-000000000002';
const tenantId = '00000000-0000-4000-8000-000000000001';
const placement = { group: 'records', level: 'extended' };
const declaration = {
  key: `${approvalOwnerModuleId}.record.change`,
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'records', level: 'basic' },
  risk: 'sensitive',
  selectors: ['all'],
};

/**
 * Immutable routing data derived with Core's real resolveActionCommandV2/actionFor and
 * freezeActionCommandV2. It is never an authority proof or an executable owner registration.
 */
const document: Schema.Json = {
  actionKey: `${approvalOwnerModuleId}.change`,
  declaration,
  fieldGroups: [
    {
      fieldClass: 'salaries',
      fields: ['salary'],
      key: `${approvalOwnerModuleId}.record.write-salary`,
      kind: 'field_write',
      modes: ['run', 'propose', 'approve'],
      placement,
      risk: 'sensitive',
      selectors: [],
    },
  ],
  format: 'core.action/2',
  governingRead: {
    declaration: {
      key: `${approvalOwnerModuleId}.record.read`,
      kind: 'read',
      modes: ['run'],
      placement: { group: 'records', level: 'basic' },
      risk: 'sensitive',
      selectors: ['all'],
    },
    fieldGroups: [
      {
        fieldClass: 'salaries',
        fields: ['salary'],
        key: `${approvalOwnerModuleId}.record.read-salary`,
        kind: 'field_read',
        modes: ['run'],
        placement,
        risk: 'sensitive',
        selectors: [],
      },
    ],
    readKey: `${approvalOwnerModuleId}.api.records`,
    schemaVersion: '1',
  },
  legalEntityScope: 'required',
  owningModuleKey: approvalOwnerModuleId,
  payload: { ids: ['record-1', 'record-2'], salary: 25 },
  schemaVersion: '1',
  scope: { legalEntityId: approvalOwnerCompanyId, tenantId },
  targetBinding: 'record_set',
  targets: [
    { moduleKey: approvalOwnerModuleId, recordKey: 'record-1' },
    { moduleKey: approvalOwnerModuleId, recordKey: 'record-2' },
  ],
  targetSetHash: 'ec91d3e42c38832ecfbf0cd40a401aebdee26affb8950eb739d049b64b4b56e3',
};

export const approvalOwnerFrozen: FrozenCommandRecord = {
  actionKey: ActionKeySchema.make(`${approvalOwnerModuleId}.change`),
  command: {
    capabilityKey: CapabilityKeySchema.make(declaration.key),
    payload: document,
  },
  commandDigest: CommandDigestSchema.make('f0c4866f0d13b6ae66986cb291c0dc2d61a0deac79824061c1a3e17a0740bac3'),
  proposalId: ProposalIdSchema.make('00000000-0000-4000-8000-000000000010'),
  scopeId: AccessScopeIdSchema.make('00000000-0000-4000-8000-000000000011'),
  tenantId: TenantIdSchema.make(tenantId),
};

export const approvalOwnerPrincipal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '00000000-0000-4000-8000-000000000004',
  authContextRef: 'better-auth-session:approver',
  authenticationNamespaceId: 'shell.staff',
  authMethod: 'session',
  legalEntityId: approvalOwnerCompanyId,
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId,
});
export const approvalOwnerTenantScope: OperationalScope = {
  ...Struct.omit(approvalOwnerPrincipal, ['legalEntityId']),
  correlationId: 'owner-approval-transport',
};

export const approvalOwnerProposal: ApprovalRecord = {
  capabilityKey: approvalOwnerFrozen.command.capabilityKey,
  commandDigest: approvalOwnerFrozen.commandDigest,
  createdAt: new Date('2026-11-07T00:00:00.000Z'),
  expiresAt: new Date('2026-11-08T00:00:00.000Z'),
  id: approvalOwnerFrozen.proposalId,
  requester: { _tag: 'Principal', principalId: PrincipalIdSchema.make('00000000-0000-4000-8000-000000000002') },
  scopeId: approvalOwnerFrozen.scopeId,
  status: 'pending',
  tenantId,
};
