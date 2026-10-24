import { Effect } from 'effect';
import { companyMembershipAdmissionRelationships } from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import { ownTaskRelationships } from './accounts-admin-grants.mts';
import {
  demoPermissionRelationships,
  localDevelopmentAdministratorFixture,
  principalRelationships,
  reviewedHumanActionAddonRelationships,
} from './permissions.mts';
import type { DemoAction } from './permissions.mts';
import {
  verificationAccount,
  verificationContext,
  verificationLegalEntityId,
  verificationTenantId,
} from './verification-context.mts';

/** One canonical target for offline review and native cutover; never invent a verification membership. */
export const peopleModelTransitionFixtureRelationships = Effect.fn('PeopleModelTransition.fixture')(function* fixture(
  actions: readonly DemoAction[],
  memberships: readonly { readonly legalEntityId: string; readonly principalId: string; readonly tenantId: string }[],
) {
  const verification = memberships.some(
    (row) =>
      row.tenantId === verificationTenantId &&
      row.legalEntityId === verificationLegalEntityId &&
      row.principalId === verificationAccount.principalId,
  )
    ? (yield* verificationContext(actions)).relationships
    : [];
  const local = localDevelopmentAdministratorFixture;
  return companyMembershipAdmissionRelationships(
    [
      ...demoPermissionRelationships(actions),
      ...reviewedHumanActionAddonRelationships(actions),
      ...ownTaskRelationships(),
      ...principalRelationships(local.principalId, local.role, actions, local.legalEntityId, local.tenantId),
      ...verification,
    ],
    memberships,
  );
});
