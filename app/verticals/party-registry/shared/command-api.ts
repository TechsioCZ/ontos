/* eslint-disable import/no-duplicates, no-duplicate-imports, oxc/no-barrel-file -- Canonical public command contracts re-export schema-only Action payloads and results. */
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import { HttpApiMiddleware } from 'effect/unstable/httpapi';
import { PartyRefSchema } from './resources/party.ts';
import {
  AddContactPointPayloadSchema,
  AddContactPointResultSchema,
} from './actions/add-contact-point.ts';
import {
  AddPartyOfficialIdentifierPayloadSchema,
  AddPartyOfficialIdentifierResultSchema,
} from './actions/add-party-official-identifier.ts';
import { ArchivePartyPayloadSchema, ArchivePartyResultSchema } from './actions/archive-party.ts';
import {
  ConfirmDuplicatePartiesPayloadSchema,
  ConfirmDuplicatePartiesResultSchema,
} from './actions/confirm-duplicate-parties.ts';
import {
  CorrectPartyFactPayloadSchema,
  CorrectPartyFactResultSchema,
} from './actions/correct-party-fact.ts';
import {
  CounterpartyCreatePayloadSchema,
  CounterpartyCreateResultSchema,
} from './actions/counterparty-create.ts';
import {
  CounterpartyRoleAddPayloadSchema,
  CounterpartyRoleAddResultSchema,
} from './actions/counterparty-role-add.ts';
import {
  CounterpartyRoleEndPayloadSchema,
  CounterpartyRoleEndResultSchema,
} from './actions/counterparty-role-end.ts';
import {
  CreatePartyRelationshipPayloadSchema,
  CreatePartyRelationshipResultSchema,
} from './domain/relationship-contract.ts';
import { CreatePartyPayloadSchema, CreatePartyResultSchema } from './actions/create-party.ts';
import {
  DismissDuplicateCandidatePayloadSchema,
  DismissDuplicateCandidateResultSchema,
} from './actions/dismiss-duplicate-candidate.ts';
import {
  EndContactPointPayloadSchema,
  EndContactPointResultSchema,
} from './actions/end-contact-point.ts';
import {
  EndPartyOfficialIdentifierPayloadSchema,
  EndPartyOfficialIdentifierResultSchema,
} from './actions/end-party-official-identifier.ts';
import {
  EndPartyRelationshipPayloadSchema,
  ChangePartyRelationshipResultSchema as EndPartyRelationshipResultSchema,
} from './domain/relationship-contract.ts';
import {
  MarkDuplicateCandidateNeedsEvidencePayloadSchema,
  MarkDuplicateCandidateNeedsEvidenceResultSchema,
} from './actions/mark-duplicate-candidate-needs-evidence.ts';
import { MatchPartyPayloadSchema, MatchPartyResultSchema } from './actions/match-party.ts';
import {
  RequestSearchRebuildPayloadSchema,
  RequestSearchRebuildResultSchema,
} from './actions/request-search-rebuild.ts';
import {
  ResolveDuplicateCandidateCreatePayloadSchema,
  ResolveDuplicateCandidateCreateResultSchema,
} from './actions/resolve-duplicate-candidate-create.ts';
import {
  ResolveDuplicateCandidateMatchPayloadSchema,
  ResolveDuplicateCandidateMatchResultSchema,
} from './actions/resolve-duplicate-candidate-match.ts';
import {
  UnarchivePartyPayloadSchema,
  UnarchivePartyResultSchema,
} from './actions/unarchive-party.ts';
import {
  UpdateContactPointPayloadSchema,
  UpdateContactPointResultSchema,
} from './actions/update-contact-point.ts';
import {
  UpdatePartyOfficialIdentifierPayloadSchema,
  UpdatePartyOfficialIdentifierResultSchema,
} from './actions/update-party-official-identifier.ts';
import {
  UpdatePartyRelationshipPayloadSchema,
  ChangePartyRelationshipResultSchema as UpdatePartyRelationshipResultSchema,
} from './domain/relationship-contract.ts';
import { UpdatePartyPayloadSchema, UpdatePartyResultSchema } from './actions/update-party.ts';

