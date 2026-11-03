import { DateTime, Effect, Option, Random, Schema } from 'effect';
import type { ModulePageContext } from '@app/shared-contracts/page-data';

import { executePartyContactPoints } from '../../../../../api/party-contact-points-client.ts';
import { executePartyDetail } from '../../../../../api/party-detail-client.ts';
import { executePartyOfficialIdentifierHistory } from '../../../../../api/party-official-identifier-history-client.ts';
import type { PartyContactPointsResponse } from '../../../../../../shared/apis/party-contact-points.ts';
import type { PartyDetailResponse } from '../../../../../../shared/apis/party-detail.ts';
import type { PartyOfficialIdentifierHistoryResponse } from '../../../../../../shared/apis/party-official-identifier-history.ts';
import type { PartyContactPoint } from '../../../../../../shared/domain/contact-point.ts';
import type { OfficialIdentifierAssertion } from '../../../../../../shared/domain/identifier-contracts.ts';
import type { Party } from '../../../../../../shared/domain/identity-contracts.ts';
import type { PartyRef } from '../../../../../../shared/resources/party.ts';

export const PARTY_IDENTITY_KEY = 'party-registry.pages.partyIdentity';

const exactUuid = Schema.String.check(Schema.isUUID());
export interface PartyIdentityRefCandidate {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}
const partyRefIsExact = (partyRef: PartyIdentityRefCandidate, tenantId: string): boolean =>
  partyRef.moduleId === 'party.registry' &&
  partyRef.resourceType === 'party.registry.party' &&
  partyRef.tenantId === tenantId &&
  Schema.is(exactUuid)(partyRef.resourceId);
const exactPartyRef = (partyRef: PartyIdentityRefCandidate): PartyRef => ({
  moduleId: 'party.registry',
  resourceId: partyRef.resourceId,
  resourceType: 'party.registry.party',
  tenantId: partyRef.tenantId,
});

const PartyIdentityRefusalSchema = Schema.Literals(['forbidden', 'not-found', 'unavailable']);
export type PartyIdentityRefusal = typeof PartyIdentityRefusalSchema.Type;

/** Every owner read keeps its own authorization and availability outcome. */
export type PartyIdentitySection<Value> =
  | { readonly status: 'ready'; readonly value: Value }
  | { readonly status: PartyIdentityRefusal };

const PartyIdentityFactViewSchema = Schema.Struct({
  factKind: Schema.Literals(['DISPLAY_NAME', 'PARTY_TYPE']),
  recordedAt: Schema.DateTimeUtc,
  validFrom: Schema.DateTimeUtc,
  value: Schema.String,
});

const PartyIdentityViewSchema = Schema.Struct({
  aliasResolved: Schema.Boolean,
  archived: Schema.Boolean,
  createdAt: Schema.DateTimeUtc,
  displayName: Schema.optionalKey(Schema.String),
  facts: Schema.Array(PartyIdentityFactViewSchema),
  partyType: Schema.Literals(['PERSON', 'ORGANIZATION', 'UNRESOLVED']),
  revision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
  updatedAt: Schema.DateTimeUtc,
});
export type PartyIdentityView = typeof PartyIdentityViewSchema.Type;

const PartyIdentifierViewSchema = Schema.Struct({
  current: Schema.Boolean,
  identifierType: Schema.Literals(['ICO', 'CZ_DIC']),
  recordedAt: Schema.DateTimeUtc,
  state: Schema.Literals(['ACTIVE', 'ENDED', 'SUPERSEDED', 'RETRACTED', 'DISPUTED']),
  validFrom: Schema.DateTimeUtc,
  validTo: Schema.OptionFromNullOr(Schema.DateTimeUtc),
  value: Schema.String,
  verification: Schema.Literals(['UNVERIFIED', 'VERIFIED', 'REJECTED']),
});
export type PartyIdentifierView = typeof PartyIdentifierViewSchema.Type;

export interface PartyContactView {
  readonly contactType: PartyContactPoint['value']['type'];
  readonly displayValue: string;
  readonly extension?: string;
  readonly preferred: boolean;
  readonly purposes: readonly string[];
  readonly verification: PartyContactPoint['verification']['state'];
}

const displayNameOf = (party: Party): string | undefined => Option.getOrUndefined(party.displayName);

const addressText = (address: {
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly countryCode: string;
  readonly postalCode: string | null;
  readonly region: string | null;
}): string =>
  [address.addressLine1, address.addressLine2, address.city, address.postalCode, address.region, address.countryCode]
    .filter((part): part is string => part !== null)
    .join(', ');

