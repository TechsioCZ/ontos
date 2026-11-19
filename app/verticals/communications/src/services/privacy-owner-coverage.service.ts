import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { Context, DateTime, Effect, Match, Option } from 'effect';

import type {
  CommunicationsOwnerLookup,
  PrivacyOwnerCoverageRequest,
  PrivacyOwnerCoverageResponse,
} from '../../shared/apis/privacy-owner-coverage.ts';
import { assembleCommunicationsContribution } from '../../shared/privacy-owner/contribution.ts';
import type { SuppliedRightEligibility } from '../../shared/privacy-owner/contribution.ts';
import {
  assessCommunicationsOwnerCoverage,
  communicationsContentRef,
  unavailableOwnerBackupCoverage,
} from '../../shared/privacy-owner/coverage.ts';
import type { CategoryObservation, OwnerBackupCoverage } from '../../shared/privacy-owner/coverage.ts';
import {
  assessCategoryConfiguration,
  COMMUNICATIONS_OWNER_CAPABILITY,
  communicationsOwnDataInventory,
  noSuppliedPrivacyReferences,
} from '../../shared/privacy-owner/inventory.ts';
import type {
  InventoryCategory,
  InventoryCategoryId,
  SuppliedPrivacyReferences,
} from '../../shared/privacy-owner/inventory.ts';
import { externalCopyInventoryOf } from '../../shared/privacy-owner/outcome.ts';
import type { BusinessStartObservation } from '../../shared/privacy-owner/retention-evaluation.ts';
import {
  attemptRetryLinks,
  communicationDecisions,
  communicationRequestConflicts,
  communicationRequests,
  deliveryAttempts,
  intentHandoffStops,
  intentResendLinks,
  messageIntents,
  providerObservationConflicts,
  providerObservations,
  templateActivations,
  templateRevisionInvalidations,
  templateRevisions,
  templateTypes,
  tenantLanguageModeVersions,
} from '../database/schema.ts';
import { safeCauseOf } from '../domain/intake/safe-cause.ts';
import { PrivacyOwnerCoverageUnavailable } from './privacy-owner-coverage-unavailable.ts';
import {
  contributionItemsOf,
  foreignIntentIdsOf,
  recordsOf,
  recordsOfCategory,
  REF_KIND,
  unresolvedReasonOf,
} from './privacy-owner-records.ts';
import type { Gathered, ResourceReference } from './privacy-owner-records.ts';

const unavailable = (cause: unknown) =>
  Object.defineProperty(new PrivacyOwnerCoverageUnavailable({ reason: 'The owner records are unavailable' }), 'cause', {
    enumerable: false,
    value: safeCauseOf(cause),
  });

const byText = (left: string, right: string) => left.localeCompare(right, 'en');
const instant = (value: Date) => DateTime.fromDateUnsafe(value);

type ResourceLookup = Extract<CommunicationsOwnerLookup, { readonly _tag: 'CONTACT_REFERENCE' | 'SUBJECT_REFERENCE' }>;
type PrincipalLookup = Extract<CommunicationsOwnerLookup, { readonly _tag: 'ACTOR_PRINCIPAL' }>;

interface SplitLookups {
  readonly principals: readonly PrincipalLookup[];
  readonly resources: readonly ResourceLookup[];
}

const splitLookups = (lookups: PrivacyOwnerCoverageRequest['trustedLookups']): SplitLookups => {
  const principals: PrincipalLookup[] = [];
  const resources: ResourceLookup[] = [];
  for (const lookup of lookups) {
    Match.value(lookup).pipe(
      Match.tag('ACTOR_PRINCIPAL', (principal) => principals.push(principal)),
      Match.tag('CONTACT_REFERENCE', 'SUBJECT_REFERENCE', (resource) => resources.push(resource)),
      Match.exhaustive,
    );
  }
  return { principals, resources };
};

