import { Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeShellAuthenticationApiRuntime } from '../../api/index.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { templateDatabaseLayer } from '../support/access-admin-real-gate-fixture.ts';
import { MEDIA_CAPABILITIES, withMediaE2eWorld } from '../support/core-media-e2e-fixture.ts';
import type { E2eActor, MediaE2eWorld } from '../support/core-media-e2e-fixture.ts';
import { patternBytes, putBytes, reserve, rowOf } from '../support/core-media-e2e-steps.ts';

/*
 * EVIDENCE: INTEGRATION EXECUTED on the real composition (production Shell, Core runtime, PostgreSQL, SpiceDB) over an
 * S3-compatible EMULATOR (MinIO), NOT R2. The corruption is CONTROLLED FAULT INJECTION: the stored bytes of a ready
 * asset are replaced out of band at the emulator.
 *
 * What an operator of `core.media.integrity` can rely on (CORE_MEDIA.md, "Enrolling the integrity principal"):
 * the enrolment is ONE active `system` principal of the tenant holding ONE active binding, for exactly this key, and the
 * Shell then closes proven corruption as `failed`. Anything else (no principal, a principal that is not of kind `system`,
 * a disabled principal, a revoked binding) records nothing, leaves the asset `ready` and is written to the log as
 * `core.media.integrity.unrecorded` with the refusal; enrolling the exact principal afterwards records the very same
 * corruption on the next download. A stage accounts file `workloads` entry binds an account (a person), which is such a
 * non-`system` principal; the suite stands a service principal in for it.
 *
 * The enrolment itself is a fixture's SQL (`enrolSystemWorkload`), the way every other end-to-end proof enrols its
 * workload: this suite proves what the Shell does with an enrolment, not how an operator creates one.
 */

const platform = {
  makeActionRepository,
  makeActionRuntime,
  makeCompositionSnapshot,
  makeReadRuntime,
  makeShellAuthenticationApiRuntime,
};

const WORKLOAD_KEY = 'core.media.integrity';
const UNRECORDED = 'core.media.integrity.unrecorded';
const DENIED = 'SystemPrincipalContextDeniedError';
const uploaderCapabilities = [MEDIA_CAPABILITIES.upload, MEDIA_CAPABILITIES.confirm];
const readerCapabilities = [MEDIA_CAPABILITIES.metadata, MEDIA_CAPABILITIES.download];

const person = (world: MediaE2eWorld, name: string): E2eActor => {
  const actor = world.people.get(name);
  if (actor === undefined) {
    throw new Error(`The world has no ${name}`);
  }
  return actor;
};

/** A ready asset whose stored bytes were then replaced by other bytes of the same length: proven corruption on download. */
const corruptReadyAsset = Effect.fn('CoreMediaE2e.corruptReadyAsset')(function* corruptReadyAsset(
  world: MediaE2eWorld,
  edge: Effect.Success<MediaE2eWorld['shell']>,
) {
  const uploader = person(world, 'uploader');
  const bytes = patternBytes(70_001);
  const id = (yield* reserve(world, uploader, bytes, { idempotencyKey: 'enrolment-1' })).mediaAssetRef.resourceId;
  expect((yield* putBytes(edge, uploader, id, bytes)).status).toBe(200);
  yield* world.replaceStoredObject(
    id,
    patternBytes(70_001).map((byte, index) => (index === 70_000 ? (byte + 1) % 256 : byte)),
  );
  return id;
});

/** Downloads the asset to its end: the transfer of a corrupt object never ends cleanly. */
const downloadCorrupt = (edge: Effect.Success<MediaE2eWorld['shell']>, reader: E2eActor, id: string) =>
  edge.open({ actor: reader, method: 'GET', path: `/core/media/assets/${id}/content` }).pipe(
    Effect.flatMap((response) =>
      Effect.exit(
        Effect.tryPromise({
          catch: () => 'transfer ended without a clean end' as const,
          try: async () => new Uint8Array(await response.arrayBuffer()),
        }),
      ),
    ),
  );

/** What an operator verifies: the principals bound to the key in the tenant, with their kind and status. */
const holdersOf = (world: MediaE2eWorld) =>
  world.admin
    .unsafe<{
      readonly binding_status: string;
      readonly bound_keys: string;
      readonly kind: string;
      readonly principal_status: string;
    }>(
      `select p.kind, p.status as principal_status, b.status as binding_status,
              (select string_agg(other.workload_key, ',' order by other.workload_key)
                 from core.access_workload_bindings other
                where other.tenant_id = p.tenant_id and other.principal_id = p.principal_id) as bound_keys
         from core.access_workload_bindings b
         join core.principals p on p.tenant_id = b.tenant_id and p.principal_id = b.principal_id
        where b.tenant_id = $1 and b.workload_key = $2
        order by p.principal_id`,
      [world.tenantId, WORKLOAD_KEY],
    )
    .pipe(Effect.orDie);

