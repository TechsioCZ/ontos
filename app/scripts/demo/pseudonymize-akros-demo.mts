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
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import nodePath from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { v1 } from '@authzed/authzed-node';
import { ownerResourceModuleContainment } from '@app/core-runtime';
import { reconcileStageServicePrincipals } from '@app/core-runtime/install/stage-context-bootstrap';
import {
  Config,
  ConfigProvider,
  Console,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  Redacted,
  Schema,
} from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from 'effect/http';

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
  legacyStorefront,
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
  assertPseudonymReplacementActive,
  retirementStarted,
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
import type { SeedTarget, SeedWriteCheckpoint } from './seed-client.mts';
import { seedCheckpointDirectory, seedWriteCheckpoint } from './seed-checkpoint.mts';

const reason = 'Pseudonymizace ukázkové společnosti na ŠroubShop';
const modes = ['plan', 'apply', 'verify'] as const;
type Mode = (typeof modes)[number];
type Phase = Plan['phase'];

/** Fixed caller scope. A different origin/company/tenant must never obtain a new journal implicitly. */
export const pseudonymSeedTarget = {
  legalEntityId: akrosDemoLegalEntityId,
  shellUrl: 'https://ontos-stage.web-revolution.cz',
  tenantId: demoTenantId,
} as const;
const PseudonymTarget = Schema.Struct({
  legalEntityId: Schema.Literal(akrosDemoLegalEntityId),
  shellUrl: Schema.Literal(pseudonymSeedTarget.shellUrl),
  tenantId: Schema.Literal(demoTenantId),
});
const CheckpointContext = Schema.Struct({
  compositionRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  principalId: Schema.toEncoded(PrincipalIdSchema),
});
const writeHash = (audience: string, route: string, payload: string) =>
  createHash('sha256').update(`${audience}|${route}|${payload}`).digest('hex');
const checkpointFailure = () =>
  fail('P21 checkpoint refused: retain the journal and reconcile the exact pending request. No dispatch or retry.');

/** Uses only the native seed journal format. An empty hash-named directory is the pending barrier, not a second journal. */
export const makePseudonymWriteCheckpoint = (
  fs: FileSystem.FileSystem,
  root: string,
  target: SeedTarget = pseudonymSeedTarget,
) =>
  Effect.gen(function* pseudonymCheckpoint() {
    yield* Schema.decodeUnknownEffect(PseudonymTarget)(target).pipe(Effect.mapError(checkpointFailure));
    const directory = seedCheckpointDirectory(target, root);
    const pendingRoot = nodePath.join(directory, 'pending');
    yield* fs.makeDirectory(root, { mode: 0o700, recursive: true });
    yield* fs.chmod(root, 0o700);
    yield* fs.makeDirectory(directory, { mode: 0o700, recursive: true });
    yield* fs.chmod(directory, 0o700);
    yield* fs.makeDirectory(pendingRoot, { mode: 0o700, recursive: true });
    const nativeCheckpoint = seedWriteCheckpoint(fs, directory);
    let contextHash: string | undefined;
    let boundContext: typeof CheckpointContext.Type | undefined;
    const bindContext = (context: typeof CheckpointContext.Type) =>
      Effect.gen(function* bindAuthenticatedContext() {
        const checked = yield* Schema.decodeUnknownEffect(CheckpointContext)(context);
        const hash = writeHash(
          checked.principalId,
          checked.compositionRevision,
          `${target.shellUrl}|${target.tenantId}|${target.legalEntityId}`,
        );
        if (contextHash !== undefined && contextHash !== hash) {
          return yield* checkpointFailure();
        }
        contextHash = hash;
        boundContext = checked;
        return yield* Effect.void;
      }).pipe(Effect.mapError(checkpointFailure));
    const checkpoint: SeedWriteCheckpoint = (audience, route, payload) =>
      Effect.gen(function* saveNativeWriteIntent() {
        const hash = writeHash(audience, route, payload);
        if (contextHash === undefined) {
          return yield* checkpointFailure();
        }
        const marker = `${contextHash}-${hash}`;
        const pending = yield* fs.readDirectory(pendingRoot);
        if (pending.length > 1 || (pending.length === 1 && pending[0] !== marker)) {
          return yield* checkpointFailure();
        }
        if (pending.length === 0) {
          yield* fs.makeDirectory(nodePath.join(pendingRoot, marker), { mode: 0o700 });
        }
        return yield* nativeCheckpoint(audience, route, payload);
      }).pipe(Effect.mapError(checkpointFailure));
    const acknowledge = (hash: string) =>
      Effect.gen(function* acknowledgeNativeWrite() {
        const pending = yield* fs.readDirectory(pendingRoot);
        if (contextHash === undefined || pending.length !== 1 || pending[0] !== `${contextHash}-${hash}`) {
          return yield* checkpointFailure();
        }
        yield* fs.remove(nodePath.join(pendingRoot, `${contextHash}-${hash}`), { recursive: true });
        return yield* Effect.void;
      }).pipe(Effect.mapError(checkpointFailure));
    const assertComposition = (revision: string | undefined) =>
      revision !== undefined && revision === boundContext?.compositionRevision ? Effect.void : checkpointFailure();
    return { acknowledge, assertComposition, bindContext, checkpoint, context: () => boundContext, directory };
  }).pipe(Effect.mapError(checkpointFailure));
