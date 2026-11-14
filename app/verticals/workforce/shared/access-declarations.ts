import { decodeAccessDeclarationOrThrow } from '@app/core-runtime';

const moduleKey = 'demo.workforce';

// Shared by the registered operations and their owner-local preflight, never a grant alias.
export const recordsCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    {
      key: 'demo.workforce.api-records.read',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'workforce', level: 'basic' },
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
      key: 'demo.workforce.apply-command.write',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'workforce', level: 'manage' },
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
export const searchCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    {
      key: 'demo.workforce.search-employees.read',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'workforce', level: 'basic' },
      risk: 'sensitive',
      selectors: ['all', 'assigned'],
    },
    {
      access: 'read',
      authorization: { kind: 'protected' },
      moduleKey,
      role: 'search',
    },
  ),
};
