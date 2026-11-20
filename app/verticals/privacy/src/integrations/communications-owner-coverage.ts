import { privacyOwnerCoverageOperation } from '@app/communications/api/privacy-owner-coverage';
import type {
  PrivacyOwnerCoverageRequest,
  PrivacyOwnerCoverageResponse,
} from '@app/communications/api/privacy-owner-coverage';
import type { CallOutcome } from '@app/core-runtime/sdk';
import { DateTime, Match, Option, Schema } from 'effect';

import type { OwnerInventoryOwnerLookup } from '../../shared/privacy-queries.ts';
import type { PrivacyOwnerAnswerDetail, PrivacyOwnerObservation } from '../../shared/domain/owner-inventory.ts';

/**
 * Privacy's side of the Communications Owner Coverage contract (#1410, #595-#597). Privacy asks the owner for the coverage of
 * ONE confirmed Data Subject over exactly the content scopes the Processing Activity says Communications holds, and turns the
 * owner's answer into the observation the existing owner inventory already understands. Nothing here decides a legal outcome
 * or completes a scope on an owner's behalf: an answer that does not match what was asked, a refusal, an outage and an
 * unreadable answer are all UNAVAILABLE or INDETERMINATE, never NO_DATA.
 */

export const COMMUNICATIONS_MODULE_ID = 'communications.core';

/** The published limit of references one inventory entry can carry. */
const MAX_PUBLISHED_RESOURCE_REFS = 128;

export type CommunicationsCoverageRequest = PrivacyOwnerCoverageRequest;

/** The content scopes the activity declares Communications to be the system of record of, once each. */
export const communicationsScopePartsOf = (
  dataCoverage: readonly {
    readonly recordContentScope: string;
    readonly systemOfRecordRef: { readonly moduleId: string };
  }[],
): readonly string[] => {
  const parts = new Set<string>();
  for (const { recordContentScope, systemOfRecordRef } of dataCoverage) {
    if (systemOfRecordRef.moduleId === COMMUNICATIONS_MODULE_ID) {
      parts.add(recordContentScope);
    }
  }
  return [...parts];
};

/**
 * The exact request for the owner. `NOT_OWNER`: the activity declares Communications as no system of record. `NOT_ASKABLE`:
 * the activity's declared scopes are not a question the owner publishes (for example it leaves one of its content scopes
 * out), so nothing may be asked or concluded for it.
 */
export type CommunicationsCoverageQuestion =
  | { readonly kind: 'ASK'; readonly request: CommunicationsCoverageRequest }
  | { readonly kind: 'NOT_ASKABLE' }
  | { readonly kind: 'NOT_OWNER' };

const decodeRequest = Schema.decodeUnknownOption(privacyOwnerCoverageOperation.request);

export const communicationsCoverageRequestOf = (input: {
  readonly dataCoverage: Parameters<typeof communicationsScopePartsOf>[0];
  readonly lookup: OwnerInventoryOwnerLookup;
  readonly tenantId: string;
}): CommunicationsCoverageQuestion => {
  const parts = communicationsScopePartsOf(input.dataCoverage);
  if (parts.length === 0) {
    return { kind: 'NOT_OWNER' };
  }
  const raw = {
    scope: {
      controllerRef: input.lookup.controllerRef,
      ownerCapability: COMMUNICATIONS_MODULE_ID,
      requestedScopePartRefs: parts,
      requestedScopeRef: input.lookup.requestedScopeRef,
      subject: { _tag: 'RESOLVED_DATA_SUBJECT', subjectRef: input.lookup.subjectRef },
      tenantId: input.tenantId,
      trustedLookupRefs: input.lookup.trustedLookups.map(({ lookupRef }) => lookupRef),
    },
    trustedLookups: input.lookup.trustedLookups,
  };
  return Option.match(decodeRequest(input.lookup.right === undefined ? raw : { ...raw, right: input.lookup.right }), {
    onNone: (): CommunicationsCoverageQuestion => ({ kind: 'NOT_ASKABLE' }),
    onSome: (request) => ({ kind: 'ASK', request }),
  });
};

const sameSet = (left: readonly string[], right: readonly string[]): boolean => {
  const rightSet = new Set(right);
  return new Set(left).size === left.length && left.length === right.length && left.every((ref) => rightSet.has(ref));
};

const subjectKeyOf = (subject: PrivacyOwnerCoverageRequest['scope']['subject']): string =>
  Match.value(subject).pipe(
    Match.tag('RESOLVED_DATA_SUBJECT', ({ subjectRef }) => `S:${subjectRef}`),
    Match.tag('ANONYMOUS_PRIVACY_CONTEXT', ({ contextRef }) => `A:${contextRef}`),
    Match.exhaustive,
  );

/** An answer is the owner's answer to THIS question only when it echoes exactly the scope that was asked. */
const answersTheQuestion = (
  asked: PrivacyOwnerCoverageRequest['scope'],
  answer: PrivacyOwnerCoverageResponse['coverage']['scope'],
): boolean =>
  answer.ownerCapability === asked.ownerCapability &&
  answer.tenantId === asked.tenantId &&
  answer.controllerRef === asked.controllerRef &&
  answer.requestedScopeRef === asked.requestedScopeRef &&
  subjectKeyOf(answer.subject) === subjectKeyOf(asked.subject) &&
  sameSet(answer.requestedScopePartRefs, asked.requestedScopePartRefs) &&
  sameSet(answer.trustedLookupRefs, asked.trustedLookupRefs);

