import { decodeAccessDeclarationOrThrow } from '@app/core-runtime';

const moduleKey = 'demo.sales-insights';

// Shared by the registered operations and their owner-local preflight, never a grant alias.
export const recordsCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    {
      key: 'demo.sales-insights.api-records.read',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'sales-insights', level: 'basic' },
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
      key: 'demo.sales-insights.apply-command.write',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'sales-insights', level: 'manage' },
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