type PseudonymCheckpoint = Effect.Success<ReturnType<typeof makePseudonymWriteCheckpoint>>;
class PseudonymCheckpointService extends Context.Service<PseudonymCheckpointService, PseudonymCheckpoint>()(
  'PseudonymCheckpoint',
) {}

const shellAudience = 'shell-super-app';
const marketAudience = 'commerce-market-catalog';
const writeRoutes = [
  {
    actionKey: 'core.identity.configure-demo-companies',
    audience: shellAudience,
    route: '/auth/identity/demo-companies',
  },
  {
    actionKey: 'core.identity.bind-managed-api-key',
    audience: shellAudience,
    route: '/auth/identity/api-keys/managed',
  },
  {
    actionKey: 'core.identity.set-managed-api-key-binding-status',
    audience: shellAudience,
    route: '/auth/identity/api-keys/managed/status',
  },
  {
    actionKey: 'core.identity.change-principal-status',
    audience: shellAudience,
    route: '/auth/identity/principal-status',
  },
  {
    actionKey: 'commerce.storefront-registry.register-storefront-application',
    audience: 'storefront-registry',
    route: '/storefront-registry/actions/register-storefront-application',
  },
  {
    actionKey: 'commerce.storefront-registry.revise-storefront-application',
    audience: 'storefront-registry',
    route: '/storefront-registry/actions/revise-storefront-application',
  },
  {
    actionKey: 'commerce.market-catalog.create-market',
    audience: marketAudience,
    route: '/commerce-market-catalog/actions/create-market',
  },
  {
    actionKey: 'commerce.market-catalog.associate-storefront',
    audience: marketAudience,
    route: '/commerce-market-catalog/actions/associate-storefront',
  },
  {
    actionKey: 'commerce.market-catalog.remove-storefront-association',
    audience: marketAudience,
    route: '/commerce-market-catalog/actions/remove-storefront-association',
  },
  {
    actionKey: 'commerce.market-catalog.retire-market',
    audience: marketAudience,
    route: '/commerce-market-catalog/actions/retire-market',
  },
  { actionKey: 'demo.merchandise.apply-command', audience: 'merchandise', route: '/merchandise/actions/apply-command' },
] as const;

/** Fixed action identity only; never print an HTTP error, payload, URL, header, response body or managed key. */
export const pseudonymWriteDiagnostic = (
  identity: {
    actionKey: string;
    compositionRevision?: string;
    journalFile: string;
    principalId?: string;
    requestHash: string;
  },
  step: string,
  status: number | null,
) => ({
  actionKey: identity.actionKey,
  compositionRevision: identity.compositionRevision,
  journalFile: identity.journalFile,
  principalId: identity.principalId,
  requestHash: identity.requestHash,
  status,
  step,
});

