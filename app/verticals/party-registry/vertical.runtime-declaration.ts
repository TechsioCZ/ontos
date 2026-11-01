// Party's one owner-authored backend declaration is shared by UI and worker runtime views.
import {
  defineVerticalRuntimeRegistration,
  ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY,
  ShellNavigationContributionSchema,
  ShellPageContributionSchema,
  ShellSearchContributionSchema,
} from '@app/core-runtime';
import type { VerticalRuntimeRegistrationInput } from '@app/core-runtime';
import { Result, Schema } from 'effect';
import { AresLookupApi } from './shared/apis/ares-lookup.ts';
import { CounterpartyReadApi } from './shared/apis/counterparty-read.ts';
import { CounterpartyRoleHistoryApi } from './shared/apis/counterparty-role-history.ts';
import { DuplicateCandidateDetailApi } from './shared/apis/duplicate-candidate-detail.ts';
import { OrganizationEngagementProfileApi } from './shared/apis/organization-engagement-profile.ts';
import { PartyContactPointDetailApi } from './shared/apis/party-contact-point-detail.ts';
import { PartyContactPointsApi } from './shared/apis/party-contact-points.ts';
import { PartyCorrectionApi } from './shared/apis/party-correction.ts';
import { PartyDetailApi } from './shared/apis/party-detail.ts';
import { PartyMatchDecisionApi } from './shared/apis/party-match-decision.ts';
import { PartyMatchApi } from './shared/apis/party-match.ts';
import { PartyMergeReadinessApi } from './shared/apis/party-merge-readiness.ts';
import { PartyOfficialIdentifierDetailApi } from './shared/apis/party-official-identifier-detail.ts';
import { PartyOfficialIdentifierHistoryApi } from './shared/apis/party-official-identifier-history.ts';
import { PartyRelationshipDetailApi } from './shared/apis/party-relationship-detail.ts';
import { PersonEngagementProfileApi } from './shared/apis/person-engagement-profile.ts';
import { addContactPointAction } from './src/actions/add-contact-point.action.ts';
import { addPartyOfficialIdentifierAction } from './src/actions/add-party-official-identifier.action.ts';
import { archiveOrganizationEngagementAction } from './src/actions/archive-organization-engagement.action.ts';
import { archivePartyAction } from './src/actions/archive-party.action.ts';
import { archivePersonEngagementAction } from './src/actions/archive-person-engagement.action.ts';
import { attachOrganizationEngagementAction } from './src/actions/attach-organization-engagement.action.ts';
import { attachPersonEngagementAction } from './src/actions/attach-person-engagement.action.ts';
import { confirmDuplicatePartiesAction } from './src/actions/confirm-duplicate-parties.action.ts';
import { correctPartyFactAction } from './src/actions/correct-party-fact.action.ts';
import { counterpartyCreateAction } from './src/actions/counterparty-create.action.ts';
import { counterpartyCustomerOnboardAction } from './src/actions/counterparty-customer-onboard.action.ts';
import { counterpartyRoleAddAction } from './src/actions/counterparty-role-add.action.ts';
import { counterpartyRoleEndAction } from './src/actions/counterparty-role-end.action.ts';
import { createPartyAction } from './src/actions/create-party.action.ts';
import { createPartyRelationshipAction } from './src/actions/create-party-relationship.action.ts';
import { dismissDuplicateCandidateAction } from './src/actions/dismiss-duplicate-candidate.action.ts';
import { endContactPointAction } from './src/actions/end-contact-point.action.ts';
import { endPartyOfficialIdentifierAction } from './src/actions/end-party-official-identifier.action.ts';
import { endPartyRelationshipAction } from './src/actions/end-party-relationship.action.ts';
import { executePrivacyMeasureAction } from './src/actions/execute-privacy-measure.action.ts';
import { GuestPartyResolutionApi } from './shared/apis/guest-party-resolution.ts';
import { markDuplicateCandidateNeedsEvidenceAction } from './src/actions/mark-duplicate-candidate-needs-evidence.action.ts';
import { matchPartyAction } from './src/actions/match-party.action.ts';
import { PrivacyMeasureExecutionApi } from './shared/apis/privacy-measure-execution.ts';
import { requestSearchRebuildAction } from './src/actions/request-search-rebuild.action.ts';
import { resolveDuplicateCandidateCreateAction } from './src/actions/resolve-duplicate-candidate-create.action.ts';
import { resolveDuplicateCandidateMatchAction } from './src/actions/resolve-duplicate-candidate-match.action.ts';
import { unarchiveOrganizationEngagementAction } from './src/actions/unarchive-organization-engagement.action.ts';
import { unarchivePartyAction } from './src/actions/unarchive-party.action.ts';
import { unarchivePersonEngagementAction } from './src/actions/unarchive-person-engagement.action.ts';
import { updateContactPointAction } from './src/actions/update-contact-point.action.ts';
import { updatePartyAction } from './src/actions/update-party.action.ts';
import { updatePartyOfficialIdentifierAction } from './src/actions/update-party-official-identifier.action.ts';
import { updatePartyRelationshipAction } from './src/actions/update-party-relationship.action.ts';
import { guestPartyResolutionRead } from './src/api/guest-party-resolution.read.ts';
import { partyDetailRead } from './src/api/party-detail.read.ts';
import { partyContactPointDetailRead } from './src/api/party-contact-point-detail.read.ts';
import { executePrivacyMeasureWorker } from './src/workers/execute-privacy-measure.worker.ts';
import { projectContactPointAddedToSearchWorker } from './src/workers/project-contact-point-added-to-search.worker.ts';
import { projectContactPointEndedToSearchWorker } from './src/workers/project-contact-point-ended-to-search.worker.ts';
import { projectContactPointUpdatedToSearchWorker } from './src/workers/project-contact-point-updated-to-search.worker.ts';
import { projectCounterpartyCreatedToSearchWorker } from './src/workers/project-counterparty-created-to-search.worker.ts';
import { projectCounterpartyRoleAddedToSearchWorker } from './src/workers/project-counterparty-role-added-to-search.worker.ts';
import { projectCounterpartyRoleEndedToSearchWorker } from './src/workers/project-counterparty-role-ended-to-search.worker.ts';
import { projectOfficialIdentifierAddedToSearchWorker } from './src/workers/project-official-identifier-added-to-search.worker.ts';
import { projectOfficialIdentifierEndedToSearchWorker } from './src/workers/project-official-identifier-ended-to-search.worker.ts';
import { projectOfficialIdentifierUpdatedToSearchWorker } from './src/workers/project-official-identifier-updated-to-search.worker.ts';
import { projectPartyArchivedToSearchWorker } from './src/workers/project-party-archived-to-search.worker.ts';
import { projectPartyCreatedToSearchWorker } from './src/workers/project-party-created-to-search.worker.ts';
import { projectPartyFactCorrectedToSearchWorker } from './src/workers/project-party-fact-corrected-to-search.worker.ts';
import { projectPartyUnarchivedToSearchWorker } from './src/workers/project-party-unarchived-to-search.worker.ts';
import { projectPartyUpdatedToSearchWorker } from './src/workers/project-party-updated-to-search.worker.ts';
import { rebuildSearchWorker } from './src/workers/rebuild-search.worker.ts';

