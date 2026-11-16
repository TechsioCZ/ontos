import { Effect, Predicate, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { policyReleaseEntries } from '../demo/access-policy.mts';
import {
  verificationAccount,
  verificationContext,
  verificationLegalEntityId,
  verificationRole,
  verificationTaskWriterRoleKey,
  verificationTenantId,
} from '../demo/verification-context.mts';

const taskModule = 'work.tasks';
const taskCommand = 'work.tasks.apply-command.write';

/** The declaration set the verification release is built from: the task command the writer runs. */
const taskDeclarations = [
  {
    descriptors: [
      {
        accessDeclaration: {
          key: taskCommand,
          kind: 'action',
          modes: ['run', 'propose', 'approve'],
          placement: { group: 'records', level: 'basic' },
          risk: 'sensitive',
          selectors: [],
        },
        entrypoint: {
          access: 'write',
          authorization: { kind: 'protected' },
          entrypointKey: 'work.tasks.actions.apply-command',
          moduleKey: taskModule,
          role: 'action',
          scope: 'tenant',
        },
      },
    ],
    moduleId: taskModule,
  },
] as const;

it.effect('builds the isolated verification tenant as canonical v2 access intent', () =>
  Effect.gen(function* buildsVerificationContext() {
    const context = yield* verificationContext(taskDeclarations);
    expect(context.tenant.tenantId).toBe(verificationTenantId);
    expect(context.legalEntity.legalEntityId).toBe(verificationLegalEntityId);
    expect(context.accounts.map((account) => account.principalId)).toEqual([verificationAccount.principalId]);
    expect(context.companyMemberships).toEqual([
      {
        affiliation: 'external',
        legalEntityId: verificationLegalEntityId,
        principalId: verificationAccount.principalId,
      },
    ]);
    expect(context.modules.map((module) => module.moduleId)).toEqual([taskModule]);
    expect(context.access.legalEntityIds).toEqual([verificationLegalEntityId]);
    expect(context.access.assignments).toEqual([
      {
        legalEntityId: verificationLegalEntityId,
        principalId: verificationAccount.principalId,
        roleKey: verificationTaskWriterRoleKey,
      },
    ]);
    expect(context.access.memberships).toEqual([
      { kind: 'member', legalEntityId: verificationLegalEntityId, principalId: verificationAccount.principalId },
    ]);
    expect(context.access.workloads).toEqual([]);
    // One Role, one exact cell: the writer's reviewed capability at the modes its declaration carries,
    // because the Role reviews proposals. No module name, no wildcard, no other capability.
    expect(context.access.roles).toEqual([
      {
        cells: [
          { capabilityKey: taskCommand, mode: 'run', selector: 'all' },
          { capabilityKey: taskCommand, mode: 'propose', selector: 'all' },
          { capabilityKey: taskCommand, mode: 'approve', selector: 'all' },
        ],
        key: verificationTaskWriterRoleKey,
        label: verificationRole.label,
        legalEntityId: verificationLegalEntityId,
      },
    ]);
  }),
);

it.effect('carries the pinned declarations through as data, never a hand-written tuple', () =>
  Effect.gen(function* carriesDeclarations() {
    const context = yield* verificationContext(taskDeclarations);
    expect(context.access.modules).toEqual(taskDeclarations);
    const encoded = JSON.stringify(context);
    for (const retired of [
      'scoped_role',
      'context_permission',
      'action_grant',
      'module_access',
      'read_all',
      'write_all',
      'permissionTarget',
    ]) {
      expect(encoded).not.toContain(retired);
    }
  }),
);

it.effect('refuses a Role that reaches a module the pinned release does not declare', () =>
  Effect.gen(function* refusesUndeclaredModule() {
    // A composition that serves no declaration of the module at all: the release names no module key.
    const emptyRelease = [{ descriptors: [], moduleId: taskModule }] as const;
    const failure = yield* verificationContext(emptyRelease).pipe(Effect.flip);
    expect(Predicate.isTagged(failure, 'VerificationContextError')).toBe(true);
    if (Predicate.isTagged(failure, 'VerificationContextError')) {
      expect(failure.reason).toContain(taskModule);
    }
  }),
);

it.effect('refuses a Role that names a capability the pinned release does not declare', () =>
  Effect.gen(function* refusesUndeclaredCapability() {
    // The module is declared, but with a different capability than the writer names.
    const wrongCapability = [
      {
        descriptors: [
          {
            accessDeclaration: {
              key: 'work.tasks.other-command.write',
              kind: 'action',
              modes: ['run'],
              placement: { group: 'records', level: 'basic' },
              risk: 'routine',
              selectors: [],
            },
            entrypoint: {
              access: 'write',
              authorization: { kind: 'protected' },
              entrypointKey: 'work.tasks.actions.other-command',
              moduleKey: taskModule,
              role: 'action',
              scope: 'tenant',
            },
          },
        ],
        moduleId: taskModule,
      },
    ] as const;
    const failure = yield* verificationContext(wrongCapability).pipe(Effect.flip);
    expect(Predicate.isTagged(failure, 'VerificationContextError')).toBe(true);
    if (Predicate.isTagged(failure, 'VerificationContextError')) {
      expect(failure.reason).toContain(taskCommand);
    }
  }),
);

it('compiles the same release the seed publishes, so a Role and its release cannot drift', () => {
  const entries = policyReleaseEntries(taskDeclarations, [taskModule]);
  expect(Result.isSuccess(entries)).toBe(true);
  if (Result.isSuccess(entries)) {
    expect(entries.success.map((entry) => entry.key)).toEqual([taskCommand]);
  }
});
