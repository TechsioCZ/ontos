/**
 * The isolated CI verification tenant, as canonical v2 source (ADR-0030).
 *
 * A verification run proves the deployment with its own tenant and identity, never with a customer demo
 * tenant: one principal, one company, one reviewed Role that writes `work.tasks` and may propose. Its cells
 * are compiled from the same release the seed port publishes, so the fixture carries no SpiceDB tuple.
 */
import { Effect, Result, Schema } from 'effect';

import { AccessCatalogModulesSchema } from '@app/core-runtime/access/catalog';
import type { AccessCatalogModule } from '@app/core-runtime';

import { policyReleaseEntries, policyRoleCellRows } from './access-policy.mts';
import type { DemoRole } from './permissions.mts';

const verificationName = 'Ověření připojení';
const taskModule = 'work.tasks';
export const verificationTaskWriterRoleKey = 'verification-task-writer';

/** Isolated infrastructure identity: no memberships or grants in any customer demo tenant. */
export const verificationAccount = {
  authBindingId: '74000000-0000-4000-8000-000000000090',
  authUserId: 'stage-verification',
  displayName: verificationName,
  email: 'verification@ci.ontos',
  principalId: '72000000-0000-4000-8000-000000000090',
} as const;
export const verificationTenantId = '70000000-0000-4000-8000-000000000090';
export const verificationLegalEntityId = '71000000-0000-4000-8000-000000000090';

export class VerificationContextError extends Schema.TaggedError<VerificationContextError>()(
  'VerificationContextError',
  { reason: Schema.String },
) {}

/**
 * The verification writer's reviewed Role. `work.tasks.apply-command.write` is the declared capability the
 * vertical serves; the module write access it sits on would grant every declared write capability, so the
 * module stays restricted to exactly the one capability the verification run exercises.
 */
export const verificationRole: DemoRole = {
  capabilityKeys: { [taskModule]: ['work.tasks.apply-command.write'] },
  label: verificationName,
  modules: { [taskModule]: 'write' },
  // The MCP OAuth proof turns its write into a proposal for approval, which needs the proposal lifecycle.
  proposalReview: true,
  restrictedModules: [taskModule],
};

/** The canonical fixture of the verification tenant, ready for the development bootstrap port. */
export const verificationContext = Effect.fn('Demo.verificationContext')(function* verificationContext(
  accessModules: readonly AccessCatalogModule[] = [],
) {
  const { authBindingId, authUserId, displayName, principalId } = verificationAccount;
  const entries = policyReleaseEntries(accessModules, [taskModule]);
  if (Result.isFailure(entries)) {
    return yield* new VerificationContextError({
      reason: `The verification release could not be built: ${entries.failure}`,
    });
  }
  const cells = policyRoleCellRows(verificationRole, entries.success);
  if (Result.isFailure(cells)) {
    return yield* new VerificationContextError({ reason: cells.failure });
  }
  return {
    access: {
      assignments: [{ legalEntityId: verificationLegalEntityId, principalId, roleKey: verificationTaskWriterRoleKey }],
      legalEntityIds: [verificationLegalEntityId],
      memberships: [{ kind: 'member' as const, legalEntityId: verificationLegalEntityId, principalId }],
      modules: yield* Schema.decodeUnknownEffect(Schema.toEncoded(AccessCatalogModulesSchema))(accessModules),
      roles: [
        {
          cells: cells.success,
          key: verificationTaskWriterRoleKey,
          label: verificationName,
          legalEntityId: verificationLegalEntityId,
        },
      ],
      workloads: [],
    },
    accounts: [{ authBindingId, authUserId, displayName, principalId }],
    companyMemberships: [{ affiliation: 'external' as const, legalEntityId: verificationLegalEntityId, principalId }],
    legalEntity: {
      legalEntityId: verificationLegalEntityId,
      legalName: verificationName,
      registrationCountry: 'CZ',
      registrationNumber: 'CI-VERIFICATION',
    },
    modules: [{ moduleId: taskModule, stateId: '78000000-0000-4000-8000-000000000090' }],
    tenant: {
      defaultLocale: 'cs',
      displayName: verificationName,
      slug: 'ci-verification',
      tenantId: verificationTenantId,
    },
  };
});
