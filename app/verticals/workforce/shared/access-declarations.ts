import { decodeAccessDeclarationOrThrow } from '@app/core-runtime';
import type { AccessDeclarationInput } from '@app/core-runtime';

const moduleKey = 'demo.workforce';

// Shared by the registered operations and their owner-local preflight, never a grant alias.
export const recordsDeclaration = {
  key: 'demo.workforce.api-records.read',
  kind: 'read',
  modes: ['run'],
  placement: { group: 'workforce', level: 'basic' },
  risk: 'sensitive',
  selectors: ['all', 'assigned'],
} as const satisfies AccessDeclarationInput;
export const applyCommandDeclaration = {
  key: 'demo.workforce.apply-command.write',
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'workforce', level: 'manage' },
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
export const searchDeclaration = {
  ...recordsDeclaration,
  key: 'demo.workforce.search-employees.read',
} as const satisfies AccessDeclarationInput;
export const searchCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(searchDeclaration, {
    access: 'read',
    authorization: { kind: 'protected' },
    moduleKey,
    role: 'search',
  }),
};