const unrecordedOf = (entries: readonly string[]) => entries.filter((entry) => entry.includes(UNRECORDED));

it.layer(templateDatabaseLayer, { excludeTestServices: true, timeout: '600 seconds' })(
  'Core Media end to end: the enrolment of the integrity workload principal (#1428)',
  (suite) => {
    suite.effect(
      'one active system principal bound to this key alone records proven corruption as failed, and nothing is logged as unrecorded',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* exactEnrolmentRecords() {
              const logs: string[] = [];
              yield* world.grant(person(world, 'uploader'), uploaderCapabilities);
              yield* world.grant(person(world, 'downloader'), readerCapabilities);
              const { principalId } = yield* world.bindSystemWorkload(WORKLOAD_KEY);
              // What the operator verifies: exactly one holder, a system principal, active, bound to this key only.
              expect(yield* holdersOf(world)).toEqual([
                { binding_status: 'active', bound_keys: WORKLOAD_KEY, kind: 'system', principal_status: 'active' },
              ]);
              expect(principalId).toMatch(/^[0-9a-f-]{36}$/u);
              const edge = yield* world.shellWithLogs((entry) => {
                logs.push(entry);
              });
              const id = yield* corruptReadyAsset(world, edge);

              expect(Exit.isFailure(yield* downloadCorrupt(edge, person(world, 'downloader'), id))).toBe(true);
              expect((yield* rowOf(world, id))?.processing_status).toBe('failed');
              expect(unrecordedOf(logs)).toEqual([]);
            }),
          ),
        ),
    );

    suite.effect(
      'a missing, service, disabled or revoked enrolment records nothing and is logged as unrecorded; the exact enrolment then records the same corruption',
      (ctx) =>
        withMediaE2eWorld(ctx, platform, (world) =>
          Effect.scoped(
            Effect.gen(function* lookAlikesRecordNothing() {
              const logs: string[] = [];
              const reader = person(world, 'downloader');
              yield* world.grant(person(world, 'uploader'), uploaderCapabilities);
              yield* world.grant(reader, readerCapabilities);
              const edge = yield* world.shellWithLogs((entry) => {
                logs.push(entry);
              });
              const id = yield* corruptReadyAsset(world, edge);

              const expectUnrecorded = Effect.fn('CoreMediaE2e.expectUnrecorded')(function* expectUnrecorded(
                expectedLogLines: number,
              ) {
                expect(Exit.isFailure(yield* downloadCorrupt(edge, reader, id))).toBe(true);
                // The client still saw the abort; the asset is untouched and the operator can read why.
                expect((yield* rowOf(world, id))?.processing_status).toBe('ready');
                const lines = unrecordedOf(logs);
                expect(lines).toHaveLength(expectedLogLines);
                expect(lines.at(-1)).toContain(DENIED);
              });

              // 1. Nothing enrolled.
              yield* expectUnrecorded(1);
              // 2. A principal that is not of kind `system`. A stage accounts file `workloads` entry binds an account (a person),
              //    which the resolver refuses the same way; a service principal stands for that non-system kind here.
              yield* world.enrolSystemWorkload(WORKLOAD_KEY, world.tenantId, { kind: 'service' });
              yield* expectUnrecorded(2);
              // 3. A system principal that is not active.
              yield* world.enrolSystemWorkload(WORKLOAD_KEY, world.tenantId, { status: 'disabled' });
              yield* expectUnrecorded(3);
              // 4. A system principal whose binding was revoked.
              const revoked = yield* world.enrolSystemWorkload(WORKLOAD_KEY, world.tenantId);
              yield* world.admin
                .unsafe(
                  `update core.access_workload_bindings set status = 'revoked', revoked_at = now()
                    where tenant_id = $1 and principal_id = $2`,
                  [world.tenantId, revoked.principalId],
                )
                .pipe(Effect.orDie);
              yield* expectUnrecorded(4);

              // The exact enrolment: the next download of the same asset records the same corruption.
              yield* world.enrolSystemWorkload(WORKLOAD_KEY, world.tenantId);
              expect(Exit.isFailure(yield* downloadCorrupt(edge, reader, id))).toBe(true);
              expect((yield* rowOf(world, id))?.processing_status).toBe('failed');
              expect(unrecordedOf(logs)).toHaveLength(4);
            }),
          ),
        ),
    );
  },
);