export {
  AddContactPointPayloadSchema,
  AddContactPointResultSchema,
} from './actions/add-contact-point.ts';
export type AddContactPointPayload = typeof AddContactPointPayloadSchema.Type;
export type AddContactPointResult = typeof AddContactPointResultSchema.Type;
export {
  AddPartyOfficialIdentifierPayloadSchema,
  AddPartyOfficialIdentifierResultSchema,
} from './actions/add-party-official-identifier.ts';
export type AddPartyOfficialIdentifierPayload = typeof AddPartyOfficialIdentifierPayloadSchema.Type;
export type AddPartyOfficialIdentifierResult = typeof AddPartyOfficialIdentifierResultSchema.Type;
export { ArchivePartyPayloadSchema, ArchivePartyResultSchema } from './actions/archive-party.ts';
export type ArchivePartyPayload = typeof ArchivePartyPayloadSchema.Type;
export type ArchivePartyResult = typeof ArchivePartyResultSchema.Type;
export {
  ConfirmDuplicatePartiesPayloadSchema,
  ConfirmDuplicatePartiesResultSchema,
} from './actions/confirm-duplicate-parties.ts';
export type ConfirmDuplicatePartiesPayload = typeof ConfirmDuplicatePartiesPayloadSchema.Type;
export type ConfirmDuplicatePartiesResult = typeof ConfirmDuplicatePartiesResultSchema.Type;
export {
  CorrectPartyFactPayloadSchema,
  CorrectPartyFactResultSchema,
} from './actions/correct-party-fact.ts';
export type CorrectPartyFactPayload = typeof CorrectPartyFactPayloadSchema.Type;
export type CorrectPartyFactResult = typeof CorrectPartyFactResultSchema.Type;
export {
  CounterpartyCreatePayloadSchema,
  CounterpartyCreateResultSchema,
} from './actions/counterparty-create.ts';
export type CounterpartyCreatePayload = typeof CounterpartyCreatePayloadSchema.Type;
export type CounterpartyCreateResult = typeof CounterpartyCreateResultSchema.Type;
export {
  CounterpartyRoleAddPayloadSchema,
  CounterpartyRoleAddResultSchema,
} from './actions/counterparty-role-add.ts';
export type CounterpartyRoleAddPayload = typeof CounterpartyRoleAddPayloadSchema.Type;
export type CounterpartyRoleAddResult = typeof CounterpartyRoleAddResultSchema.Type;
export {
  CounterpartyRoleEndPayloadSchema,
  CounterpartyRoleEndResultSchema,
} from './actions/counterparty-role-end.ts';
export type CounterpartyRoleEndPayload = typeof CounterpartyRoleEndPayloadSchema.Type;
export type CounterpartyRoleEndResult = typeof CounterpartyRoleEndResultSchema.Type;
export {
  CreatePartyRelationshipPayloadSchema,
  CreatePartyRelationshipResultSchema,
} from './domain/relationship-contract.ts';
export type CreatePartyRelationshipPayload = typeof CreatePartyRelationshipPayloadSchema.Type;
export type CreatePartyRelationshipResult = typeof CreatePartyRelationshipResultSchema.Type;
export { CreatePartyPayloadSchema, CreatePartyResultSchema } from './actions/create-party.ts';
export type CreatePartyPayload = typeof CreatePartyPayloadSchema.Type;
export type CreatePartyResult = typeof CreatePartyResultSchema.Type;
export {
  DismissDuplicateCandidatePayloadSchema,
  DismissDuplicateCandidateResultSchema,
} from './actions/dismiss-duplicate-candidate.ts';
export type DismissDuplicateCandidatePayload = typeof DismissDuplicateCandidatePayloadSchema.Type;
export type DismissDuplicateCandidateResult = typeof DismissDuplicateCandidateResultSchema.Type;
export {
  EndContactPointPayloadSchema,
  EndContactPointResultSchema,
} from './actions/end-contact-point.ts';
export type EndContactPointPayload = typeof EndContactPointPayloadSchema.Type;
export type EndContactPointResult = typeof EndContactPointResultSchema.Type;
export {
  EndPartyOfficialIdentifierPayloadSchema,
  EndPartyOfficialIdentifierResultSchema,
} from './actions/end-party-official-identifier.ts';
export type EndPartyOfficialIdentifierPayload = typeof EndPartyOfficialIdentifierPayloadSchema.Type;
export type EndPartyOfficialIdentifierResult = typeof EndPartyOfficialIdentifierResultSchema.Type;
export {
  EndPartyRelationshipPayloadSchema,
  ChangePartyRelationshipResultSchema as EndPartyRelationshipResultSchema,
} from './domain/relationship-contract.ts';
export type EndPartyRelationshipPayload = typeof EndPartyRelationshipPayloadSchema.Type;
export type EndPartyRelationshipResult = typeof EndPartyRelationshipResultSchema.Type;
export {
  MarkDuplicateCandidateNeedsEvidencePayloadSchema,
  MarkDuplicateCandidateNeedsEvidenceResultSchema,
} from './actions/mark-duplicate-candidate-needs-evidence.ts';
export type MarkDuplicateCandidateNeedsEvidencePayload =
  typeof MarkDuplicateCandidateNeedsEvidencePayloadSchema.Type;
