// An agent grant's credential-bound connection ends BEFORE anything else when the grant leaves `active`: a refresh
// replay, a revocation and a supersede by a new consent all refuse the agent first, so a later failing step never
// leaves the agent acting on a grant someone ended.
import { agentConnectionIdOfGrant, AgentConnectionStore } from '@app/core-runtime/access/intent/agent-connections';
import { Effect, Layer, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import { OAuthAuthenticationAudit } from '../../../../../packages/core-runtime/src/auth/oauth-authentication-audit.ts';
import { OAuthGrantRegistry } from '../../../../../packages/core-runtime/src/auth/oauth-grant-registry-service.ts';
import { OAuthCredentials } from '../../../api/auth/db/oauth-credentials.ts';
import { finishRevocation, revokeConnection } from '../../../api/oauth-connections/connection-service.ts';
import {
  OAuthEndpointGuardData,
  OAuthEndpointGuardDataLive,
  toGrantRow,
} from '../../../api/oauth-connections/grant-store.ts';
import { OAuthFlow } from '../../../api/oauth-connections/oauth-flow.ts';
import type { OAuthRefreshGuardRow } from '../../../api/oauth-connections/types.ts';
import { agentConnectionStoreDouble } from '../../support/agent-connection-store-double.ts';
import { grantRegistryFixture, retainedGrant } from './grant-registry-fixture.ts';

const agentGrant = { ...retainedGrant, actingKind: 'agent' as const };
const connectionId = agentConnectionIdOfGrant(agentGrant.grantId);

/** Every step in order; the connection store and the registry write into the same log. */
const recorder = () => {
  const events: string[] = [];
  const double = agentConnectionStoreDouble();
  const connections = Layer.succeed(AgentConnectionStore, {
    ...double.service,
    revoke: (scope, id) =>
      double.service.revoke(scope, id).pipe(Effect.andThen(Effect.sync(() => events.push('connection-ended')))),
  });
  const registry = grantRegistryFixture({
    findGrant: () => Effect.succeed(Option.some(agentGrant)),
    setGrantBindingStatus: () => Effect.sync(() => events.push('binding-disabled')),
    setGrantStatus: ({ status }) =>
      Effect.sync(() => {
        events.push(`grant-${status}`);
        return Option.some({ ...agentGrant, status });
      }),
  });
  const flow = Layer.mock(OAuthFlow, { deleteGrantTokens: () => Effect.sync(() => events.push('tokens-deleted')) });
  const audit = Layer.succeed(OAuthAuthenticationAudit, {
    record: () => Effect.sync(() => events.push('audited')),
  });
  return { connections, double, events, layers: Layer.mergeAll(connections, flow, audit), registry };
};

it.effect('a replayed refresh family ends the agent connection before the grant is revoked', () =>
  Effect.gen(function* replay() {
    const { connections, double, events, registry } = recorder();
    const row: OAuthRefreshGuardRow = {
      clientId: agentGrant.clientId,
      grant: Option.some(toGrantRow(agentGrant)),
      id: 'refresh-row',
      referenceId: agentGrant.grantId,
      revoked: agentGrant.createdAt,
      rotatedAt: agentGrant.createdAt,
      rotationReplayExpiresAt: null,
    };
    const credentials = Layer.succeed(OAuthCredentials, {
      loadRefresh: () => Effect.succeed(Option.none()),
      loadUserAccount: () => Effect.succeed(Option.none()),
      revokeFamily: () => Effect.sync(() => events.push('family-revoked')),
    });
    yield* Effect.gen(function* revokeFamily() {
      yield* (yield* OAuthEndpointGuardData).revokeFamily(row);
    }).pipe(
      Effect.provide(
        OAuthEndpointGuardDataLive.pipe(
          Layer.provide(Layer.mergeAll(Layer.succeed(OAuthGrantRegistry, registry), credentials, connections)),
        ),
      ),
    );
    expect(events).toEqual(['connection-ended', 'grant-revoked', 'family-revoked']);
    expect(double.revoked).toEqual([connectionId]);
  }),
);

it.effect('revoking an agent grant ends its connection before the grant status changes', () =>
  Effect.gen(function* revoke() {
    const { double, events, layers, registry } = recorder();
    yield* revokeConnection({
      actorPrincipalId: null,
      grantId: agentGrant.grantId,
      note: null,
      reason: 'user',
    }).pipe(Effect.provide(layers), Effect.provideService(OAuthGrantRegistry, registry));
    expect(events[0]).toBe('connection-ended');
    expect(events.indexOf('grant-revoked')).toBeGreaterThan(0);
    expect(double.revoked[0]).toBe(connectionId);
  }),
);

it.effect('a consent superseding an agent grant ends the old connection before its tokens go', () =>
  Effect.gen(function* supersede() {
    const { double, events, layers } = recorder();
    yield* finishRevocation({
      actorPrincipalId: agentGrant.userId,
      grant: toGrantRow({ ...agentGrant, status: 'superseded' }),
      note: null,
      reason: 'superseded',
    }).pipe(Effect.provide(layers));
    expect(events).toEqual(['connection-ended', 'tokens-deleted', 'audited']);
    expect(double.revoked).toEqual([connectionId]);
  }),
);