const unresolvedReasonOf = (coverage: PrivacyOwnerCoverageResponse['coverage']): string =>
  coverage.coverageParts.find(({ unresolvedReason }) => unresolvedReason !== undefined)?.unresolvedReason ??
  'COMMUNICATIONS_OWNER_COVERAGE_INCOMPLETE';

export interface CommunicationsObservation {
  readonly availability: 'AVAILABLE' | 'UNAVAILABLE';
  readonly observation: PrivacyOwnerObservation;
}

export const refused = (observedAt: string, reason: string): CommunicationsObservation => ({
  availability: 'UNAVAILABLE',
  observation: { moduleId: COMMUNICATIONS_MODULE_ID, observedAt, outcome: 'UNAVAILABLE', reason, resourceRefs: [] },
});

/** The part of the owner's answer that is not coverage, in the public shape of the inventory entry. */
const detailOf = (answer: PrivacyOwnerCoverageResponse): PrivacyOwnerAnswerDetail => {
  const detail = {
    configuration: answer.configuration.map(({ category, gapInputs, state }) => ({
      category,
      gapInputs: gapInputs.map(({ input, owner }) => ({ input, owner })),
      state,
    })),
    externalCopies: answer.externalCopies.map((copy) => ({
      ...copy,
      firstObservedAt: DateTime.formatIso(copy.firstObservedAt),
      lastObservedAt: DateTime.formatIso(copy.lastObservedAt),
    })),
  };
  return Option.isSome(answer.contribution) ? { ...detail, contribution: answer.contribution.value } : detail;
};

const coverageObservationOf = (
  asked: PrivacyOwnerCoverageRequest['scope'],
  answer: PrivacyOwnerCoverageResponse,
  observedAt: string,
): CommunicationsObservation => {
  const { coverage } = answer;
  const base = { moduleId: COMMUNICATIONS_MODULE_ID, observedAt: coverage.assessedAt };
  if (!answersTheQuestion(asked, coverage.scope)) {
    return {
      availability: 'AVAILABLE',
      observation: {
        ...base,
        observedAt,
        outcome: 'INDETERMINATE',
        reason: 'OWNER_ANSWER_DOES_NOT_MATCH_THE_EXACT_SCOPE_THAT_WAS_ASKED',
        resourceRefs: [],
      },
    };
  }
  const found = [...new Set(coverage.coverageParts.flatMap(({ foundContentRefs }) => foundContentRefs))];
  const refs = found.slice(0, MAX_PUBLISHED_RESOURCE_REFS);
  const complete = coverage.coverageStatus === 'COMPLETE';
  if (complete && coverage.contentStatus === 'NO_DATA' && found.length === 0) {
    return {
      availability: 'AVAILABLE',
      observation: {
        ...base,
        outcome: 'NO_DATA',
        reason: 'Owner evaluated every requested scope part completely',
        resourceRefs: [],
      },
    };
  }
  if (complete && coverage.contentStatus === 'FOUND' && found.length > 0) {
    // more references than one entry can publish is not complete publication: it stays partial and says so
    return found.length > MAX_PUBLISHED_RESOURCE_REFS
      ? {
          availability: 'AVAILABLE',
          observation: {
            ...base,
            outcome: 'PARTIAL',
            reason: 'RESOURCE_REFERENCES_EXCEED_THE_PUBLISHED_LIMIT',
            resourceRefs: refs,
          },
        }
      : { availability: 'AVAILABLE', observation: { ...base, outcome: 'FOUND', resourceRefs: refs } };
  }
  const outcome =
    coverage.coverageStatus === 'UNAVAILABLE' || coverage.coverageStatus === 'INDETERMINATE'
      ? coverage.coverageStatus
      : 'PARTIAL';
  return {
    availability: 'AVAILABLE',
    observation: { ...base, outcome, reason: unresolvedReasonOf(coverage), resourceRefs: refs },
  };
};

const observationOfAnswer = (
  asked: PrivacyOwnerCoverageRequest['scope'],
  answer: PrivacyOwnerCoverageResponse,
  observedAt: string,
): CommunicationsObservation => {
  const answered = coverageObservationOf(asked, answer, observedAt);
  // only an answer to exactly the question asked brings its contribution, copies and configuration along
  return answersTheQuestion(asked, answer.coverage.scope)
    ? { ...answered, observation: { ...answered.observation, ...detailOf(answer) } }
    : answered;
};

/**
 * What Privacy may conclude from one governed call to the owner. Only an answer to exactly the question asked becomes an
 * observation of the owner's coverage, together with what the same answer adds: the right-specific contribution, the external
 * copies and the configuration gaps, exactly as the owner reported them and never completed or defaulted by Privacy. A
 * refusal, a missing route, an outage or a rejected request is UNAVAILABLE with its kind named, so none of them can be
 * mistaken for an empty scope.
 */
export const communicationsObservationOf = (
  asked: PrivacyOwnerCoverageRequest['scope'],
  outcome: CallOutcome<PrivacyOwnerCoverageResponse>,
  observedAt: string,
): CommunicationsObservation =>
  Match.valueTags(outcome, {
    Forbidden: () => refused(observedAt, 'OWNER_READ_FORBIDDEN'),
    NotFound: () => refused(observedAt, 'OWNER_SCOPE_NOT_FOUND'),
    Ok: ({ value }) => observationOfAnswer(asked, value, observedAt),
    Rejected: () => refused(observedAt, 'OWNER_REJECTED_THE_REQUEST'),
    Unavailable: () => refused(observedAt, 'OWNER_UNAVAILABLE'),
  });
