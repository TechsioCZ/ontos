import { issueGatewayContext } from '@app/shared-contracts';
import {
  executeCounterpartyReadWithAuthorization,
  executePartyDetailWithAuthorization,
} from '@app/party-registry/api/client';
import { Config, Context, Effect, Layer } from 'effect';
import type { CounterpartyRef, PartyRef } from '../../../shared/party-registry-references.ts';
import {
  EngagementProfileConflict,
  PartyRegistryReferenceUnavailable,
} from '../../../shared/domain/engagement-profile.ts';
import { PartyRegistryReferenceRequest } from './reference-validation-request.ts';
import type { PartyRegistryReferenceRequestOptions } from './reference-validation-request.ts';

export interface EngagementPartyReferences {
  readonly counterpartyRef?: CounterpartyRef;
  readonly partyRef: PartyRef;
}

export interface PartyRegistryCounterpartyProjection {
  readonly counterpartyRef: CounterpartyRef;
  readonly partyRef: PartyRef;
  readonly roleTypes: readonly ('CUSTOMER' | 'SUPPLIER')[];
}

export interface PartyRegistryPartyProjection {
  readonly archived: boolean;
  readonly partyRef: PartyRef;
  readonly partyType: 'ORGANIZATION' | 'PERSON' | 'UNRESOLVED';
  readonly requestedPartyRef: PartyRef;
}

export interface PartyRegistryReferenceOperations {
  readonly readCounterparty: (
    ref: CounterpartyRef,
  ) => Effect.Effect<PartyRegistryCounterpartyProjection, PartyRegistryReferenceUnavailable>;
  readonly readParty: (
    ref: PartyRef,
  ) => Effect.Effect<PartyRegistryPartyProjection, PartyRegistryReferenceUnavailable>;
}

export interface PartyRegistryReferenceGatewayOptions extends PartyRegistryReferenceRequestOptions {
  readonly gatewayBaseUrl: URL;
  readonly partyRegistryBaseUrl: URL;
}

interface PartyRegistryReferenceGatewayDependencies {
  readonly executeCounterpartyRead: (
    ref: CounterpartyRef,
    authorization: string,
    correlationId: string,
    baseUrl: URL,
  ) => Effect.Effect<PartyRegistryCounterpartyProjection, PartyRegistryReferenceUnavailable>;
  readonly executePartyRead: (
    ref: PartyRef,
    authorization: string,
    correlationId: string,
    baseUrl: URL,
  ) => Effect.Effect<PartyRegistryPartyProjection, PartyRegistryReferenceUnavailable>;
  readonly issuePartyContext: (
    payload: { readonly audience: 'party-registry' },
    options: { readonly baseUrl: URL; readonly cookie?: string },
  ) => Effect.Effect<{ readonly token: string }, PartyRegistryReferenceUnavailable>;
}

interface PartyRegistryReferenceValidationService {
  readonly validate: (
    refs: EngagementPartyReferences,
    options: { readonly expectedPartyType: 'ORGANIZATION' | 'PERSON' },
  ) => Effect.Effect<
    void,
    EngagementProfileConflict | PartyRegistryReferenceUnavailable,
    PartyRegistryReferenceRequest
  >;
}

export class PartyRegistryReferenceValidation extends Context.Service<
  PartyRegistryReferenceValidation,
  PartyRegistryReferenceValidationService
>()(
  '@app/contacts/integrations/party-registry/reference-validation.gateway/PartyRegistryReferenceValidation',
) {}

const unavailable = () =>
  new PartyRegistryReferenceUnavailable({
    code: 'party_registry_reference_unavailable',
    reason: 'Party Registry reference validation is temporarily unavailable',
  });

const productionDependencies: PartyRegistryReferenceGatewayDependencies = {
  executeCounterpartyRead: (ref, authorization, correlationId, baseUrl) =>
    executeCounterpartyReadWithAuthorization(
      { counterpartyRef: ref },
      authorization,
      correlationId,
      { baseUrl },
    ).pipe(
      Effect.map((counterparty) => ({
        counterpartyRef: counterparty.counterpartyRef,
        partyRef: counterparty.party.canonicalPartyRef,
        roleTypes: counterparty.currentRoles.map(({ roleType }) => roleType),
      })),
      Effect.mapError(unavailable),
    ),
  executePartyRead: (ref, authorization, correlationId, baseUrl) =>
    executePartyDetailWithAuthorization({ partyRef: ref }, authorization, correlationId, {
      baseUrl,
    }).pipe(
      Effect.map(({ party, resolution }) => ({
        archived: party.archivedAt !== null,
        partyRef: party.partyRef,
        partyType: party.partyType,
        requestedPartyRef: resolution.requestedPartyRef,
      })),
      Effect.mapError(unavailable),
    ),
  issuePartyContext: (payload, options) =>
    issueGatewayContext(payload, options).pipe(Effect.mapError(unavailable)),
};