type NavigationContributionInput = typeof ShellNavigationContributionSchema.Encoded;
type PageContributionInput = typeof ShellPageContributionSchema.Encoded;
type SearchContributionInput = typeof ShellSearchContributionSchema.Encoded;

const navigationContribution = (value: NavigationContributionInput) =>
  Result.getOrThrow(Schema.decodeResult(ShellNavigationContributionSchema)(value));
const pageContribution = (value: PageContributionInput) =>
  Result.getOrThrow(Schema.decodeResult(ShellPageContributionSchema)(value));
const searchContribution = (value: SearchContributionInput) =>
  Result.getOrThrow(Schema.decodeResult(ShellSearchContributionSchema)(value));

export const partyRegistryRuntimeManifest: VerticalRuntimeRegistrationInput['manifest'] = {
  module: {
    description: 'Party Registry business capability.',
    displayName: 'Party Registry',
    id: 'party.registry',
    implementedAs: 'ultramodern_microvertical',
    kind: 'business_module',
  },
  publicSurface: {
    actions: [
      // <generated-module-manifest-actions>
      addContactPointAction,
      addPartyOfficialIdentifierAction,
      archiveOrganizationEngagementAction,
      archivePartyAction,
      archivePersonEngagementAction,
      attachOrganizationEngagementAction,
      attachPersonEngagementAction,
      confirmDuplicatePartiesAction,
      correctPartyFactAction,
      counterpartyCreateAction,
      counterpartyCustomerOnboardAction,
      counterpartyRoleAddAction,
      counterpartyRoleEndAction,
      createPartyAction,
      createPartyRelationshipAction,
      dismissDuplicateCandidateAction,
      endContactPointAction,
      endPartyOfficialIdentifierAction,
      endPartyRelationshipAction,
      executePrivacyMeasureAction,
      markDuplicateCandidateNeedsEvidenceAction,
      matchPartyAction,
      requestSearchRebuildAction,
      resolveDuplicateCandidateCreateAction,
      resolveDuplicateCandidateMatchAction,
      unarchiveOrganizationEngagementAction,
      unarchivePartyAction,
      unarchivePersonEngagementAction,
      updateContactPointAction,
      updatePartyAction,
      updatePartyOfficialIdentifierAction,
      updatePartyRelationshipAction,
      // </generated-module-manifest-actions>
    ],
    api: {
      // <generated-module-manifest-apis>
      'ares-lookup': AresLookupApi,
      'counterparty-read': CounterpartyReadApi,
      'counterparty-role-history': CounterpartyRoleHistoryApi,
      'duplicate-candidate-detail': DuplicateCandidateDetailApi,
      'guest-party-resolution': GuestPartyResolutionApi,
      'organization-engagement-profile': OrganizationEngagementProfileApi,
      'party-contact-point-detail': PartyContactPointDetailApi,
      'party-contact-points': PartyContactPointsApi,
      'party-correction': PartyCorrectionApi,
      'party-detail': PartyDetailApi,
      'party-match': PartyMatchApi,
      'party-match-decision': PartyMatchDecisionApi,
      'party-merge-readiness': PartyMergeReadinessApi,
      'party-official-identifier-detail': PartyOfficialIdentifierDetailApi,
      'party-official-identifier-history': PartyOfficialIdentifierHistoryApi,
      'party-relationship-detail': PartyRelationshipDetailApi,
      'person-engagement-profile': PersonEngagementProfileApi,
      'privacy-measure-execution': PrivacyMeasureExecutionApi,
      // </generated-module-manifest-apis>
    },
    operationContracts: [
      // <generated-module-manifest-operation-contracts>
      {
        apiKey: 'guest-party-resolution',
        operationKey: 'guestPartyResolution.execute',
        registration: guestPartyResolutionRead,
      },
      { apiKey: 'party-detail', operationKey: 'partyDetail.execute', registration: partyDetailRead },
      {
        apiKey: 'party-contact-point-detail',
        operationKey: 'partyContactPointDetail.execute',
        registration: partyContactPointDetailRead,
      },
      // </generated-module-manifest-operation-contracts>
    ],
    shellContributions: {
      mediaAttachments: [],
      navigation: [
        // <generated-module-shell-navigation>
        navigationContribution({
          contributionKey: 'party.registry.navigation.contacts',
          entrypoint: {
            access: 'read',
            authorization: {
              kind: 'context_permission',
              permission: 'module.access',
            },
            entrypointKey: 'party.registry.page.contacts',
            moduleKey: 'party.registry',
            role: 'page',
            scope: 'tenant',
          },
          groupKey: 'shell.navigation.modules',
          order: 100,
          pageKey: 'party.registry.page.contacts',
        }),
        // </generated-module-shell-navigation>
      ],
      pages: [
        // <generated-module-shell-pages>
        pageContribution({
          componentKey: 'party.registry.page-contacts',
          contributionKey: 'party.registry.page.contacts',
          entrypoint: {
            access: 'read',
            authorization: {
              kind: 'context_permission',
              permission: 'module.access',
            },
            entrypointKey: 'party.registry.page.contacts',
            moduleKey: 'party.registry',
            role: 'page',
            scope: 'tenant',
          },
          expose: './PageContacts',
          routePath: '/contacts',
        }),
        // </generated-module-shell-pages>
      ],
      publicComponents: [
        // <generated-module-shell-components>
        // </generated-module-shell-components>
      ],
      reports: [
        // <generated-module-shell-reports>
        // </generated-module-shell-reports>
      ],
      resourceDetails: [],
      search: [
        // <generated-module-shell-search>
        searchContribution({
          contributionKey: 'party.registry.search.counterparties',
          entrypoint: {
            access: 'read',
            authorization: {
              kind: 'context_permission',
              permission: 'module.access',
            },
            entrypointKey: 'party.registry.search.counterparties',
            moduleKey: 'party.registry',
            role: 'search',
            scope: 'tenant',
          },
          searchKey: 'party.registry.counterparties',
        }),
        searchContribution({
          contributionKey: 'party.registry.search.parties',
          entrypoint: {
            access: 'read',
            authorization: {
              kind: 'context_permission',
              permission: 'module.access',
            },
            entrypointKey: 'party.registry.search.parties',
            moduleKey: 'party.registry',
            role: 'search',
            scope: 'tenant',
          },
          searchKey: 'party.registry.parties',
        }),
        // </generated-module-shell-search>
      ],
      timelines: [],
    },
  },
  requirements: {
    coreCapabilities: [ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY],
    intrinsic: [],
    operations: [
      {
        condition: 'party.registry.condition.persisted-original-privacy-owner-outcome',
        entrypointKey: executePrivacyMeasureWorker.descriptor.entrypoint.entrypointKey,
        evidence: [
          'party.registry.evidence.privacy.original-owner-outcome',
          'party.registry.evidence.privacy.exact-execution-correlation',
        ],
        key: 'party.registry.requirement.privacy-report-owner-outcome',
        provider: {
          entrypointKey: 'privacy.core.record-owner-execution-outcome',
          moduleId: 'privacy.core',
          schemaVersion: '1',
        },
      },
    ],
    schemaVersion: '1',
  },
};

