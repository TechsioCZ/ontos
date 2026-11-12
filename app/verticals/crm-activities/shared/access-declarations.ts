import { decodeAccessDeclarationOrThrow } from '@app/core-runtime';

const moduleKey = 'crm.activities';

// Shared by the registered operations and their owner-local preflight, never a grant alias.
export const recordsCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    {
      key: 'crm.activities.api-records.read',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'crm-activities', level: 'basic' },
      risk: 'sensitive',
      selectors: ['all', 'assigned'],
    },
    {
      access: 'read',
      authorization: { kind: 'protected' },
      moduleKey,
      role: 'api',
    },
  ),
};
export const applyCommandCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    {
      key: 'crm.activities.apply-command.write',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'crm-activities', level: 'manage' },
      risk: 'sensitive',
      selectors: [],
    },
    {
      access: 'write',
      authorization: { kind: 'protected' },
      moduleKey,
      role: 'action',
    },
  ),
};