const subjectsOf = (resources: readonly ResourceLookup[]): readonly ResourceLookup[] => {
  const subjects: ResourceLookup[] = [];
  for (const resource of resources) {
    Match.value(resource).pipe(
      Match.tag('SUBJECT_REFERENCE', (subject) => subjects.push(subject)),
      Match.tag('CONTACT_REFERENCE', () => 0),
      Match.exhaustive,
    );
  }
  return subjects;
};

/** True when the jsonb document names this owner resource anywhere: references are objects with all three keys. */
const documentNames = (column: AnyPgColumn, lookup: ResourceLookup): SQL =>
  sql`jsonb_path_exists(${column}, '$.** ? (@.moduleId == $m && @.resourceType == $t && @.resourceId == $r)', jsonb_build_object('m', ${lookup.moduleId}::text, 't', ${lookup.resourceType}::text, 'r', ${lookup.resourceId}::text))`;

export interface PrivacyOwnerCoverageOptions {
  readonly backup: OwnerBackupCoverage;
  readonly eligibility: SuppliedRightEligibility;
  /** The Privacy references supplied so far. Every input is an open gate until the named owner supplies it. */
  readonly supplied: SuppliedPrivacyReferences;
}

export const defaultPrivacyOwnerCoverageOptions: PrivacyOwnerCoverageOptions = Object.freeze({
  backup: unavailableOwnerBackupCoverage,
  eligibility: {},
  supplied: noSuppliedPrivacyReferences,
});

/** The conditions that match an intent to one lookup: a subject by recipient columns, any resource by its pinned documents. */
const intentConditions = (lookup: ResourceLookup): readonly (SQL | undefined)[] =>
  Match.value(lookup).pipe(
    Match.tag('SUBJECT_REFERENCE', (subject) => [
      and(
        eq(messageIntents.recipientModule, subject.moduleId),
        eq(messageIntents.recipientType, subject.resourceType),
        eq(messageIntents.recipientId, subject.resourceId),
      ),
      documentNames(messageIntents.originalBinding, subject),
      documentNames(messageIntents.endpointPin, subject),
    ]),
    Match.tag('CONTACT_REFERENCE', (contact) => [
      documentNames(messageIntents.originalBinding, contact),
      documentNames(messageIntents.endpointPin, contact),
    ]),
    Match.exhaustive,
  );

const gatherByIntents = Effect.fn('CommunicationsPrivacyCoverage.gatherByIntents')(function* byIntents(
  transaction: ScopedTransactionExecutor,
  tenantId: string,
  intentIds: readonly string[],
) {
  if (intentIds.length === 0) {
    return { attempts: [], observationConflicts: [], observations: [], resends: [], retries: [], stops: [] };
  }
  const ids = [...intentIds];
  return yield* Effect.all(
    {
      attempts: transaction
        .select()
        .from(deliveryAttempts)
        .where(and(eq(deliveryAttempts.tenantId, tenantId), inArray(deliveryAttempts.intentId, ids))),
      observationConflicts: transaction
        .select()
        .from(providerObservationConflicts)
        .where(
          and(eq(providerObservationConflicts.tenantId, tenantId), inArray(providerObservationConflicts.intentId, ids)),
        ),
      observations: transaction
        .select()
        .from(providerObservations)
        .where(and(eq(providerObservations.tenantId, tenantId), inArray(providerObservations.intentId, ids))),
      resends: transaction
        .select()
        .from(intentResendLinks)
        .where(
          and(
            eq(intentResendLinks.tenantId, tenantId),
            or(inArray(intentResendLinks.originalIntentId, ids), inArray(intentResendLinks.resendIntentId, ids)),
          ),
        ),
      retries: transaction
        .select()
        .from(attemptRetryLinks)
        .where(and(eq(attemptRetryLinks.tenantId, tenantId), inArray(attemptRetryLinks.intentId, ids))),
      stops: transaction
        .select()
        .from(intentHandoffStops)
        .where(and(eq(intentHandoffStops.tenantId, tenantId), inArray(intentHandoffStops.intentId, ids))),
    },
    { concurrency: 1 },
  );
});

