import { decodeAccessDeclarationOrThrow } from '@app/core-runtime';
import type { AccessDeclarationInput } from '@app/core-runtime';

// These are the declarations carried by the registered owner operations, not picker-only capabilities.
export const workRecordsReadDeclaration = {
  key: 'work.tasks.api-records.read',
  kind: 'read',
  modes: ['run'],
  placement: { group: 'work-tasks', level: 'basic' },
  risk: 'sensitive',
  selectors: ['all', 'assigned'],
} as const satisfies AccessDeclarationInput;

export const workApplyCommandDeclaration = {
  key: 'work.tasks.apply-command.write',
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'work-tasks', level: 'manage' },
  risk: 'sensitive',
  selectors: [],
} as const satisfies AccessDeclarationInput;

export const workRecordsCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(workRecordsReadDeclaration, {
    access: 'read',
    authorization: { kind: 'protected' },
    moduleKey: 'work.tasks',
    role: 'api',
  }),
};
export const workWriteCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(workApplyCommandDeclaration, {
    access: 'write',
    authorization: { kind: 'protected' },
    moduleKey: 'work.tasks',
    role: 'action',
  }),
};
