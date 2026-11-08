import { decodeAccessDeclarationOrThrow } from '@app/core-runtime';
import type { AccessDeclarationInput } from '@app/core-runtime';

const moduleKey = 'crm.activities';

// Shared by the registered operations and their owner-local preflight, never a grant alias.
export const recordsDeclaration = {
  key: 'crm.activities.api-records.read',
  kind: 'read',
  modes: ['run'],
  placement: { group: 'crm-activities', level: 'basic' },
  risk: 'sensitive',
  selectors: ['all', 'assigned'],
} as const satisfies AccessDeclarationInput;
export const applyCommandDeclaration = {
  key: 'crm.activities.apply-command.write',
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'crm-activities', level: 'manage' },
  risk: 'sensitive',
  selectors: [],
} as const satisfies AccessDeclarationInput;
export const recordsCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(recordsDeclaration, {
    access: 'read',
    authorization: { kind: 'protected' },
    moduleKey,
    role: 'api',
  }),
};
export const applyCommandCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(applyCommandDeclaration, {
    access: 'write',
    authorization: { kind: 'protected' },
    moduleKey,
    role: 'action',
  }),
};