export const partyRegistryRuntimeDeclaration: VerticalRuntimeRegistrationInput = {
  actions: partyRegistryRuntimeManifest.publicSurface.actions,
  manifest: partyRegistryRuntimeManifest,
  outboxWorkers: [
    // <generated-module-registration-workers>
    executePrivacyMeasureWorker,
    projectContactPointAddedToSearchWorker,
    projectContactPointEndedToSearchWorker,
    projectContactPointUpdatedToSearchWorker,
    projectCounterpartyCreatedToSearchWorker,
    projectCounterpartyRoleAddedToSearchWorker,
    projectCounterpartyRoleEndedToSearchWorker,
    projectOfficialIdentifierAddedToSearchWorker,
    projectOfficialIdentifierEndedToSearchWorker,
    projectOfficialIdentifierUpdatedToSearchWorker,
    projectPartyArchivedToSearchWorker,
    projectPartyCreatedToSearchWorker,
    projectPartyFactCorrectedToSearchWorker,
    projectPartyUnarchivedToSearchWorker,
    projectPartyUpdatedToSearchWorker,
    rebuildSearchWorker,
    // </generated-module-registration-workers>
  ],
  reads: [
    // <generated-module-registration-reads>
    guestPartyResolutionRead,
    partyDetailRead,
    partyContactPointDetailRead,
    // </generated-module-registration-reads>
  ],
};

/** A genuine worker view of the same owner declaration, with no UI entrypoint import graph. */
export const partyRegistryBackendRegistration = defineVerticalRuntimeRegistration(partyRegistryRuntimeDeclaration);
