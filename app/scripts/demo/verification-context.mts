import { Effect } from 'effect';
import { companyMembershipAdmissionRelationships } from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import { principalRelationships } from './permissions.mts';
import type { DemoAction } from './permissions.mts';

const verificationName = 'Ověření připojení';
const taskModule = 'work.tasks';
export const verificationTaskWriterRoleKey = 'verification:task-writer';

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

export const verificationContext = Effect.fn('Demo.verificationContext')(function* verificationContext(
  actions: readonly DemoAction[] = [],
) {
  const { authBindingId, authUserId, displayName, principalId } = verificationAccount;
  const relationships = yield* Effect.try(() =>
    principalRelationships(
      principalId,
      {
        actionKeys: { 'work.tasks': ['work.tasks.apply-command'] },
        label: verificationName,
        modules: { 'work.tasks': 'write' },
      },
      actions,
      verificationLegalEntityId,
      verificationTenantId,
      verificationTaskWriterRoleKey,
    ),
  );
  return {
    accounts: [{ authBindingId, authUserId, displayName, principalId }],
    companyMemberships: [{ affiliation: 'external' as const, legalEntityId: verificationLegalEntityId, principalId }],
    legalEntity: {
      legalEntityId: verificationLegalEntityId,
      legalName: verificationName,
      registrationCountry: 'CZ',
      registrationNumber: 'CI-VERIFICATION',
    },
    modules: [{ moduleId: taskModule, stateId: '78000000-0000-4000-8000-000000000090' }],
    relationships: companyMembershipAdmissionRelationships(relationships, [
      { principalId, tenantId: verificationTenantId },
    ]),
    tenant: {
      defaultLocale: 'cs',
      displayName: verificationName,
      slug: 'ci-verification',
      tenantId: verificationTenantId,
    },
  };
});
