import { Result } from 'effect';
import { decodeAccessDeclarationOrThrow, decodeAccessWorkload } from '@app/core-runtime';
import type { AccessDeclarationInput } from '@app/core-runtime';

const moduleKey = 'work.tasks';

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
    moduleKey,
    role: 'api',
  }),
};
export const workWriteCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(workApplyCommandDeclaration, {
    access: 'write',
    authorization: { kind: 'protected' },
    moduleKey,
    role: 'action',
  }),
};

/**
 * The storefront BFFs file customer inquiries through their own Action. Work Tasks owns the workload key, so it sits in
 * the module's `work.*` namespace (O73); no person or agent runs it, and it opens no Work Tasks read.
 */
export const storefrontInquiryWorkload = {
  reason: 'A registered storefront BFF files a customer inquiry from its public form; no person runs this Action',
  workloads: ['work.storefront-client'],
} as const;
export const storefrontInquiryCarrier = {
  accessWorkload: Result.getOrThrow(
    decodeAccessWorkload(storefrontInquiryWorkload, {
      access: 'write',
      authorization: { kind: 'protected' },
      moduleKey,
      role: 'action',
    }),
  ),
};