const contactView = (contact: PartyContactPoint): PartyContactView => {
  const { value } = contact;
  const addressPurposes = value.type === 'ADDRESS' ? value.purposes.filter(({ current }) => current) : [];
  const extension = value.type === 'PHONE' ? (value.extension ?? undefined) : undefined;
  const view: PartyContactView = {
    contactType: value.type,
    displayValue: value.type === 'ADDRESS' ? addressText(value.address) : value.displayValue,
    preferred: value.type === 'ADDRESS' ? addressPurposes.some(({ preferred }) => preferred) : value.preferred,
    purposes: addressPurposes.map(({ purpose }) => purpose),
    verification: contact.verification.state,
  };
  return extension === undefined ? view : { ...view, extension };
};

const identifierView = (identifier: OfficialIdentifierAssertion): PartyIdentifierView => ({
  current: identifier.state === 'ACTIVE' && identifier.validTo === null,
  identifierType: identifier.identifierType,
  recordedAt: DateTime.makeUnsafe(identifier.recordedAt),
  state: identifier.state,
  validFrom: DateTime.makeUnsafe(identifier.validFrom),
  validTo: identifier.validTo === null ? Option.none() : Option.some(DateTime.makeUnsafe(identifier.validTo)),
  value: identifier.normalizedValue,
  verification: identifier.verification,
});

const identifierOrder = (left: PartyIdentifierView, right: PartyIdentifierView): number => {
  if (left.current !== right.current) {
    return left.current ? -1 : 1;
  }
  return DateTime.toEpochMillis(right.recordedAt) - DateTime.toEpochMillis(left.recordedAt);
};

/** The current Party identity as display data. It never invents a revision or a commercial context. */
export const partyIdentityView = (detail: PartyDetailResponse): PartyIdentityView => {
  const displayName = displayNameOf(detail.party);
  const view: PartyIdentityView = {
    aliasResolved: detail.resolution.kind === 'ALIAS',
    archived: Option.isSome(detail.party.archivedAt),
    createdAt: detail.party.createdAt,
    facts: detail.currentFactAssertions.map((assertion) => ({
      factKind: assertion.factKind,
      recordedAt: assertion.recordedAt,
      validFrom: assertion.validFrom,
      value: assertion.value,
    })),
    partyType: detail.party.partyType,
    revision: detail.party.revision,
    updatedAt: detail.party.updatedAt,
  };
  return displayName === undefined ? view : { ...view, displayName };
};

const mapSection = <Value, Mapped>(
  section: PartyIdentitySection<Value>,
  map: (value: Value) => Mapped,
): PartyIdentitySection<Mapped> =>
  section.status === 'ready' ? { status: 'ready', value: map(section.value) } : section;

const refusalOf = <Failure>(error: Failure): PartyIdentityRefusal => {
  if (Schema.is(Schema.Struct({ status: Schema.Literal(403) }))(error)) {
    return 'forbidden';
  }
  if (Schema.is(Schema.Struct({ status: Schema.Literal(404) }))(error)) {
    return 'not-found';
  }
  return 'unavailable';
};

export const loadPartyIdentitySection = <Value, Failure>(
  operation: Effect.Effect<Value, Failure>,
): Effect.Effect<PartyIdentitySection<Value>> =>
  operation.pipe(
    Effect.match({
      onFailure: (error): PartyIdentitySection<Value> => ({ status: refusalOf(error) }),
      onSuccess: (value): PartyIdentitySection<Value> => ({ status: 'ready', value }),
    }),
  );

export interface PartyIdentityReaders {
  readonly contacts: (partyRef: PartyRef) => Effect.Effect<PartyIdentitySection<PartyContactPointsResponse>>;
  readonly identifiers: (
    partyRef: PartyRef,
  ) => Effect.Effect<PartyIdentitySection<PartyOfficialIdentifierHistoryResponse>>;
  readonly identity: (partyRef: PartyRef) => Effect.Effect<PartyIdentitySection<PartyDetailResponse>>;
}

const correlation = (operation: string) =>
  Effect.map(
    Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }),
    ([first, second]) => `party-registry:${operation}:${first}:${second}`,
  );

