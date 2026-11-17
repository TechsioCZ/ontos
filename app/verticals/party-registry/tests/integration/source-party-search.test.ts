import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { Array as EffectArray, ConfigProvider, DateTime, Duration, Effect, Result, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import { makeTestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { OrganizationBusinessSourceStatement } from '../../shared/apis/organization-record-facts.ts';
import { PartyCandidateSchema, PartyPersistenceUnavailable } from '../../shared/domain/identity-contracts.ts';
import { parties, partyContactPoints, partyRelations } from '../../src/db/schema.ts';
import { PartyClientSourcePrivacy } from '../../src/services/party-client-source-evidence.service.ts';
import type { SourceIntent } from '../../src/services/party-client-source-evidence.service.ts';
import {
  createOrMatchParty,
  recordSourceCreateReceipt,
} from '../../src/services/party-matching-persistence.service.ts';
import { SourcePartySearchRequestSchema } from '../../shared/apis/source-party-search.ts';
import { searchSourceParties } from '../../src/services/source-party-search.service.ts';
import {
  openPartyBoundaryClients,
  openBoundaryDatabases,
  registerPartyGatewayScope,
  establishPartyGatewayScope,
} from '../support/database-boundary.ts';

const tenantId = 'df710000-0000-4000-8000-000000000001';
const otherTenantId = 'df710000-0000-4000-8000-000000000002';
const principalId = 'df720000-0000-4000-8000-000000000001';
const legalEntityId = 'df730000-0000-4000-8000-000000000001';
const source = {
  issuer: 'internal-party-search-fixture',
  namespace: 'customers',
  recordType: 'customer',
  routeRef: 'internal-party-search-route',
};
const instant = '2020-01-01T00:00:00.000Z';
const at = () => DateTime.toDateUtc(DateTime.makeUnsafe(instant));
const invocation = (index: number) => `df740000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const partyRefOf = (partyId: string, tenant = tenantId) =>
  ({
    moduleId: 'party.registry',
    resourceId: partyId,
    resourceType: 'party.registry.party',
    tenantId: tenant,
  }) as const;
const searchBounds = { includeOrganizationName: true, includePersonProfile: true };
it.layer(NodeCrypto.layer, { excludeTestServices: true })((suite) => {
  suite.effect(
    'searches only candidate Parties, literally and ignoring case, on the fields their current Privacy export allows',
    () =>
      Effect.gen(function* sourcePartySearchFixture() {
        const clients = yield* openPartyBoundaryClients({ runtimeMaxConnections: 2 });
        const { runtime } = yield* openBoundaryDatabases(
          (client) => makeTestDatabaseFromClient(client, partyRelations),
          clients,
        );
        const grant = yield* registerPartyGatewayScope(clients, { tenantId, legalEntityId });
        const scope = {
          ...(yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
            authMethod: 'api_key',
            authBindingId: principalId,
            authContextRef: 'api_key:internal-party-search-fixture',
            tenantId,
            legalEntityId,
            principalId,
          })),
          correlationId: 'internal-party-search-fixture',
        };
        const bindings = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))([
          { ...source, authMethod: 'api_key', principalId, tenantId },
        ]);
        const deniedProfile = new Set<string>();
        const deniedOrganization = new Set<string>();
        const outage = { active: false };
        const privacy = {
          checkImport: ({ intent }: { readonly intent: SourceIntent }) => {
            if (outage.active) {
              return Effect.fail(
                new PartyPersistenceUnavailable({
                  code: 'party_persistence_unavailable',
                  reason: 'Internal Privacy outage fixture',
                }),
              );
            }
            const partyId = 'target' in intent && intent.target?.kind === 'PARTY' ? intent.target.partyId : undefined;
            if (intent.operation === 'ORGANIZATION_BUSINESS_NAME_EXPORT') {
              return Effect.succeed(
                partyId !== undefined && deniedOrganization.has(partyId)
                  ? ('DENIED' as const)
                  : ('ORGANIZATION_BUSINESS_ALLOWED' as const),
              );
            }
            return Effect.succeed(
              intent.operation === 'PROFILE_EXPORT' && partyId !== undefined && deniedProfile.has(partyId)
                ? ('DENIED' as const)
                : ('ALLOWED' as const),
            );
          },
        };
        let sequence = 0;
        const completed = yield* runtime
          .transaction((transaction) =>
            Effect.gen(function* searchTransaction() {
              yield* establishPartyGatewayScope(transaction, grant);
              const createParty = (input: {
                readonly business?: string;
                readonly first?: string;
                readonly last?: string;
                readonly record: string;
              }) =>
                Effect.gen(function* createSourceParty() {
                  sequence += 1;
                  const reference = { source, recordId: input.record, occurrenceId: `${input.record}-r1` };
                  const evidence = {
                    kind: 'CLIENT_SOURCE_ASSERTION',
                    observedSubject: input.business === undefined ? 'PERSON' : 'ORGANIZATION',
                    statement:
                      input.business === undefined
                        ? 'Internal fixture source declares this person'
                        : OrganizationBusinessSourceStatement,
                    subjectKey: input.record,
                    ...reference,
                    sourceObservedAt: instant,
                  };
                  const candidate = yield* Schema.decodeUnknownEffect(PartyCandidateSchema)(
                    input.business === undefined
                      ? {
                          partyType: 'PERSON',
                          firstName: input.first,
                          lastName: input.last,
                          officialIdentifiers: [],
                          evidenceRefs: [],
                          provenance: { source: 'internal-fixture', method: 'CLIENT_SOURCE_ASSERTION' },
                          validFrom: instant,
                          subjectEvidence: [evidence],
                        }
                      : {
                          partyType: 'ORGANIZATION',
                          businessName: input.business,
                          officialIdentifiers: [],
                          evidenceRefs: [],
                          provenance: { source: source.routeRef, method: 'CLIENT_SOURCE_ASSERTION' },
                          validFrom: instant,
                          subjectEvidence: [evidence],
                        },
                  );
                  const created = yield* createOrMatchParty(transaction, {
                    actionInvocationId: invocation(sequence),
                    candidate,
                    legalEntityId,
                    principalId,
                    sourceScope: scope,
                    tenantId,
                  });
                  assert.isOk(created.outcome === 'CREATED');
                  yield* recordSourceCreateReceipt(
                    transaction,
                    scope,
                    invocation(sequence),
                    created.decisionRef.resourceId,
                  );
                  return { partyId: created.partyRef.resourceId, sourceReference: reference };
                });
              const addContact = (partyId: string, contactPointType: 'EMAIL' | 'PHONE', value: string, ended = false) =>
                transaction.insert(partyContactPoints).values({
                  acceptedByActionInvocationId: invocation(900),
                  acceptedByPrincipalId: principalId,
                  contactPointType,
                  displayValue: value,
                  isCurrent: !ended,
                  normalizationVersion: contactPointType === 'EMAIL' ? 'email.v1' : 'phone.v1',
                  normalizedValue: value.toLowerCase(),
                  partyId,
                  policyVersion: 'fixture',
                  privacyClassification: 'PERSONAL',
                  provenanceMethod: 'DECLARATION',
                  provenanceSource: 'internal-fixture',
                  state: ended ? 'ENDED' : 'ACTIVE',
                  tenantId,
                  validFrom: at(),
                });

              const ada = yield* createParty({ first: 'Ada', last: 'Lovelace', record: 'customer-ada' });
              const odd = yield* createParty({ first: 'Odd', last: String.raw`50%_off\sale`, record: 'customer-odd' });
              const grace = yield* createParty({ first: 'Grace', last: 'Hopper', record: 'customer-grace' });
              const stranger = yield* createParty({ first: 'Ada', last: 'Byron', record: 'customer-stranger' });
              const engines = yield* createParty({ business: 'Analytical Engines Ltd', record: 'customer-engines' });
              const hidden = yield* createParty({ business: 'Engines Hidden Ltd', record: 'customer-hidden' });
              yield* addContact(ada.partyId, 'EMAIL', 'Ada.Lovelace@Example.test');
              yield* addContact(ada.partyId, 'PHONE', '+420111222333');
              yield* addContact(ada.partyId, 'EMAIL', 'former.ada@oldmail.test', true);
              yield* addContact(grace.partyId, 'EMAIL', 'grace@example.test');
              yield* addContact(stranger.partyId, 'EMAIL', 'stranger@example.test');
              deniedProfile.add(grace.partyId);
              deniedOrganization.add(hidden.partyId);

              const candidatesOf = (...created: (typeof ada)[]) =>
                created.map(({ partyId, sourceReference }) => ({ partyRef: partyRefOf(partyId), sourceReference }));
              const everyone = candidatesOf(ada, odd, grace, engines, hidden);
              const search = (terms: readonly string[], candidates = everyone, bounds = searchBounds) =>
                searchSourceParties(transaction, scope, { candidates, terms, ...bounds }).pipe(
                  Effect.provideService(PartyClientSourcePrivacy, privacy),
                );
              const idsOf = (...created: (typeof ada)[]) => created.map(({ partyId }) => partyId).toSorted();

              // Case-insensitive contains over first name, last name, business name, email and phone.
              expect((yield* search(['ADA'])).matches).toEqual([idsOf(ada)]);
              expect((yield* search(['lovelace', 'ada'])).matches).toEqual([idsOf(ada), idsOf(ada)]);
              expect((yield* search(['example.TEST'])).matches).toEqual([idsOf(ada)]);
              expect((yield* search(['+420111'])).matches).toEqual([idsOf(ada)]);
              expect((yield* search(['engines'])).matches).toEqual([idsOf(engines)]);
              expect((yield* search(['nothing-like-this'])).matches).toEqual([[]]);
              // A literal `%`, `_` or `\` is ordinary text and never a wildcard.
              for (const term of ['%', '_', '\\', '50%_off\\', String.raw`off\sale`]) {
                expect((yield* search([term])).matches, term).toEqual([idsOf(odd)]);
              }
              expect((yield* search(['a%a'])).matches).toEqual([[]]);
              expect((yield* search(['a_a'])).matches).toEqual([[]]);
              // An ended contact point and a Privacy-denied field are not matched, and nothing fails for them.
              expect((yield* search(['oldmail'])).matches).toEqual([[]]);
              expect((yield* search(['grace'])).matches).toEqual([[]]);
              expect((yield* search(['hopper', 'hidden'])).matches).toEqual([[], []]);
              // A Party that is not a candidate never matches, even with the same name.
              expect((yield* search(['byron'])).matches).toEqual([[]]);
              expect((yield* search(['stranger@'])).matches).toEqual([[]]);
              expect((yield* search(['byron'], candidatesOf(stranger))).matches).toEqual([idsOf(stranger)]);
              // Tenant isolation: another tenant's reference to the same id, and a wrong source reference, never match.
              const foreign = [
                { partyRef: partyRefOf(ada.partyId, otherTenantId), sourceReference: ada.sourceReference },
              ];
              expect((yield* search(['ada'], foreign)).matches).toEqual([[]]);
              const wrongSource = [
                {
                  partyRef: partyRefOf(ada.partyId),
                  sourceReference: { ...ada.sourceReference, occurrenceId: 'later' },
                },
              ];
              expect((yield* search(['ada'], wrongSource)).matches).toEqual([[]]);
              // The caller may restrict the fields it may read.
              expect(
                (yield* search(['ada', 'engines'], everyone, { ...searchBounds, includePersonProfile: false })).matches,
              ).toEqual([[], idsOf(engines)]);
              expect(
                (yield* search(['ada', 'engines'], everyone, { ...searchBounds, includeOrganizationName: false }))
                  .matches,
              ).toEqual([idsOf(ada), []]);
              // An unavailable Privacy is an error for the whole search, never a silently smaller answer.
              outage.active = true;
              expect(Result.isFailure(yield* search(['ada']).pipe(Effect.result))).toBe(true);
              outage.active = false;

              // Rough timing: thousands of Parties exist, the search covers only its 500 candidates.
              yield* transaction.insert(parties).values(
                EffectArray.makeBy(3000, (index) => ({
                  currentType: 'PERSON',
                  firstName: `Bulk${index}`,
                  lastName: 'Fixture',
                  tenantId,
                })),
              );
              const bare = yield* transaction
                .insert(parties)
                .values(
                  EffectArray.makeBy(495, (index) => ({
                    currentType: 'PERSON',
                    firstName: `Candidate${index}`,
                    lastName: index % 5 === 0 ? 'Lovelace' : 'Other',
                    tenantId,
                  })),
                )
                .returning({ partyId: parties.partyId });
              const crowd = [
                ...everyone,
                ...bare.map(({ partyId }) => ({
                  partyRef: partyRefOf(partyId),
                  sourceReference: { source, recordId: `bare-${partyId}`, occurrenceId: 'bare-r1' },
                })),
              ];
              expect(crowd).toHaveLength(500);
              const [elapsed, crowded] = yield* Effect.timed(search(['lovelace', 'candidate4', 'engines'], crowd));
              const elapsedMs = Duration.toMillis(elapsed);
              yield* Effect.log(
                `source party search over 500 candidates among 3500 parties: ${elapsedMs.toFixed(0)} ms`,
              );
              // Bare Parties have no source correlation, so only the real Lovelace matches; the rest is refused quietly.
              expect(crowded.matches[0]).toEqual(idsOf(ada));
              expect(crowded.matches[1]).toEqual([]);
              expect(crowded.matches[2]).toEqual(idsOf(engines));
              expect(elapsedMs).toBeLessThan(10_000);
              // The contract itself refuses more than 500 candidates, more than 10 terms and untrimmed or empty terms.
              const bounded = (candidates: readonly unknown[], terms: readonly string[]) =>
                Result.isSuccess(
                  Schema.decodeUnknownResult(SourcePartySearchRequestSchema)({ candidates, terms, ...searchBounds }),
                );
              expect(bounded(crowd, ['a'])).toBe(true);
              expect(bounded([...crowd, crowd[0]], ['a'])).toBe(false);
              expect(
                bounded(
                  [],
                  EffectArray.makeBy(10, (index) => `t${index}`),
                ),
              ).toBe(true);
              expect(
                bounded(
                  [],
                  EffectArray.makeBy(11, (index) => `t${index}`),
                ),
              ).toBe(false);
              expect(bounded([], [])).toBe(false);
              expect(bounded([], [' padded '])).toBe(false);
              expect(bounded([], [''])).toBe(false);
              return yield* Effect.fail('internal_party_search_rollback' as const);
            }).pipe(
              Effect.provideService(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromUnknown({ ONTOS_PARTY_CLIENT_SOURCE_BINDINGS: bindings }),
              ),
              Effect.provideService(PartyClientSourcePrivacy, privacy),
            ),
          )
          .pipe(Effect.result);
        expect(Result.match(completed, { onFailure: (failure) => failure, onSuccess: () => null })).toBe(
          'internal_party_search_rollback',
        );
      }),
  );
});