/** Also journals generated Shell Action clients, which do not go through SeedClient.call. */
export const pseudonymCheckpointHttpClient = (
  http: HttpClient.HttpClient,
  journal: PseudonymCheckpoint,
): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.gen(function* dispatchJournaledPseudonymWrite() {
      const url = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(request.url);
      const identity = writeRoutes.find((candidate) =>
        candidate.audience === shellAudience
          ? url.pathname === `/shell-super-app-api${candidate.route}`
          : url.pathname.endsWith(candidate.route) &&
            url.pathname.startsWith(`/shell-super-app-api/module-api/${candidate.audience}/`),
      );
      if (request.headers['idempotency-key'] === undefined && identity === undefined) {
        return yield* http.execute(request);
      }
      if (
        url.origin !== pseudonymSeedTarget.shellUrl ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        request.urlParams.params.length > 0 ||
        Option.isSome(request.hash) ||
        identity === undefined ||
        request.method !== 'POST'
      ) {
        return yield* checkpointFailure();
      }
      if (identity.audience !== shellAudience) {
        yield* journal.assertComposition(request.headers['x-ontos-composition-revision']);
      }
      const body = yield* Match.value(request.body).pipe(
        Match.tag('Uint8Array', (value) => Effect.succeed(value.body)),
        Match.orElse(checkpointFailure),
      );
      const payload = new TextDecoder().decode(body);
      const hash = writeHash(identity.audience, identity.route, payload);
      const journalFile = nodePath.join(journal.directory, 'writes', `${hash}.json`);
      const diagnostic = { ...journal.context(), actionKey: identity.actionKey, journalFile, requestHash: hash };
      const key = yield* journal
        .checkpoint(identity.audience, identity.route, payload)
        .pipe(Effect.tapError(() => Console.error(pseudonymWriteDiagnostic(diagnostic, 'checkpoint-refused', null))));
      yield* Console.log(pseudonymWriteDiagnostic(diagnostic, 'dispatch', null));
      const response = yield* http.execute(HttpClientRequest.setHeader(request, 'idempotency-key', key)).pipe(
        Effect.tapError(() => Console.error(pseudonymWriteDiagnostic(diagnostic, 'transport-failed', null))),
        Effect.onInterrupt(() => Console.error(pseudonymWriteDiagnostic(diagnostic, 'dispatch-interrupted', null))),
      );
      yield* response.status >= 200 && response.status < 300
        ? journal
            .acknowledge(hash)
            .pipe(
              Effect.tapError(() =>
                Console.error(pseudonymWriteDiagnostic(diagnostic, 'acknowledgement-failed', response.status)),
              ),
            )
        : Console.error(pseudonymWriteDiagnostic(diagnostic, 'http-rejected', response.status));
      return response;
    }).pipe(
      Effect.mapError((cause) =>
        HttpClientError.isHttpClientError(cause)
          ? cause
          : new HttpClientError.HttpClientError({
              reason: new HttpClientError.EncodeError({
                cause,
                description:
                  'P21 durable checkpoint failed; retain the native journal and reconcile. No automatic retry.',
                request,
              }),
            }),
      ),
    ),
  );

export const connectPseudonymSeedClient = (checkpoint: SeedWriteCheckpoint) =>
  Effect.gen(function* connectPseudonymSeed() {
    const password = yield* Config.Redacted('ONTOS_AGENT_SETUP_PASSWORD');
    return yield* Effect.acquireRelease(
      connectSeedClient(pseudonymSeedTarget, 'obchod@demo.ontos', password, checkpoint),
      (session) => session.signOut.pipe(Effect.ignore),
    );
  });