export const defaultPartyIdentityReaders: PartyIdentityReaders = {
  contacts: (partyRef) =>
    correlation('party-identity-contacts').pipe(
      Effect.flatMap((requestCorrelation) =>
        loadPartyIdentitySection(executePartyContactPoints({ includeHistorical: false, partyRef }, requestCorrelation)),
      ),
    ),
  identifiers: (partyRef) =>
    correlation('party-identity-identifiers').pipe(
      Effect.flatMap((requestCorrelation) =>
        loadPartyIdentitySection(executePartyOfficialIdentifierHistory({ partyRef }, requestCorrelation)),
      ),
    ),
  identity: (partyRef) =>
    correlation('party-identity').pipe(
      Effect.flatMap((requestCorrelation) =>
        loadPartyIdentitySection(executePartyDetail({ partyRef }, requestCorrelation)),
      ),
    ),
};

export type PartyIdentityReadResult =
  | { readonly status: 'invalid-ref' }
  | {
      readonly contacts?: PartyIdentitySection<readonly PartyContactView[]>;
      readonly identifiers?: PartyIdentitySection<readonly PartyIdentifierView[]>;
      readonly identity: PartyIdentitySection<PartyIdentityView>;
      readonly status: 'identity';
    };

export type PartyIdentityReadView =
  | { readonly status: 'invalid-ref' | 'loading' }
  | Extract<PartyIdentityReadResult, { readonly status: 'identity' }>;

export interface PartyIdentityReadyInput {
  readonly context: ModulePageContext;
  readonly partyId: string;
  readonly partyRef: PartyRef;
  readonly status: 'ready';
}

export type PartyIdentityInput = PartyIdentityReadyInput | { readonly status: 'invalid-ref' | 'scope-missing' };

/** A Party page reads one exact tenant identity UUID. The Shell session supplies the tenant and company scope. */
export const partyIdentityInput = (
  context: ModulePageContext | undefined,
  routeParams: Readonly<Record<string, string>>,
): PartyIdentityInput => {
  if (context === undefined || context.tenantId === '' || context.principalId === '' || context.legalEntityId === '') {
    return { status: 'scope-missing' };
  }
  const partyId = routeParams['partyId']?.trim() ?? '';
  if (!Schema.is(exactUuid)(partyId)) {
    return { status: 'invalid-ref' };
  }
  return {
    context,
    partyId,
    partyRef: {
      moduleId: 'party.registry',
      resourceId: partyId,
      resourceType: 'party.registry.party',
      tenantId: context.tenantId,
    },
    status: 'ready',
  };
};

/** The full Shell scope plus the exact Party id. A stale render can never show another scope's identity. */
export const partyIdentityKey = (context: ModulePageContext | undefined, partyId: string): string | undefined => {
  if (context === undefined || context.tenantId === '' || context.principalId === '' || context.legalEntityId === '') {
    return undefined;
  }
  return `${context.tenantId}|${context.legalEntityId}|${context.principalId}|party.registry|${partyId}`;
};

/** Reads the exact Party first, then the independently admitted identifiers and contacts. */
export const loadPartyIdentityWithReaders = Effect.fn('PartyIdentityData.load')(function* loadPartyIdentity(
  partyRef: PartyIdentityRefCandidate,
  tenantId: string,
  readers: PartyIdentityReaders,
): Effect.fn.Return<PartyIdentityReadResult> {
  if (!partyRefIsExact(partyRef, tenantId)) {
    return { status: 'invalid-ref' } as const;
  }
  const requested = exactPartyRef(partyRef);
  const identity = yield* readers.identity(requested);
  if (identity.status !== 'ready') {
    return { identity, status: 'identity' } as const;
  }
  const identityView = partyIdentityView(identity.value);
  const { canonicalPartyRef } = identity.value.resolution;
  if (!partyRefIsExact(canonicalPartyRef, tenantId)) {
    return {
      contacts: { status: 'unavailable' },
      identifiers: { status: 'unavailable' },
      identity: { status: 'ready', value: identityView },
      status: 'identity',
    } as const;
  }
  const canonical = exactPartyRef(canonicalPartyRef);
  const { contacts, identifiers } = yield* Effect.all(
    {
      contacts: readers.contacts(canonical),
      identifiers: readers.identifiers(canonical),
    },
    { concurrency: 2 },
  );
  return {
    contacts: mapSection(contacts, (value) => value.items.map(contactView)),
    identifiers: mapSection(identifiers, (value) => value.items.map(identifierView).toSorted(identifierOrder)),
    identity: { status: 'ready', value: identityView },
    status: 'identity',
  } as const;
});

export const loadPartyIdentity = (partyRef: PartyRef, tenantId: string) =>
  loadPartyIdentityWithReaders(partyRef, tenantId, defaultPartyIdentityReaders);
