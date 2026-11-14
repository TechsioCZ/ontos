import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Crypto, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import {
  MeasureExecutionNativeFixtureError,
  seedMeasureExecutionNativeFixture,
} from '../support/measure-execution-native.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

it.live('prepares current native governance without dispatch and appends a real hold and release history', () =>
  Effect.gen(function* nativeMeasureFixture() {
    // This tests isolated owner-local governance setup, not receiving-owner composition.
    const compositionSnapshot = yield* makeApplicationCompositionSnapshotFixture(['privacy']);
    const isolated = yield* makeIsolatedNativeDatabaseFixture({
      compositionSnapshot,
      mode: 'schema-only',
      purpose: 'implementation-1096-privacy-measure-native-helper',
    });
    const crypto = yield* Crypto.Crypto;
    const tenantId = yield* crypto.randomUUIDv4();
    const legalEntityId = yield* crypto.randomUUIDv4();
    const governancePrincipalId = yield* crypto.randomUUIDv4();
    const resourceRef = `integration.symmy.job:${yield* crypto.randomUUIDv4()}`;
    const fixture = yield* seedMeasureExecutionNativeFixture({
      connections: isolated.connections,
      contentScopeRef: `${resourceRef}#integration.symmy.job-intent`,
      governancePrincipalId,
      legalEntityId,
      resourceRef,
      tenantId,
    });
    expect(fixture.handoff).toMatchObject({
      contentScopeRefs: [`${resourceRef}#integration.symmy.job-intent`],
      dispositionDecision: 'DELETE',
      resourceRefs: [resourceRef],
      sourceDecisionRevision: 1,
      subjectRef: resourceRef,
      tenantId,
    });
    expect(yield* fixture.observe()).toEqual({ dispatch: Option.none(), outcomes: [] });
    expect(yield* fixture.setHold(false)).toBe(false);
    expect(yield* fixture.setHold(true)).toBe(true);
    expect(yield* fixture.setHold(true)).toBe(true);
    expect(yield* fixture.setHold(false)).toBe(false);
    expect(yield* fixture.setHold(false)).toBe(false);
    expect(Schema.is(MeasureExecutionNativeFixtureError)(yield* Effect.flip(fixture.setHold(true)))).toBe(true);
    expect(yield* fixture.observe()).toEqual({ dispatch: Option.none(), outcomes: [] });

    const client = yield* PgClient.make({ url: Redacted.make(isolated.connections.admin.connectionString) });
    const records = yield* client`select
      (select count(*)::int from privacy.retention_rules where tenant_id=${tenantId}::uuid and legal_entity_id=${legalEntityId}::uuid) as rules,
      (select count(*)::int from privacy.retention_evaluation_work where tenant_id=${tenantId}::uuid and legal_entity_id=${legalEntityId}::uuid and status='READY') as evaluations,
      (select count(*)::int from privacy.disposition_decisions where tenant_id=${tenantId}::uuid and legal_entity_id=${legalEntityId}::uuid and decision_ref=${fixture.handoff.sourceDecisionRef}) as decisions,
      (select count(*)::int from privacy.legal_holds where tenant_id=${tenantId}::uuid and legal_entity_id=${legalEntityId}::uuid) as holds,
      (select count(*)::int from privacy.legal_holds where tenant_id=${tenantId}::uuid and legal_entity_id=${legalEntityId}::uuid and released_at is not null) as releases`;
    expect(records).toEqual([{ decisions: 1, evaluations: 1, holds: 2, releases: 1, rules: 1 }]);
    const history = yield* client`select hold_ref, recorded_at, released_at from privacy.legal_holds
      where tenant_id=${tenantId}::uuid and legal_entity_id=${legalEntityId}::uuid order by recorded_at`;
    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          hold_ref: Schema.String,
          recorded_at: Schema.Date,
          released_at: Schema.OptionFromNullOr(Schema.Date),
        }),
      ),
    )(history);
    const active = decoded.at(0);
    const release = decoded.at(1);
    expect(active?.released_at).toEqual(Option.none());
    expect(release?.hold_ref).toBe(active?.hold_ref);
    expect(release?.released_at).toEqual(Option.fromUndefinedOr(release?.recorded_at));
  }).pipe(Effect.scoped, Effect.provide(nativeServices), Effect.provide(Reactivity.layer)),
);