const connect = (journal: PseudonymCheckpoint) =>
  Effect.gen(function* connectOperator() {
    yield* Config.schema(Schema.Literal('stage'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
    const shell = yield* connectPseudonymShell;
    const client = yield* connectPseudonymSeedClient(journal.checkpoint);
    const composition = yield* (yield* ActiveApplicationCompositionService).load;
    const session = yield* shell.authentication.currentSession({});
    if (
      session.state !== 'authenticated' ||
      session.identity.tenantId !== demoTenantId ||
      session.identity.legalEntityId !== akrosDemoLegalEntityId
    ) {
      return yield* checkpointFailure();
    }
    yield* journal.bindContext({
      compositionRevision: composition.composition.revision,
      principalId: session.identity.principalId,
    });
    const actions = yield* discoverCurrentActions(composition);
    return {
      client,
      compositionRevision: composition.composition.revision,
      desired: pseudonymServiceRelationships(actions),
      revoked: legacyStorefrontMemberships(actions),
      shell,
    };
  });
type Operator = Effect.Success<ReturnType<typeof connect>>;
/** Read-only preconditions of each phase; they hold for plan and apply (apply requires an identical state). */
const checkPhase = Effect.fn('Pseudonym.checkPhase')(function* checkPhase(phase: Phase, baseline: Snapshot) {
  const resumedRetire = phase === 'retire' && retirementStarted(baseline);
  yield* resumedRetire ? assertPseudonymReplacementActive(baseline) : validatePseudonymSnapshot(baseline);
  if (phase === 'retire') {
    if (!resumedRetire) {
      yield* assertPseudonymPrepared(baseline, baseline);
    }
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
  // The old principal loses access first (the shop already runs on the new key, verified before this phase).
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
  // Registry writes authorize on the application's own resource; the legacy application never had that module
  // containment (only its app-id alias did), so it is installed before the application retires.
  const legacyApplication = saved.baseline.applications.find(
    ({ lifecycle, storefrontAppId }) => storefrontAppId === legacyStorefront && lifecycle !== 'RETIRED',
  );
  const containment =
    legacyApplication === undefined
      ? undefined
      : ownerResourceModuleContainment(
          demoTenantId,
          akrosDemoLegalEntityId,
          legacyApplication.storefrontApplicationRef,
        );
  if (containment !== undefined) {
    yield* rpc.writeRelationships(
      v1.WriteRelationshipsRequest.create({
        updates: [
          {
            operation: v1.RelationshipUpdate_Operation.TOUCH,
            relationship: v1.Relationship.create({
              relation: containment.relation,
              resource: containment.resource,
              subject: { object: containment.container, optionalRelation: '' },
            }),
          },
        ],
      }),
    );
  }
  yield* retireLegacyCatalog(operator.client, saved.baseline, reason);
});

const verifyRetired = Effect.fn('Pseudonym.verifyRetired')(function* verifyRetired(operator: Operator, saved: Plan) {
  const after = yield* readSnapshot(operator.client, operator.shell);
  yield* retirementStarted(saved.baseline)
    ? assertPseudonymReplacementActive(after)
    : assertPseudonymPrepared(saved.baseline, after);
  const gaps = retirementGaps(after);
  if (gaps.length > 0) {
    return yield* fail(
      `Retirement incomplete (${gaps.join(', ')}); owner workers may still be pending. Run verify again, never re-apply blindly`,
    );
  }
  return yield* Effect.void;
});

const run = (
  mode: Mode,
  phase: Phase,
  planPath: string,
  reviewed: Option.Option<string>,
  issueKey: boolean,
  journal: PseudonymCheckpoint,
) =>
  Effect.gen(function* executePseudonym() {
    const operator = yield* connect(journal);
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

const command = (journal: PseudonymCheckpoint) =>
  Command.make(
    'pseudonymize-akros-demo',
    {
      issueKey: Flag.Boolean('issue-key').pipe(Flag.withDefault(false)),
      mode: Flag.Literals('mode', modes),
      phase: Flag.Literals('phase', ['prepare', 'retire']),
      plan: Flag.String('plan'),
      reviewed: Flag.String('reviewed-plan-sha256').pipe(Flag.optional),
    },
    ({ issueKey, mode, phase, plan, reviewed }) =>
      run(mode, phase, plan, reviewed, issueKey, journal).pipe(
        Effect.tapError((failure) =>
          Console.error(
            [
              'Pseudonym migration stopped',
              Schema.is(DemoSeedError)(failure) ? ` (${failure.reason})` : '',
              '; retain the pending native seed journal and reconcile before any explicit resume. No automatic retry.',
            ].join(''),
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
  const checkpointLive = Layer.effect(
    PseudonymCheckpointService,
    Effect.gen(function* checkpointRuntime() {
      const fs = yield* FileSystem.FileSystem;
      return yield* makePseudonymWriteCheckpoint(
        fs,
        nodePath.join(homedir(), '.ontos-operator-checkpoints', 'pseudonymize-akros-demo'),
      );
    }),
  );
  const journaledHttp = Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* journaledTransport() {
      const http = yield* HttpClient.HttpClient;
      const journal = yield* PseudonymCheckpointService;
      return pseudonymCheckpointHttpClient(http, journal);
    }),
  );
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* operatorRuntime() {
      return yield* Command.run(command(yield* PseudonymCheckpointService), { version: '1.0.0' });
    }).pipe(
      Effect.provide(journaledHttp),
      Effect.provide(checkpointLive),
      // Operator processes own their database pool registry like every Node host (Core pools are host-scoped).
      Effect.provide(ProcessDatabasePoolsLive),
      Effect.provide(services),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
