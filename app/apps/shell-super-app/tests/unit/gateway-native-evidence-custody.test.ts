import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { CoreDatabase, testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { Context, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { GatewayNativeEvidenceLive } from '../../api/auth/gateway-native-evidence.service.ts';
import { GatewayNativeEvidence } from '../../api/auth/gateway-native-evidence.ts';

type DatabaseFreeOperations = {
  readonly [Method in keyof GatewayNativeEvidence['Service']]: (
    ...input: Parameters<GatewayNativeEvidence['Service'][Method]>
  ) => Effect.Effect<unknown, unknown>;
};

it.effect('captures native custody, rechecks revocation on each call, and exposes no database requirement', () =>
  Effect.gen(function* nativeCustody() {
    const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
      authBindingId: '10000000-0000-4000-8000-000000000001',
      authContextRef: 'better-auth-api-key:source-key',
      authenticationNamespaceId: 'source-namespace',
      authMethod: 'api_key',
      principalId: '10000000-0000-4000-8000-000000000002',
      tenantId: '10000000-0000-4000-8000-000000000003',
    });
    let active = true;
    let reads = 0;
    const connection = testSqlConnection((statement, parameters) => {
      if (!statement.includes('from core.principals p')) {
        return Effect.succeed([]);
      }
      reads += 1;
      expect(statement).toContain('a.revoked_at is null');
      expect(statement).toContain("p.kind='integration' and p.status='active'");
      expect(statement).toContain("w.status='active'");
      expect(parameters).toContain(principal.tenantId);
      expect(parameters).toContain(principal.authBindingId);
      expect(parameters).toContain(principal.authenticationNamespaceId);
      expect(parameters).toContain('source-key');
      return Effect.succeed(active ? [{ principal_id: principal.principalId }] : []);
    });
    const database = Layer.effect(CoreDatabase, testCoreDatabase.pipe(Effect.map((executor) => ({ executor })))).pipe(
      Layer.provide(scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provide(Reactivity.layer))),
    );
    // Only the capability escapes construction; the calling context contains no CoreDatabase.
    const services = yield* Layer.build(GatewayNativeEvidenceLive.pipe(Layer.provide(database)));
    const native = Context.get(services, GatewayNativeEvidence);
    const admitted: Effect.Effect<
      typeof TrustedPrincipalContextSchema.Type,
      Effect.Error<ReturnType<typeof native.validateRoutePrincipal>>
    > = (native satisfies DatabaseFreeOperations).validateRoutePrincipal(principal, 'admit');
    expect(yield* admitted).toEqual(principal);
    active = false;
    const revoked = yield* native.validateRoutePrincipal(principal, 'admit').pipe(Effect.flip);
    expect(revoked).toMatchObject({ code: 'forbidden', reason: 'symmy_route_not_admitted' });
    expect(reads).toBe(2);
  }).pipe(Effect.scoped),
);
