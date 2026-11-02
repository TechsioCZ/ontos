#!/usr/bin/env node
/**
 * Fixed stage operator for the pseudonymous demo company: plan → reviewed apply → verify, in two phases.
 * `prepare` renames the company, installs the `sroubshop-storefront` service principal and grants, registers its
 * storefront application, creates the SROUB-* markets as exact copies (settings, every offer exception, associations)
 * and issues the new managed key into a private container-local handoff file (`pseudonymize-akros-key.sh` only).
 * `retire` removes the legacy associations, retires the AKROS-* markets and their pricing, retires the legacy
 * application and disables the old principal and its key. Never invoked by deployment or startup.
 * Runbook: scripts/demo/pseudonymize-akros-demo.md.
 */
import { homedir } from 'node:os';

import { NodeServices } from '@effect/platform-node';
import { v1 } from '@authzed/authzed-node';
import { reconcileStageServicePrincipals } from '@app/core-runtime/install/stage-context-bootstrap';
import {
  Config,
  ConfigProvider,
  Console,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
} from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
} from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import { ActiveApplicationCompositionSourceLive } from '../../packages/core-runtime/src/modules/active-application-composition-source.node.ts';
import { parseSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { PrincipalIdSchema } from '../../apps/shell-super-app/shared/api.ts';
import { discoverCurrentActions } from '../provision-current-action-authorization.mts';
import { ProcessDatabasePoolsLive } from '../zerops/process-database-pools.mts';
import { akrosDemoLegalEntityId, demoTenantId } from './fixture-ids.mts';
import { connectPseudonymShell } from './pseudonymize-akros-shell.mts';
import {
  deployedServiceSliceReady,
  keyHandoffDirectory,
  keyHandoffFile,
  legacyStorefrontMemberships,
  legacyStorefrontPrincipalId,
  pseudonymPrincipalId,
  pseudonymServiceRelationships,
  pseudonymStorefront,
} from './pseudonymize-akros-policy.mts';
import { prepareMarkets, retireLegacyCatalog } from './pseudonymize-akros-steps.mts';
import {
  assertPseudonymPrepared,
  fail,
  hasActivePseudonymKey,
  planCodec,
  encodePlan,
  pseudonymPlanFingerprint,
  pseudonymPlanMatches,
  readSnapshot,
  retirementGaps,
  validatePseudonymSnapshot,
} from './pseudonymize-akros-snapshot.mts';
import type { Plan, Snapshot } from './pseudonymize-akros-snapshot.mts';
import {
  readMissingServiceGrants,
  reconcileServiceGrants,
  stageServicePrincipals,
} from './reconcile-stage-service-grants.mts';
import { connectSeedClient, DemoSeedError } from './seed-client.mts';

const reason = 'Pseudonymizace ukázkové společnosti na ŠroubShop';
const modes = ['plan', 'apply', 'verify'] as const;
type Mode = (typeof modes)[number];
type Phase = Plan['phase'];

const connect = Effect.gen(function* connectOperator() {
  yield* Config.schema(Schema.Literal('stage'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
  const shell = yield* connectPseudonymShell;
  const password = yield* Config.Redacted('ONTOS_AGENT_SETUP_PASSWORD');
  const client = yield* Effect.acquireRelease(
    connectSeedClient(
      {
        legalEntityId: akrosDemoLegalEntityId,
        shellUrl: 'https://ontos-stage.web-revolution.cz',
        tenantId: demoTenantId,
      },
      'obchod@demo.ontos',
      password,
    ),
    (session) => session.signOut.pipe(Effect.ignore),
  );
  const composition = yield* (yield* ActiveApplicationCompositionService).load;
  const actions = yield* discoverCurrentActions(composition);
  return {
    client,
    compositionRevision: composition.composition.revision,
    desired: pseudonymServiceRelationships(actions),
    revoked: legacyStorefrontMemberships(actions),
    shell,
  };
});
type Operator = Effect.Success<typeof connect>;

/** Read-only preconditions of each phase; they hold for plan and apply (apply requires an identical state). */
const checkPhase = Effect.fn('Pseudonym.checkPhase')(function* checkPhase(phase: Phase, baseline: Snapshot) {
  yield* validatePseudonymSnapshot(baseline);
  if (phase === 'retire') {
    yield* assertPseudonymPrepared(baseline, baseline);
    if (!hasActivePseudonymKey(baseline)) {
      return yield* fail('The new storefront key is not active; finish the prepare phase first');
    }
    if (!deployedServiceSliceReady(stageServicePrincipals().map(({ principalId }) => principalId))) {
      return yield* fail('Deploy the permissions.mts storefront service slice before retiring the legacy principal');
    }
  }
  return baseline;
});

const openSpiceDb = Effect.gen(function* spiceDb() {
  const config = yield* Config.all({
    SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
    SPICEDB_ENDPOINT: Config.schema(Schema.Literal('spicedb:50051'), 'SPICEDB_ENDPOINT'),
    SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
  });
  const spice = yield* parseSpiceDbConfig({
    ...config,
    SPICEDB_PRESHARED_KEY: Redacted.value(config.SPICEDB_PRESHARED_KEY),
  });
  return yield* Effect.acquireRelease(
    Effect.try({ catch: () => fail('SpiceDB unavailable'), try: () => openSpiceDbGrpcRpc(spice, 10_000) }),
    (connection) => Effect.sync(() => connection.close()),
  );
});
type SpiceDb = Effect.Success<typeof openSpiceDb>;

/**
 * Creates the private handoff file BEFORE any mutation and before issuance, so a successful secret can never be lost
 * to a file error. An unwritten file is removed again on any failure.
 */
const openKeyHandoff = Effect.gen(function* keyHandoff() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(homedir(), keyHandoffDirectory);
  const target = path.join(directory, keyHandoffFile);
  yield* fs.makeDirectory(directory, { mode: 0o700, recursive: true });
  yield* fs.chmod(directory, 0o700);
  if (yield* fs.exists(target)) {
    return yield* fail(
      'A private key handoff file already exists; fetch it with the key wrapper before another issuance',
    );
  }
  let written = false;
  const file = yield* Effect.acquireRelease(fs.open(target, { flag: 'wx', mode: 0o600 }), () =>
    written ? Effect.void : fs.remove(target, { force: true }).pipe(Effect.ignore),
  );
  return {
    write: (secret: Redacted.Redacted) =>
      Effect.gen(function* writeKey() {
        yield* file.writeAll(new TextEncoder().encode(Redacted.value(secret)));
        yield* file.sync;
        written = true;
      }),
  };
});

const applyPrepare = Effect.fn('Pseudonym.applyPrepare')(function* applyPrepare(
  operator: Operator,
  rpc: SpiceDb,
  saved: Plan,
  fingerprint: string,
  issueKey: boolean,
) {
  const needsKey = !hasActivePseudonymKey(saved.baseline);
  if (needsKey !== issueKey) {
    return yield* fail(
      needsKey
        ? 'The new storefront key must be issued: run through scripts/demo/pseudonymize-akros-key.sh'
        : 'The new storefront key is already active; run without --issue-key',
    );
  }
  const handoff = needsKey ? yield* openKeyHandoff : undefined;
  yield* operator.shell.identity.configureDemoCompanies({
    headers: { 'idempotency-key': `pseudonym-company:${fingerprint}` },
    payload: { configuration: 'sales-rental-v1' },
  });
  yield* reconcileStageServicePrincipals(
    [
      {
        displayName: pseudonymStorefront,
        legalEntityId: akrosDemoLegalEntityId,
        principalId: pseudonymPrincipalId,
        tenantId: demoTenantId,
      },
    ],
    yield* ConfigProvider.ConfigProvider,
  );
  yield* reconcileServiceGrants(rpc, operator.desired, 'apply');
  yield* prepareMarkets(operator.client, saved.baseline, reason);
  if (handoff !== undefined) {
    const issued = yield* operator.shell.identity.issueManagedApiKey({
      headers: { 'idempotency-key': `pseudonym-key:${fingerprint}` },
      payload: {
        name: pseudonymStorefront,
        principalId: PrincipalIdSchema.make(pseudonymPrincipalId),
        scope: 'tenant-managed',
      },
    });
    yield* handoff.write(issued.secret);
    yield* Console.log('Managed key written to the private handoff file; value withheld');
  }
  return yield* Effect.void;
});

const verifyPrepared = Effect.fn('Pseudonym.verifyPrepared')(function* verifyPrepared(
  operator: Operator,
  rpc: SpiceDb,
  saved: Plan,
) {
  const after = yield* readSnapshot(operator.client, operator.shell);
  yield* assertPseudonymPrepared(saved.baseline, after);
  if (!hasActivePseudonymKey(after)) {
    return yield* fail('New managed key or principal not active');
  }
  if ((yield* readMissingServiceGrants(rpc, operator.desired)).length > 0) {
    return yield* fail('Storefront grants incomplete');
  }
  return yield* Effect.void;
});

const applyRetire = Effect.fn('Pseudonym.applyRetire')(function* applyRetire(
  operator: Operator,
  rpc: SpiceDb,
  saved: Plan,
) {
  yield* retireLegacyCatalog(operator.client, saved.baseline, reason);
  yield* rpc.writeRelationships(
    v1.WriteRelationshipsRequest.create({
      updates: operator.revoked.map((relationship) => ({
        operation: v1.RelationshipUpdate_Operation.DELETE,
        relationship,
      })),
    }),
  );
  for (const service of saved.baseline.services) {
    if (
      service.principalId === legacyStorefrontPrincipalId &&
      service.keyBindingId !== null &&
      service.keyStatus !== null
    ) {
      yield* operator.shell.identity.setManagedApiKeyStatus({
        headers: { 'idempotency-key': `pseudonym-revoke:${service.keyBindingId}` },
        payload: {
          authBindingId: service.keyBindingId,
          expectedStatus: service.keyStatus,
          newStatus: 'revoked',
          principalId: service.principalId,
          reason,
          scope: 'tenant-managed',
        },
      });
    }
  }
  if (
    saved.baseline.services.some(
      ({ principalId, principalStatus }) => principalId === legacyStorefrontPrincipalId && principalStatus === 'active',
    )
  ) {
    yield* operator.shell.identity.changePrincipalStatus({
      headers: { 'idempotency-key': 'pseudonym-disable-legacy-storefront-v1' },
      payload: {
        expectedStatus: 'active',
        newStatus: 'disabled',
        principalId: PrincipalIdSchema.make(legacyStorefrontPrincipalId),
        reason,
      },
    });
  }
});

const verifyRetired = Effect.fn('Pseudonym.verifyRetired')(function* verifyRetired(operator: Operator, saved: Plan) {
  const after = yield* readSnapshot(operator.client, operator.shell);
  yield* assertPseudonymPrepared(saved.baseline, after);
  const gaps = retirementGaps(after);
  if (gaps.length > 0) {
    return yield* fail(
      `Retirement incomplete (${gaps.join(', ')}); owner workers may still be pending. Run verify again, never re-apply blindly`,
    );
  }
  return yield* Effect.void;
});

const main = (mode: Mode, phase: Phase, planPath: string, reviewed: Option.Option<string>, issueKey: boolean) =>
  Effect.gen(function* run() {
    const operator = yield* connect;
    const baseline = yield* readSnapshot(operator.client, operator.shell);
    const current: Plan = {
      baseline,
      compositionRevision: operator.compositionRevision,
      desiredGrants: operator.desired.map((item) => v1.Relationship.toJsonString(item)),
      phase,
      revokedMemberships: operator.revoked.map((item) => v1.Relationship.toJsonString(item)),
      schemaVersion: 1,
    };
    const fs = yield* FileSystem.FileSystem;
    if (mode === 'plan') {
      yield* checkPhase(phase, baseline);
      yield* fs.writeFileString(planPath, yield* encodePlan(current), { flag: 'wx', mode: 0o600 });
      return yield* Console.log({
        fingerprint: yield* pseudonymPlanFingerprint(current),
        keyActive: hasActivePseudonymKey(baseline),
        markets: baseline.markets.map(({ lifecycle, marketCode }) => `${marketCode}:${lifecycle}`),
        mode,
        phase,
        planPath,
        revokedMemberships: operator.revoked.length,
        serviceGrants: operator.desired.length,
      });
    }
    const saved = yield* Schema.decodeUnknownEffect(planCodec)(yield* fs.readFileString(planPath));
    const fingerprint = yield* pseudonymPlanFingerprint(saved);
    if (
      saved.phase !== phase ||
      saved.compositionRevision !== operator.compositionRevision ||
      !Option.contains(reviewed, fingerprint)
    ) {
      return yield* fail('Exact reviewed plan, phase, fingerprint and deployed composition required');
    }
    const rpc = yield* openSpiceDb;
    if (mode === 'apply') {
      if (!(yield* pseudonymPlanMatches(saved, current, reviewed))) {
        return yield* fail('State changed since plan; review a fresh plan before any write');
      }
      yield* checkPhase(phase, baseline);
      yield* phase === 'prepare'
        ? applyPrepare(operator, rpc, saved, fingerprint, issueKey)
        : applyRetire(operator, rpc, saved);
    }
    yield* phase === 'prepare' ? verifyPrepared(operator, rpc, saved) : verifyRetired(operator, saved);
    return yield* Console.log({ fingerprint, mode, phase, verified: true });
  }).pipe(Effect.scoped);

const command = Command.make(
  'pseudonymize-akros-demo',
  {
    issueKey: Flag.Boolean('issue-key'),
    mode: Flag.Literals('mode', modes),
    phase: Flag.Literals('phase', ['prepare', 'retire']),
    plan: Flag.String('plan'),
    reviewed: Flag.String('reviewed-plan-sha256').pipe(Flag.optional),
  },
  ({ issueKey, mode, phase, plan, reviewed }) =>
    main(mode, phase, plan, reviewed, issueKey).pipe(
      Effect.tapError((failure) =>
        Console.error(
          Schema.is(DemoSeedError)(failure)
            ? failure.reason
            : 'Pseudonym migration stopped; credentials and provider details withheld. Review a fresh plan before retry.',
        ),
      ),
    ),
);

if (import.meta.main) {
  const services = ActiveApplicationCompositionConfigLive.pipe(
    Layer.provide(ActiveApplicationCompositionSourceLive),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(NodeServices.layer),
  );
  const exit = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(
      // Operator processes own their database pool registry like every Node host (Core pools are host-scoped).
      Effect.provide(ProcessDatabasePoolsLive),
      Effect.provide(services),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