export type MarkDuplicateCandidateNeedsEvidenceResult =
  typeof MarkDuplicateCandidateNeedsEvidenceResultSchema.Type;
export { MatchPartyPayloadSchema, MatchPartyResultSchema } from './actions/match-party.ts';
export type MatchPartyPayload = typeof MatchPartyPayloadSchema.Type;
export type MatchPartyResult = typeof MatchPartyResultSchema.Type;
export {
  RequestSearchRebuildPayloadSchema,
  RequestSearchRebuildResultSchema,
} from './actions/request-search-rebuild.ts';
export type RequestSearchRebuildPayload = typeof RequestSearchRebuildPayloadSchema.Type;
export type RequestSearchRebuildResult = typeof RequestSearchRebuildResultSchema.Type;
export {
  ResolveDuplicateCandidateCreatePayloadSchema,
  ResolveDuplicateCandidateCreateResultSchema,
} from './actions/resolve-duplicate-candidate-create.ts';
export type ResolveDuplicateCandidateCreatePayload =
  typeof ResolveDuplicateCandidateCreatePayloadSchema.Type;
export type ResolveDuplicateCandidateCreateResult =
  typeof ResolveDuplicateCandidateCreateResultSchema.Type;
export {
  ResolveDuplicateCandidateMatchPayloadSchema,
  ResolveDuplicateCandidateMatchResultSchema,
} from './actions/resolve-duplicate-candidate-match.ts';
export type ResolveDuplicateCandidateMatchPayload =
  typeof ResolveDuplicateCandidateMatchPayloadSchema.Type;
export type ResolveDuplicateCandidateMatchResult =
  typeof ResolveDuplicateCandidateMatchResultSchema.Type;
export {
  UnarchivePartyPayloadSchema,
  UnarchivePartyResultSchema,
} from './actions/unarchive-party.ts';
export type UnarchivePartyPayload = typeof UnarchivePartyPayloadSchema.Type;
export type UnarchivePartyResult = typeof UnarchivePartyResultSchema.Type;
export {
  UpdateContactPointPayloadSchema,
  UpdateContactPointResultSchema,
} from './actions/update-contact-point.ts';
export type UpdateContactPointPayload = typeof UpdateContactPointPayloadSchema.Type;
export type UpdateContactPointResult = typeof UpdateContactPointResultSchema.Type;
export {
  UpdatePartyOfficialIdentifierPayloadSchema,
  UpdatePartyOfficialIdentifierResultSchema,
} from './actions/update-party-official-identifier.ts';
export type UpdatePartyOfficialIdentifierPayload =
  typeof UpdatePartyOfficialIdentifierPayloadSchema.Type;
export type UpdatePartyOfficialIdentifierResult =
  typeof UpdatePartyOfficialIdentifierResultSchema.Type;
