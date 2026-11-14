import { DateTime, Effect, Exit, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ConnectDenyRequestSchema,
  ConnectDraftRequestSchema,
  ConnectOptionsSchema,
  ConnectionClientSchema,
  ConnectionSummarySchema,
  OAUTH_DRAFT_TTL_SECONDS,
} from '../../src/oauth-connections.ts';

const client = {
  clientId: 'https://example.test/client.json',
  host: 'example.test',
  kind: 'cimd',
  logoUri: null,
  name: 'Example client',
} as const;

it.effect('OAuth absence and opaque identifiers retain the exact required-null wire fields', () =>
  Effect.gen(function* optionRoundTrip() {
    const wire = {
      client,
      companies: [],
      preselect: { agentPrincipalId: null, legalEntityId: null },
      state: 'access_blocked',
      user: { displayName: 'User', principalId: 'principal-from-provider' },
    } as const;
    const decoded = yield* Schema.decodeEffect(ConnectOptionsSchema)(wire);
    expect(Option.isNone(decoded.client.logoUri)).toBe(true);
    expect(Option.isNone(decoded.preselect.agentPrincipalId)).toBe(true);
    expect(Option.isNone(decoded.preselect.legalEntityId)).toBe(true);
    expect(yield* Schema.encodeEffect(ConnectOptionsSchema)(decoded)).toEqual(wire);
    const omitted = yield* Effect.exit(
      Schema.decodeUnknownEffect(ConnectOptionsSchema)({
        ...wire,
        preselect: { legalEntityId: null },
      }),
    );
    expect(Exit.isFailure(omitted)).toBe(true);
  }),
);

it.effect('OAuth request None encodes as null and present identifiers keep the original request bounds', () =>
  Effect.gen(function* requestRoundTrip() {
    const wire = {
      actingPrincipalId: null,
      legalEntityId: 'company-with-an-opaque-id',
      modules: 'all',
      oauthQuery: 'signed=query',
      writePolicy: 'approval',
    } as const;
    const decoded = yield* Schema.decodeEffect(ConnectDraftRequestSchema)(wire);
    expect(Option.isNone(decoded.actingPrincipalId)).toBe(true);
    expect(yield* Schema.encodeEffect(ConnectDraftRequestSchema)(decoded)).toEqual(wire);
    const agentWire = { ...wire, actingPrincipalId: 'agent-with-an-opaque-id' };
    const agent = yield* Schema.decodeEffect(ConnectDraftRequestSchema)(agentWire);
    expect(Option.getOrUndefined(agent.actingPrincipalId)).toBe(agentWire.actingPrincipalId);
    expect(yield* Schema.encodeEffect(ConnectDraftRequestSchema)(agent)).toEqual(agentWire);
    const invalid = yield* Effect.exit(
      Schema.decodeEffect(ConnectDraftRequestSchema)({
        ...wire,
        actingPrincipalId: '',
      }),
    );
    expect(Exit.isFailure(invalid)).toBe(true);
    const deniedWire = { grantId: null, oauthQuery: wire.oauthQuery };
    const denied = yield* Schema.decodeEffect(ConnectDenyRequestSchema)(deniedWire);
    expect(yield* Schema.encodeEffect(ConnectDenyRequestSchema)(denied)).toEqual(deniedWire);
  }),
);

it.effect('OAuth summaries decode temporal values and encode canonical UTC timestamps with nullable last use', () =>
  Effect.gen(function* temporalRoundTrip() {
    const wire = {
      acting: { displayName: 'User', kind: 'human', principalId: 'principal-1' },
      client,
      createdAt: '2026-10-27T12:34:56.123Z',
      delegatedBy: null,
      grantId: 'grant-1',
      lastUsedAt: null,
      legalEntityId: 'company-1',
      legalName: 'Company',
      modules: [],
      profileId: 'profile-1',
      requestedModules: 'all',
      status: 'active',
      tenantId: 'tenant-1',
      userDisplayName: 'User',
      writePolicy: 'approval',
    } as const;
    const decoded = yield* Schema.decodeEffect(ConnectionSummarySchema)(wire);
    expect(DateTime.formatIso(decoded.createdAt)).toBe(wire.createdAt);
    expect(Option.isNone(decoded.lastUsedAt)).toBe(true);
    expect(Option.isNone(decoded.delegatedBy)).toBe(true);
    expect(yield* Schema.encodeEffect(ConnectionSummarySchema)(decoded)).toEqual(wire);
    const usedWire = {
      ...wire,
      delegatedBy: { displayName: 'Operator', principalId: 'operator-1' },
      lastUsedAt: '2026-10-27T12:35:00.000Z',
    };
    const used = yield* Schema.decodeEffect(ConnectionSummarySchema)(usedWire);
    expect(Option.map(DateTime.formatIso)(used.lastUsedAt)).toEqual(Option.some(usedWire.lastUsedAt));
    expect(yield* Schema.encodeEffect(ConnectionSummarySchema)(used)).toEqual(usedWire);
    const offset = yield* Schema.decodeEffect(ConnectionSummarySchema)({
      ...wire,
      createdAt: '2026-10-27T14:34:56.123+02:00',
    });
    expect(yield* Schema.encodeEffect(ConnectionSummarySchema)(offset)).toEqual(wire);
    const invalid = yield* Effect.exit(
      Schema.decodeEffect(ConnectionSummarySchema)({
        ...wire,
        createdAt: 'not-a-timestamp',
      }),
    );
    expect(Exit.isFailure(invalid)).toBe(true);
  }),
);

it.effect('an empty logo remains present and the OAuth draft lifetime remains thirty minutes', () =>
  Effect.gen(function* emptyLogoRoundTrip() {
    const wire = { ...client, logoUri: '' };
    const decoded = yield* Schema.decodeEffect(ConnectionClientSchema)(wire);
    expect(decoded.logoUri).toEqual(Option.some(''));
    expect(yield* Schema.encodeEffect(ConnectionClientSchema)(decoded)).toEqual(wire);
    expect(OAUTH_DRAFT_TTL_SECONDS).toBe(1800);
  }),
);