/** Everything of the installed tenant that the typed lookups reach, by exact owner references only. */
const gather = Effect.fn('CommunicationsPrivacyCoverage.gather')(function* gatherRows(
  transaction: ScopedTransactionExecutor,
  tenantId: string,
  resources: readonly ResourceLookup[],
) {
  if (resources.length === 0) {
    return Option.none<Gathered>();
  }
  const intents = yield* transaction
    .select()
    .from(messageIntents)
    .where(and(eq(messageIntents.tenantId, tenantId), or(...resources.flatMap(intentConditions))));
  const requests = yield* transaction
    .select()
    .from(communicationRequests)
    .where(
      and(
        eq(communicationRequests.tenantId, tenantId),
        or(
          ...resources.map((lookup) => documentNames(communicationRequests.payload, lookup)),
          intents.length === 0
            ? undefined
            : inArray(communicationRequests.requestId, [...new Set(intents.map(({ requestId }) => requestId))]),
        ),
      ),
    );
  const requestIds = requests.map(({ requestId }) => requestId);
  const byRequest =
    requestIds.length === 0
      ? { conflicts: [], decisions: [] }
      : yield* Effect.all(
          {
            conflicts: transaction
              .select()
              .from(communicationRequestConflicts)
              .where(
                and(
                  eq(communicationRequestConflicts.tenantId, tenantId),
                  inArray(communicationRequestConflicts.requestId, requestIds),
                ),
              ),
            decisions: transaction
              .select()
              .from(communicationDecisions)
              .where(
                and(
                  eq(communicationDecisions.tenantId, tenantId),
                  inArray(communicationDecisions.requestId, requestIds),
                ),
              ),
          },
          { concurrency: 1 },
        );
  const rest = yield* gatherByIntents(
    transaction,
    tenantId,
    intents.map(({ intentId }) => intentId),
  );
  return Option.some<Gathered>({ ...rest, ...byRequest, intents, requests });
});

/** Template governance rows attributed to the staff principals Privacy named. */
const gatherAttribution = Effect.fn('CommunicationsPrivacyCoverage.gatherAttribution')(function* attribution(
  transaction: ScopedTransactionExecutor,
  tenantId: string,
  principals: readonly PrincipalLookup[],
) {
  const principalIds = principals.map(({ principalId }) => principalId);
  if (principalIds.length === 0) {
    return [];
  }
  const rows = yield* Effect.all(
    {
      activations: transaction
        .select({ id: templateActivations.activationId })
        .from(templateActivations)
        .where(
          and(
            eq(templateActivations.tenantId, tenantId),
            or(
              inArray(templateActivations.activatedByPrincipalId, principalIds),
              inArray(templateActivations.endedByPrincipalId, principalIds),
            ),
          ),
        ),
      invalidations: transaction
        .select({ id: templateRevisionInvalidations.invalidationId })
        .from(templateRevisionInvalidations)
        .where(
          and(
            eq(templateRevisionInvalidations.tenantId, tenantId),
            inArray(templateRevisionInvalidations.invalidatedByPrincipalId, principalIds),
          ),
        ),
      modes: transaction
        .select({ id: tenantLanguageModeVersions.policyVersionId })
        .from(tenantLanguageModeVersions)
        .where(
          and(
            eq(tenantLanguageModeVersions.tenantId, tenantId),
            inArray(tenantLanguageModeVersions.setByPrincipalId, principalIds),
          ),
        ),
      revisions: transaction
        .select({ id: templateRevisions.revisionId })
        .from(templateRevisions)
        .where(
          and(eq(templateRevisions.tenantId, tenantId), inArray(templateRevisions.createdByPrincipalId, principalIds)),
        ),
      types: transaction
        .select({ id: templateTypes.templateTypeId })
        .from(templateTypes)
        .where(and(eq(templateTypes.tenantId, tenantId), inArray(templateTypes.createdByPrincipalId, principalIds))),
    },
    { concurrency: 1 },
  );
  return [
    ...rows.types.map(({ id }) => communicationsContentRef('template-type', id)),
    ...rows.revisions.map(({ id }) => communicationsContentRef('template-revision', id)),
    ...rows.activations.map(({ id }) => communicationsContentRef('template-activation', id)),
    ...rows.invalidations.map(({ id }) => communicationsContentRef('template-invalidation', id)),
    ...rows.modes.map(({ id }) => communicationsContentRef('language-mode-version', id)),
  ];
});