export {
  UpdatePartyRelationshipPayloadSchema,
  ChangePartyRelationshipResultSchema as UpdatePartyRelationshipResultSchema,
} from './domain/relationship-contract.ts';
export type UpdatePartyRelationshipPayload = typeof UpdatePartyRelationshipPayloadSchema.Type;
export type UpdatePartyRelationshipResult = typeof UpdatePartyRelationshipResultSchema.Type;
export { UpdatePartyPayloadSchema, UpdatePartyResultSchema } from './actions/update-party.ts';
export type UpdatePartyPayload = typeof UpdatePartyPayloadSchema.Type;
export type UpdatePartyResult = typeof UpdatePartyResultSchema.Type;

// Absence reaches the explicit 428 mapping; every typed command client requires a key.
export const PartyCommandHeadersSchema = Schema.Struct({
  'idempotency-key': Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  ),
});
const problemFields = { detail: Schema.String, title: Schema.String, type: Schema.String } as const;
const asProblemDetails = HttpApiSchema.asJson({ contentType: 'application/problem+json' });
export const PartyCommandInvalidRequestProblemSchema = Schema.TaggedStruct(
  'PartyCommandInvalidRequestProblem',
  {
    ...problemFields,
    status: Schema.Literal(400),
  },
).pipe(asProblemDetails, HttpApiSchema.status(400));

/** Converts framework payload/header decoding failures into the declared RFC 9457 shape. */
export class PartyCommandSchemaErrorMiddleware extends HttpApiMiddleware.Service<PartyCommandSchemaErrorMiddleware>()(
  'party-registry/PartyCommandSchemaErrorMiddleware',
  { error: PartyCommandInvalidRequestProblemSchema },
) {}

export const PartyCommandAuthenticationProblemSchema = Schema.TaggedStruct(
  'PartyCommandAuthenticationProblem',
  {
    ...problemFields,
    status: Schema.Literal(401),
  },
).pipe(asProblemDetails, HttpApiSchema.status(401));

export const PartyCommandForbiddenProblemSchema = Schema.TaggedStruct(
  'PartyCommandForbiddenProblem',
  {
    ...problemFields,
    status: Schema.Literal(403),
  },
).pipe(asProblemDetails, HttpApiSchema.status(403));

export const PartyCommandNotFoundProblemSchema = Schema.TaggedStruct(
  'PartyCommandNotFoundProblem',
  {
    ...problemFields,
    status: Schema.Literal(404),
  },
).pipe(asProblemDetails, HttpApiSchema.status(404));

export const PartyCommandConflictProblemSchema = Schema.TaggedStruct(
  'PartyCommandConflictProblem',
  {
    ...problemFields,
    code: Schema.Literals([
      'action_request_hash_conflict',
      'action_invocation_state_invalid',
      'party_lifecycle_conflict',
      'party_unarchive_identity_conflict',
      'party_unarchive_identity_ambiguous',
      'party_unarchive_review_required',
      'party_identifier_claim_conflict',
      'party_official_identifier_update_conflict',
      'party_contact_point_already_exists',
      'party_contact_point_revision_conflict',
      'party_contact_point_lifecycle_conflict',
      'party_contact_point_correction_required',
      'party_correction_conflict',
      'counterparty_party_archived',
      'counterparty_role_overlap',
      'counterparty_role_already_ended',
      'counterparty_temporal_conflict',
      'duplicate_candidate_conflict',
      'claim_owned_by_different_party',
      'party_relationship_overlap_conflict',
      'party_relationship_revision_conflict',
      'party_relationship_correction_required',
    ]),
    status: Schema.Literal(409),
  },
).pipe(asProblemDetails, HttpApiSchema.status(409));

export const PartyCommandUnprocessableProblemSchema = Schema.TaggedStruct(
  'PartyCommandUnprocessableProblem',
  {
    ...problemFields,
    code: Schema.Literals([
      'action_policy_denied',
      'party_evidence_insufficient',
      'party_official_identifier_invalid',
      'party_contact_point_invalid',
      'counterparty_evidence_insufficient',
      'party_relationship_endpoint_type_mismatch',
      'party_relationship_type_unsupported',
      'party_relationship_invalid_interval',
    ]),
    status: Schema.Literal(422),
  },
).pipe(asProblemDetails, HttpApiSchema.status(422));

