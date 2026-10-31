import { Effect } from 'effect';
import {
  bootstrapRelationshipsFromNative,
  companyMembershipAdmissionRelationships,
} from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import {
  buildActionAuthorizationRelationships,
  deriveScopedActionAuthorization,
} from '../../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import { coreActionCatalog } from '../../packages/core-runtime/src/modules/actions/catalog.ts';
import { deriveActionAuthorizationInstalledModuleScopes } from '../provision-current-action-authorization.mts';
import { ownTaskRelationships } from './accounts-admin-grants.mts';
import {
  demoPermissionRelationships,
  localDevelopmentAdministratorFixture,
  principalRelationships,
  reviewedHumanActionAddonRelationships,
} from './permissions.mts';
import type { DemoAction, DemoPermissionInstallation } from './permissions.mts';
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
  installation: DemoPermissionInstallation,
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
  const policy = [
    ...demoPermissionRelationships(actions, installation),
    ...(yield* reviewedHumanActionAddonRelationships(actions)),
    ...ownTaskRelationships(),
    ...principalRelationships(local.principalId, local.role, actions, local.legalEntityId, local.tenantId),
    ...verification,
  ];
  const published = new Set(installation.publishedModuleKeys);
  const coreActionKeys = new Set(coreActionCatalog.map(({ actionKey }) => actionKey));
  const coreModuleKeys = new Set(coreActionCatalog.map(({ owningModuleKey }) => owningModuleKey));
  const scopes = deriveActionAuthorizationInstalledModuleScopes(
    installation.publishedModuleKeys,
    memberships.map(({ tenantId }) => tenantId),
    installation.moduleStates,
    installation.companies,
  );
  const structure = bootstrapRelationshipsFromNative(
    buildActionAuthorizationRelationships(
      deriveScopedActionAuthorization(
        actions.filter(
          ({ actionKey, owningModuleKey }) =>
            coreActionKeys.has(actionKey) || (!coreModuleKeys.has(owningModuleKey) && published.has(owningModuleKey)),
        ),
        scopes,
      ),
    ),
  ).map((relationship) => {
    const { subjectRelation, ...directSubject } = relationship;
    return subjectRelation === '' ? directSubject : relationship;
  });
  return companyMembershipAdmissionRelationships(
    // Add-ons and verification roles retain grants, but cannot invent installed Action topology.
    [...policy.filter(({ resourceType }) => resourceType !== 'action'), ...structure],
    memberships,
  );
});