/** Owner-local Privacy coverage read, bound to one scoped transaction. */
export interface PrivacyOwnerCoverageService {
  /** The ORIGINAL business starts of every record, for the retention hook. Immutable columns only. */
  readonly businessStarts: () => Effect.Effect<readonly BusinessStartObservation[], PrivacyOwnerCoverageUnavailable>;
  readonly coverage: (
    request: PrivacyOwnerCoverageRequest,
  ) => Effect.Effect<Option.Option<PrivacyOwnerCoverageResponse>, PrivacyOwnerCoverageUnavailable>;
}

interface EvidenceInput {
  readonly lookupRefs: readonly string[];
  readonly observedAt: DateTime.Utc;
  readonly tenantId: string;
}

const observationOf = (
  category: InventoryCategory,
  found: readonly string[],
  unresolvedReason: string | undefined,
  evidenceInput: EvidenceInput,
): CategoryObservation => {
  const sortedFound = found.toSorted(byText);
  const evidence = computeCanonicalValueHash({
    category: category.id,
    copyKind: category.copyKind,
    examinedTables: category.storage.map(({ table }) => table),
    foundContentRefs: sortedFound,
    lookupRefs: evidenceInput.lookupRefs,
    tenantId: evidenceInput.tenantId,
  });
  const base = {
    category: category.id,
    evidenceRefs: [`${COMMUNICATIONS_OWNER_CAPABILITY}/privacy-owner-coverage/${category.id}/${evidence}`],
    foundContentRefs: sortedFound,
    observedAt: DateTime.formatIso(evidenceInput.observedAt),
  };
  return unresolvedReason === undefined
    ? { ...base, coverageStatus: 'COMPLETE' }
    : { ...base, coverageStatus: 'PARTIAL', unresolvedReason };
};

const startsOf = (
  category: InventoryCategoryId,
  kind: string,
  rows: readonly { readonly at: Date; readonly id: string }[],
) =>
  rows.map(({ at, id }): BusinessStartObservation => ({
    category,
    contentRef: communicationsContentRef(kind, id),
    startAt: instant(at),
  }));

export class PrivacyOwnerCoverage extends Context.Service<PrivacyOwnerCoverage, PrivacyOwnerCoverageService>()(
  '@app/communications/services/privacy-owner-coverage.service/PrivacyOwnerCoverage',
) {}