export const PartyCommandPreconditionRequiredProblemSchema = Schema.TaggedStruct(
  'PartyCommandPreconditionRequiredProblem',
  {
    ...problemFields,
    status: Schema.Literal(428),
  },
).pipe(asProblemDetails, HttpApiSchema.status(428));

export const PartyCommandUnavailableProblemSchema = Schema.TaggedStruct(
  'PartyCommandUnavailableProblem',
  {
    ...problemFields,
    retryable: Schema.Literal(true),
    status: Schema.Literal(503),
  },
).pipe(asProblemDetails, HttpApiSchema.status(503));

const PartyCommandInvocationIdSchema = Schema.String.check(Schema.isUUID());

export const PartyCommandAlreadyCommittedProblemSchema = Schema.TaggedStruct(
  'PartyCommandAlreadyCommittedProblem',
  {
    ...problemFields,
    code: Schema.Literal('action_already_committed'),
    invocationId: PartyCommandInvocationIdSchema,
    resolution: Schema.Literal('REFRESH_GOVERNED_READS'),
    retryCommand: Schema.Literal(false),
    status: Schema.Literal(409),
  },
).pipe(asProblemDetails, HttpApiSchema.status(409));

/** Uncertainty is not a retry hint: resolve the durable invocation before any further command. */
export const PartyCommandCommitIndeterminateProblemSchema = Schema.TaggedStruct(
  'PartyCommandCommitIndeterminateProblem',
  {
    ...problemFields,
    invocationId: PartyCommandInvocationIdSchema,
    resolution: Schema.Literal('RESOLVE_COMMIT'),
    retryCommand: Schema.Literal(false),
    status: Schema.Literal(503),
  },
).pipe(asProblemDetails, HttpApiSchema.status(503));

export const ResolvePartyCommandCommitPayloadSchema = Schema.Struct({
  invocationId: PartyCommandInvocationIdSchema,
});
export type ResolvePartyCommandCommitPayload = typeof ResolvePartyCommandCommitPayloadSchema.Type;

export const ResolvePartyCommandCommitResultSchema = Schema.TaggedStruct(
  'PartyCommandCommitResolution',
  {
    invocationId: PartyCommandInvocationIdSchema,
    retryCommand: Schema.Literal(false),
    state: Schema.Literals(['OPEN', 'COMMITTED']),
  },
);
export type ResolvePartyCommandCommitResult = typeof ResolvePartyCommandCommitResultSchema.Type;

export const PartyCommandInternalProblemSchema = Schema.TaggedStruct(
  'PartyCommandInternalProblem',
  {
    ...problemFields,
    status: Schema.Literal(500),
  },
).pipe(asProblemDetails, HttpApiSchema.status(500));

export const PartyCommandAliasWriteRejectedProblemSchema = Schema.TaggedStruct(
  'PartyCommandAliasWriteRejectedProblem',
  {
    ...problemFields,
    aliasPartyRef: PartyRefSchema,
    canonicalPartyRef: PartyRefSchema,
    code: Schema.Literal('party_alias_write_rejected'),
    status: Schema.Literal(409),
  },
).pipe(asProblemDetails, HttpApiSchema.status(409));

export type PartyCommandProblem =
  | typeof PartyCommandInvalidRequestProblemSchema.Type
  | typeof PartyCommandAuthenticationProblemSchema.Type
  | typeof PartyCommandForbiddenProblemSchema.Type
  | typeof PartyCommandNotFoundProblemSchema.Type
  | typeof PartyCommandConflictProblemSchema.Type
  | typeof PartyCommandUnprocessableProblemSchema.Type
  | typeof PartyCommandPreconditionRequiredProblemSchema.Type
  | typeof PartyCommandUnavailableProblemSchema.Type
  | typeof PartyCommandCommitIndeterminateProblemSchema.Type
  | typeof PartyCommandAlreadyCommittedProblemSchema.Type
  | typeof PartyCommandInternalProblemSchema.Type
  | typeof PartyCommandAliasWriteRejectedProblemSchema.Type;