const acquireAuthorization = (
  options: PartyRegistryReferenceGatewayOptions,
  dependencies: PartyRegistryReferenceGatewayDependencies,
) =>
  dependencies
    .issuePartyContext(
      { audience: 'party-registry' },
      options.cookie === undefined
        ? { baseUrl: options.gatewayBaseUrl }
        : { baseUrl: options.gatewayBaseUrl, cookie: options.cookie },
    )
    .pipe(Effect.map(({ token }) => `Bearer ${token}`));

/** Builds validation operations exclusively from Party Registry's published contract-derived client. */
export const makePartyRegistryReferenceOperations = (
  options: PartyRegistryReferenceGatewayOptions,
  dependencies: PartyRegistryReferenceGatewayDependencies = productionDependencies,
): PartyRegistryReferenceOperations => ({
  readCounterparty: (ref) =>
    acquireAuthorization(options, dependencies).pipe(
      Effect.flatMap((authorization) =>
        dependencies.executeCounterpartyRead(
          ref,
          authorization,
          options.correlationId,
          options.partyRegistryBaseUrl,
        ),
      ),
    ),
  readParty: (ref) =>
    acquireAuthorization(options, dependencies).pipe(
      Effect.flatMap((authorization) =>
        dependencies.executePartyRead(
          ref,
          authorization,
          options.correlationId,
          options.partyRegistryBaseUrl,
        ),
      ),
    ),
});

export const validatePartyRegistryReferences = (
  operations: PartyRegistryReferenceOperations,
  refs: EngagementPartyReferences,
  options: { readonly expectedPartyType: 'ORGANIZATION' | 'PERSON' },
) =>
  Effect.gen(function* validateReferences() {
    const party = yield* operations.readParty(refs.partyRef);
    if (
      party.requestedPartyRef.resourceId !== refs.partyRef.resourceId ||
      party.requestedPartyRef.tenantId !== refs.partyRef.tenantId ||
      party.partyRef.tenantId !== refs.partyRef.tenantId
    ) {
      return yield* new EngagementProfileConflict({
        code: 'contacts_party_counterparty_mismatch',
        reason: 'The Party response does not resolve the supplied tenant reference',
      });
    }
    if (party.partyRef.resourceId !== refs.partyRef.resourceId) {
      return yield* new EngagementProfileConflict({
        code: 'contacts_party_alias_requires_canonical_reference',
        reason: 'New engagement profiles must target the canonical survivor Party reference',
      });
    }
    if (party.archived) {
      return yield* new EngagementProfileConflict({
        code: 'contacts_party_archived',
        reason: 'New engagement profiles cannot attach to an archived Party',
      });
    }
    const expectedType =
      party.partyType === options.expectedPartyType ||
      (options.expectedPartyType === 'PERSON' && party.partyType === 'UNRESOLVED');
    if (!expectedType) {
      return yield* new EngagementProfileConflict({
        code: 'contacts_party_type_mismatch',
        reason: 'The Party type does not support this engagement profile',
      });
    }
    if (refs.counterpartyRef === undefined) {
      return;
    }
    const counterparty = yield* operations.readCounterparty(refs.counterpartyRef);
    if (
      counterparty.counterpartyRef.resourceId !== refs.counterpartyRef.resourceId ||
      counterparty.counterpartyRef.tenantId !== refs.counterpartyRef.tenantId ||
      refs.counterpartyRef.tenantId !== refs.partyRef.tenantId ||
      counterparty.partyRef.resourceId !== party.partyRef.resourceId ||
      counterparty.partyRef.tenantId !== refs.partyRef.tenantId
    ) {
      return yield* new EngagementProfileConflict({
        code: 'contacts_party_counterparty_mismatch',
        reason: 'The Counterparty does not resolve to the supplied Party',
      });
    }
    if (!counterparty.roleTypes.includes('CUSTOMER')) {
      return yield* new EngagementProfileConflict({
        code: 'contacts_counterparty_customer_role_required',
        reason: 'An explicit commercial context requires a current CUSTOMER role',
      });
    }
  });

const usableBaseUrl = (url: URL) =>
  (url.protocol === 'https:' || url.protocol === 'http:') &&
  url.username === '' &&
  url.password === '' &&
  url.search === '' &&
  url.hash === '';

/** Configuration is evaluated only when a fresh Action handler validates references, never on replay. */
export const PartyRegistryReferenceValidationLive = Layer.succeed(
  PartyRegistryReferenceValidation,
  {
    validate: (refs, options) =>
      Effect.gen(function* validateRequestReferences() {
        const requestOptions = yield* PartyRegistryReferenceRequest;
        const urls = yield* Config.all({
          gatewayBaseUrl: Config.url('ONTOS_SHELL_GATEWAY_BASE_URL'),
          partyRegistryBaseUrl: Config.url('ONTOS_PARTY_REGISTRY_API_BASE_URL'),
        }).pipe(Effect.mapError(unavailable));
        return yield* usableBaseUrl(urls.gatewayBaseUrl) && usableBaseUrl(urls.partyRegistryBaseUrl)
          ? validatePartyRegistryReferences(
              makePartyRegistryReferenceOperations({ ...requestOptions, ...urls }),
              refs,
              options,
            )
          : Effect.fail(unavailable());
      }),
  },
);
