import { decodeAccessDeclarationOrThrow } from '@app/core-runtime';

const moduleKey = 'work.tasks';

// These are the declarations carried by the registered owner operations, not picker-only capabilities.

export const workRecordsCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    {
      key: 'work.tasks.api-records.read',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'work-tasks', level: 'basic' },
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
export const workWriteCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    {
      key: 'work.tasks.apply-command.write',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'work-tasks', level: 'manage' },
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
