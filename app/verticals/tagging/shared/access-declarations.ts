import { decodeAccessDeclarationOrThrow } from '@app/core-runtime';

const moduleKey = 'demo.tagging';

// Shared by the registered operations and their owner-local preflight, never a grant alias.
export const recordsCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    {
      key: 'demo.tagging.api-records.read',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'tagging', level: 'basic' },
      risk: 'sensitive',
      selectors: ['all'],
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
      key: 'demo.tagging.apply-command.write',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'tagging', level: 'manage' },
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