export const privacyOwnerCoverageForScope = (
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  options: PrivacyOwnerCoverageOptions = defaultPrivacyOwnerCoverageOptions,
): PrivacyOwnerCoverageService => {
  const { tenantId } = scope;

  const coverage: PrivacyOwnerCoverageService['coverage'] = Effect.fn('CommunicationsPrivacyCoverage.coverage')(
    function* coverageEffect(request) {
      if (String(request.scope.tenantId) !== tenantId) {
        return Option.none();
      }
      const { principals, resources } = splitLookups(request.trustedLookups);
      const { attribution, gathered } = yield* Effect.all(
        {
          attribution: gatherAttribution(transaction, tenantId, principals),
          gathered: gather(transaction, tenantId, resources),
        },
        { concurrency: 1 },
      ).pipe(Effect.mapError(unavailable));
      const data = Option.getOrUndefined(gathered);
      const subjects: readonly ResourceReference[] = subjectsOf(resources);
      const records = recordsOf(data, attribution);
      const reasonContext = {
        backup: options.backup,
        hasPrincipalLookup: principals.length > 0,
        hasResourceLookup: resources.length > 0,
        sharedContact: foreignIntentIdsOf(data, subjects).size > 0,
      };
      const observedAt = yield* DateTime.now;
      const assessedAt = DateTime.formatIso(observedAt);
      const lookupRefs = request.trustedLookups.map(({ lookupRef }) => lookupRef).toSorted(byText);
      const observations = communicationsOwnDataInventory.map((category) =>
        observationOf(
          category,
          recordsOfCategory(records, category.id),
          unresolvedReasonOf(category.id, reasonContext),
          { lookupRefs, observedAt, tenantId },
        ),
      );
      const coverageResult = assessCommunicationsOwnerCoverage({
        assessedAt,
        evidenceRefs: observations.flatMap(({ evidenceRefs }) => evidenceRefs),
        observations,
        scope: { ...request.scope, tenantId: String(request.scope.tenantId) },
      });
      const contribution =
        request.right === undefined
          ? Option.none()
          : Option.some(
              assembleCommunicationsContribution({
                coverage: coverageResult,
                eligibility: options.eligibility,
                items: contributionItemsOf(data, records, subjects),
                right: request.right,
              }),
            );
      return Option.some({
        configuration: communicationsOwnDataInventory.map((category) => {
          const state = assessCategoryConfiguration(category, options.supplied[category.id]);
          return {
            category: category.id,
            gapInputs: state.state === 'CONFIGURATION_GAP' ? state.gaps : [],
            state: state.state,
          };
        }),
        contribution,
        coverage: coverageResult,
        externalCopies: externalCopyInventoryOf(
          (data?.observations ?? []).map(({ providerKey, recordedAt }) => ({
            observedAtMillis: recordedAt.getTime(),
            providerKey,
          })),
        ),
        ownerCapability: COMMUNICATIONS_OWNER_CAPABILITY,
        ownerMutationBoundary: 'NO_AUTOMATIC_OR_DESTRUCTIVE_OWNER_OPERATION',
      } satisfies PrivacyOwnerCoverageResponse);
    },
  );

  const businessStarts: PrivacyOwnerCoverageService['businessStarts'] = () =>
    Effect.gen(function* businessStartsEffect() {
      const rows = yield* Effect.all(
        {
          attempts: transaction
            .select({ at: deliveryAttempts.preparedAt, id: deliveryAttempts.attemptId })
            .from(deliveryAttempts)
            .where(eq(deliveryAttempts.tenantId, tenantId)),
          intents: transaction
            .select({ at: messageIntents.createdAt, id: messageIntents.intentId })
            .from(messageIntents)
            .where(eq(messageIntents.tenantId, tenantId)),
          observations: transaction
            .select({ at: providerObservations.recordedAt, id: providerObservations.observationId })
            .from(providerObservations)
            .where(eq(providerObservations.tenantId, tenantId)),
          requests: transaction
            .select({ at: communicationRequests.receivedAt, id: communicationRequests.requestId })
            .from(communicationRequests)
            .where(eq(communicationRequests.tenantId, tenantId)),
        },
        { concurrency: 1 },
      );
      return [
        ...startsOf('REQUEST_DECISION_INTENT', REF_KIND.request, rows.requests),
        ...startsOf('ORIGINAL_RECIPIENT_ENDPOINT', REF_KIND.originalRecipient, rows.intents),
        ...startsOf('TYPE_LANGUAGE_TEMPLATE_REVISION', REF_KIND.templatePin, rows.intents),
        ...startsOf('ATTEMPTS_PROVIDER_OBSERVATIONS_SUPPRESSION', REF_KIND.attempt, rows.attempts),
        ...startsOf('PROVIDER_COPY_WORKING_COPY_PROTECTION', REF_KIND.providerCorrelation, rows.observations),
      ];
    }).pipe(Effect.mapError(unavailable));

  return PrivacyOwnerCoverage.of({ businessStarts, coverage });
};