const commandErrors = [
  PartyCommandInvalidRequestProblemSchema,
  PartyCommandAuthenticationProblemSchema,
  PartyCommandForbiddenProblemSchema,
  PartyCommandNotFoundProblemSchema,
  PartyCommandConflictProblemSchema,
  PartyCommandUnprocessableProblemSchema,
  PartyCommandPreconditionRequiredProblemSchema,
  PartyCommandUnavailableProblemSchema,
  PartyCommandCommitIndeterminateProblemSchema,
  PartyCommandAlreadyCommittedProblemSchema,
  PartyCommandInternalProblemSchema,
  PartyCommandAliasWriteRejectedProblemSchema,
] as const;

/** One closed, statically named HTTP operation per registered Action; no dynamic dispatch envelope. */
export const partyRegistryCommandsApi = HttpApi.make('PartyRegistryCommandsApi').add(
  HttpApiGroup.make('partyCommands')
    .add(
      HttpApiEndpoint.post('addContactPoint', '/party-registry/actions/add-contact-point', {
        error: commandErrors,
        headers: PartyCommandHeadersSchema,
        payload: AddContactPointPayloadSchema,
        success: AddContactPointResultSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post(
        'addPartyOfficialIdentifier',
        '/party-registry/actions/add-party-official-identifier',
        {
          error: commandErrors,
          headers: PartyCommandHeadersSchema,
          payload: AddPartyOfficialIdentifierPayloadSchema,
          success: AddPartyOfficialIdentifierResultSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post('archiveParty', '/party-registry/actions/archive-party', {
        error: commandErrors,
        headers: PartyCommandHeadersSchema,
        payload: ArchivePartyPayloadSchema,
        success: ArchivePartyResultSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post(
        'confirmDuplicateParties',
        '/party-registry/actions/confirm-duplicate-parties',
        {
          error: commandErrors,
          headers: PartyCommandHeadersSchema,
          payload: ConfirmDuplicatePartiesPayloadSchema,
          success: ConfirmDuplicatePartiesResultSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post('correctPartyFact', '/party-registry/actions/correct-party-fact', {
        error: commandErrors,
        headers: PartyCommandHeadersSchema,
        payload: CorrectPartyFactPayloadSchema,
        success: CorrectPartyFactResultSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('counterpartyCreate', '/party-registry/actions/counterparty-create', {
        error: commandErrors,
        headers: PartyCommandHeadersSchema,
        payload: CounterpartyCreatePayloadSchema,
        success: CounterpartyCreateResultSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('counterpartyRoleAdd', '/party-registry/actions/counterparty-role-add', {
        error: commandErrors,
        headers: PartyCommandHeadersSchema,
        payload: CounterpartyRoleAddPayloadSchema,
        success: CounterpartyRoleAddResultSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('counterpartyRoleEnd', '/party-registry/actions/counterparty-role-end', {
        error: commandErrors,
        headers: PartyCommandHeadersSchema,
        payload: CounterpartyRoleEndPayloadSchema,
        success: CounterpartyRoleEndResultSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post(
        'createPartyRelationship',
        '/party-registry/actions/create-party-relationship',
        {
          error: commandErrors,
          headers: PartyCommandHeadersSchema,
          payload: CreatePartyRelationshipPayloadSchema,
          success: CreatePartyRelationshipResultSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post('createParty', '/party-registry/actions/create-party', {
        error: commandErrors,
        headers: PartyCommandHeadersSchema,
        payload: CreatePartyPayloadSchema,
        success: CreatePartyResultSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post(
        'dismissDuplicateCandidate',
        '/party-registry/actions/dismiss-duplicate-candidate',
        {
          error: commandErrors,
          headers: PartyCommandHeadersSchema,
          payload: DismissDuplicateCandidatePayloadSchema,
          success: DismissDuplicateCandidateResultSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post('endContactPoint', '/party-registry/actions/end-contact-point', {
        error: commandErrors,
        headers: PartyCommandHeadersSchema,
        payload: EndContactPointPayloadSchema,
        success: EndContactPointResultSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post(
        'endPartyOfficialIdentifier',
        '/party-registry/actions/end-party-official-identifier',
        {
          error: commandErrors,
          headers: PartyCommandHeadersSchema,
          payload: EndPartyOfficialIdentifierPayloadSchema,
          success: EndPartyOfficialIdentifierResultSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'endPartyRelationship',
        '/party-registry/actions/end-party-relationship',
        {
          error: commandErrors,
          headers: PartyCommandHeadersSchema,
          payload: EndPartyRelationshipPayloadSchema,
          success: EndPartyRelationshipResultSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'markDuplicateCandidateNeedsEvidence',
        '/party-registry/actions/mark-duplicate-candidate-needs-evidence',
        {
          error: commandErrors,
          headers: PartyCommandHeadersSchema,
          payload: MarkDuplicateCandidateNeedsEvidencePayloadSchema,
          success: MarkDuplicateCandidateNeedsEvidenceResultSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post('matchParty', '/party-registry/actions/match-party', {
        error: commandErrors,
        headers: PartyCommandHeadersSchema,
        payload: MatchPartyPayloadSchema,
        success: MatchPartyResultSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post(
        'requestSearchRebuild',
        '/party-registry/actions/request-search-rebuild',
        {
          error: commandErrors,
          headers: PartyCommandHeadersSchema,
          payload: RequestSearchRebuildPayloadSchema,
          success: RequestSearchRebuildResultSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'resolveDuplicateCandidateCreate',
        '/party-registry/actions/resolve-duplicate-candidate-create',
        {
          error: commandErrors,
          headers: PartyCommandHeadersSchema,
          payload: ResolveDuplicateCandidateCreatePayloadSchema,
          success: ResolveDuplicateCandidateCreateResultSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'resolveDuplicateCandidateMatch',
        '/party-registry/actions/resolve-duplicate-candidate-match',
        {
          error: commandErrors,
          headers: PartyCommandHeadersSchema,
          payload: ResolveDuplicateCandidateMatchPayloadSchema,
          success: ResolveDuplicateCandidateMatchResultSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post('unarchiveParty', '/party-registry/actions/unarchive-party', {
        error: commandErrors,
        headers: PartyCommandHeadersSchema,
        payload: UnarchivePartyPayloadSchema,
        success: UnarchivePartyResultSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('updateContactPoint', '/party-registry/actions/update-contact-point', {
        error: commandErrors,
        headers: PartyCommandHeadersSchema,
        payload: UpdateContactPointPayloadSchema,
        success: UpdateContactPointResultSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post(
        'updatePartyOfficialIdentifier',
        '/party-registry/actions/update-party-official-identifier',
        {
          error: commandErrors,
          headers: PartyCommandHeadersSchema,
          payload: UpdatePartyOfficialIdentifierPayloadSchema,
          success: UpdatePartyOfficialIdentifierResultSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'updatePartyRelationship',
        '/party-registry/actions/update-party-relationship',
        {
          error: commandErrors,
          headers: PartyCommandHeadersSchema,
          payload: UpdatePartyRelationshipPayloadSchema,
          success: UpdatePartyRelationshipResultSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post('updateParty', '/party-registry/actions/update-party', {
        error: commandErrors,
        headers: PartyCommandHeadersSchema,
        payload: UpdatePartyPayloadSchema,
        success: UpdatePartyResultSchema,
      }),
    )
    .middleware(PartyCommandSchemaErrorMiddleware),
);

/** Resolves only a durable invocation's commit state through Core; never dispatches an Action. */
export const partyRegistryCommandRecoveryApi = HttpApi.make('PartyRegistryCommandRecoveryApi').add(
  HttpApiGroup.make('partyCommandRecovery')
    .add(
      HttpApiEndpoint.post('resolve', '/party-registry/action-commits/resolve', {
        error: [
          PartyCommandInvalidRequestProblemSchema,
          PartyCommandAuthenticationProblemSchema,
          PartyCommandForbiddenProblemSchema,
          PartyCommandNotFoundProblemSchema,
          PartyCommandConflictProblemSchema,
          PartyCommandUnavailableProblemSchema,
          PartyCommandCommitIndeterminateProblemSchema,
          PartyCommandInternalProblemSchema,
        ],
        payload: ResolvePartyCommandCommitPayloadSchema,
        success: ResolvePartyCommandCommitResultSchema,
      }),
    )
    .middleware(PartyCommandSchemaErrorMiddleware),
);
