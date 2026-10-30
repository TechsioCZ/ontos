import { consumePurchaseApprovalAction } from '../../src/actions/consume-purchase-approval.action.ts';
import { orderCommitmentApprovalEvidenceRead } from '../../src/api/order-commitment-approval-evidence.read.ts';
import { OrderCommitmentApprovalEvidenceRequestSchema } from '../../shared/apis/order-commitment-approval-evidence.ts';
import type { OrderCommitmentApprovalEvidenceRequest } from '../../shared/apis/order-commitment-approval-evidence.ts';
import { submitPurchaseApprovalRequestAction } from '../../src/actions/submit-purchase-approval-request.action.ts';
import { purchasingApprovalWorkflowForScope } from '../../src/persistence/purchasing-approval-persistence.ts';
import {
  PurchaseApprovalCurrentnessFactory,
  PurchaseApprovalFinalBindingAuthority,
} from '../../shared/domain/purchase-approval-currentness-port.ts';
import { PurchaseLimitEvaluationCurrentnessPort } from '../../shared/domain/purchase-limit-evaluation-currentness-port.ts';
import { PurchaseLimitEvaluationSourceFactory } from '../../shared/domain/purchase-limit-evaluation.ts';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import type { PurchaseApprovalFinalBindingAuthorityService } from '../../shared/domain/purchase-approval-currentness-port.ts';
import {
  ConsumePurchaseApprovalInputSchema,
  PurchaseApprovalFinalBindingSchema,
  PurchaseProposalRevisionSchema,
  PurchasingApprovalRejected,
  RevalidatePurchaseApprovalInputSchema,
  TrustedRevalidatePurchaseApprovalInputSchema,
} from '../../shared/domain/purchasing-approval.ts';
import type {
  ConsumePurchaseApprovalInput,
  PurchaseApprovalRequest,
  RevalidatePurchaseApprovalInput,
  TrustedRevalidatePurchaseApprovalInput,
} from '../../shared/domain/purchasing-approval.ts';

import { revalidatePurchaseApprovalAction } from '../../src/actions/revalidate-purchase-approval.action.ts';
import { enrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';
import { makePurchasingApprovalNativeFixture } from '../support/purchasing-approval-native.ts';

import { createHash, randomUUID } from 'node:crypto';
import {
  ActionPermissionCheckError,
  ActionRuntime,
  ContextAccess,
  ReadHandlerExecutionError,
  ReadHandlerNotFound,
  ReadPolicyDenied,
  ReadRuntime,
  loadDatabaseConnectionPair,
} from '@app/core-runtime';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { PgClient } from '@effect/sql-pg';
import { and, eq, sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import {
  Config,
  Context,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Redacted,
  Result,
  Schema,
  Stream,
} from 'effect';
import { ChildProcess } from 'effect/process';
import { Reactivity } from 'effect/reactivity';
import { assert, expect, it } from 'effect-rstest';
import {
  approvalRevalidations,
  commerceCustomerContextRelations,
  purchaseApprovalRequests,
} from '../../src/database/schema.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

const oldClockDefinition = (current: string): string => {
  const old = current
    .replace('  v_now timestamptz;', '  v_now timestamptz := clock_timestamp();')
    .replace(
      '    -- #1257 replay eligibility linearizes after the request lock and current owner reads.\n    v_now := clock_timestamp();\n',
      '',
    )
    .replace(
      '  -- #1257 issuance eligibility linearizes after all existing owner row acquisitions.\n  v_now := clock_timestamp();\n',
      '',
    )
    .replace(
      "  -- #1257 checkedAt and every effective interval use the same post-lock eligibility instant.\n  -- checkedAt/validUntil are owner evidence supplied by the caller, but the routine's\n  -- server clock is authoritative for accepting and replaying that evidence.",
      "  -- checkedAt/validUntil are owner evidence supplied by the caller, but the routine's\n  -- server clock is authoritative for accepting and replaying that evidence.\n  v_now := clock_timestamp();",
    );
  expect(createHash('sha256').update(old).digest('hex')).toBe(
    'c93218f30b0b21ee3e82decfdffa125602eabd5052d7980ade7a9fe8dd4f9933',
  );
  return old;
};
const ClockMigrationStateSchema = Schema.Literals(['CURRENT', 'OLD_CLOCK']);
type ClockMigrationState = typeof ClockMigrationStateSchema.Type;

// Finite TEST owner windows leave scheduling headroom; every expiry check still crosses the stored boundary.
const initialObservationSeconds = 5;
const extendedObservationSeconds = 15;

const databaseUsernameArgument = '--username';

interface MigrationConnection {
  readonly connectionString: string;
  readonly database: string;
  readonly user: string;
}
interface ApprovalFreshMigrationConnections {
  readonly admin: MigrationConnection;
  readonly runtime: MigrationConnection;
}
const MigrationReceiptSchema = Schema.Struct({
  count: Schema.Int,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
});
const approvalFreshJournalReceipt = Effect.fn('ApprovalFreshProofTests.journalReceipt')(function* receipt(
  connection: MigrationConnection,
  owner: 'core' | 'commerce_customer_context',
) {
  const table =
    owner === 'core' ? 'drizzle.__drizzle_migrations_core' : 'drizzle.__drizzle_migrations_commerce_customer_context';
  const child = yield* ChildProcess.make(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'PGPASSWORD',
      'ontos-db',
      'psql',
      '--host',
      'localhost',
      databaseUsernameArgument,
      connection.user,
      '--dbname',
      connection.database,
      '--tuples-only',
      '--no-align',
      '--quiet',
      '--command',
      `set time zone 'UTC'; select json_build_object('count', count(*)::integer, 'digest', md5(coalesce(jsonb_agg(to_jsonb(journal) order by to_jsonb(journal)::text)::text,'[]'))) from ${table} journal`,
    ],
    {
      env: {
        PATH: yield* Config.String('PATH'),
        PGPASSWORD: decodeURIComponent(new URL(connection.connectionString).password),
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [status, output] = yield* Effect.all(
    [child.exitCode, child.stdout.pipe(Stream.decodeText(), Stream.runCollect), Stream.runDrain(child.stderr)],
    { concurrency: 3 },
  );
  expect(Number(status)).toBe(0);
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MigrationReceiptSchema))(output.join('').trim());
});
const copyApprovalFreshMigrationJournal = Effect.fn('ApprovalFreshProofTests.copyMigrationJournal')(function* copy(
  source: MigrationConnection,
  target: MigrationConnection,
  owner: 'core' | 'commerce_customer_context',
) {
  const before = yield* approvalFreshJournalReceipt(source, owner);
  expect((yield* approvalFreshJournalReceipt(target, owner)).count).toBe(0);
  const table =
    owner === 'core' ? 'drizzle.__drizzle_migrations_core' : 'drizzle.__drizzle_migrations_commerce_customer_context';
  const dump = yield* ChildProcess.make(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'PGPASSWORD',
      'ontos-db',
      'pg_dump',
      '--host',
      'localhost',
      databaseUsernameArgument,
      source.user,
      '--dbname',
      source.database,
      '--data-only',
      '--column-inserts',
      '--table',
      table,
    ],
    {
      env: {
        PATH: yield* Config.String('PATH'),
        PGPASSWORD: decodeURIComponent(new URL(source.connectionString).password),
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const restore = yield* ChildProcess.make(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'PGPASSWORD',
      'ontos-db',
      'psql',
      '--host',
      'localhost',
      databaseUsernameArgument,
      target.user,
      '--dbname',
      target.database,
      '--set',
      'ON_ERROR_STOP=1',
      '--quiet',
    ],
    {
      env: {
        PATH: yield* Config.String('PATH'),
        PGPASSWORD: decodeURIComponent(new URL(target.connectionString).password),
      },
      stderr: 'pipe',
      stdin: dump.stdout,
      stdout: 'pipe',
    },
  );
  const [dumpExit, restoreExit] = yield* Effect.all(
    [
      dump.exitCode,
      restore.exitCode,
      Stream.runDrain(dump.stderr),
      Stream.runDrain(restore.stderr),
      Stream.runDrain(restore.stdout),
    ],
    { concurrency: 5 },
  );
  expect(Number(dumpExit)).toBe(0);
  expect(Number(restoreExit)).toBe(0);
  expect(yield* approvalFreshJournalReceipt(target, owner)).toEqual(before);
  expect(yield* approvalFreshJournalReceipt(source, owner)).toEqual(before);
});
const runApprovalFreshMigrationCommand = Effect.fn('ApprovalFreshProofTests.migrationCommand')(function* run(
  connections: ApprovalFreshMigrationConnections,
  owner: 'core' | 'commerce_customer_context',
  command: 'migrate' | 'verify',
  migrationsDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-approvalFresh-profile-current-' });
  const configuration = path.join(directory, 'drizzle.config.mjs');
  yield* fs.writeFileString(
    configuration,
    "export default { dialect:'postgresql', out:process.env.ONTOS_QUANTITY_MIGRATIONS, schema:process.env.ONTOS_QUANTITY_SCHEMA, dbCredentials:{url:process.env.DATABASE_ADMIN_URL}, migrations:{schema:'drizzle',table:'__drizzle_migrations_commerce_customer_context'} };",
  );
  const args =
    owner === 'core'
      ? ['--filter', '@app/core-runtime', command === 'migrate' ? 'db:migrate' : 'db:verify']
      : [
          '--filter',
          '@app/commerce-customer-context',
          ...(command === 'migrate' ? ['exec', 'drizzle-kit', 'migrate', '--config', configuration] : ['db:verify']),
        ];
  const child = yield* ChildProcess.make('mise', ['exec', '--', 'pnpm', ...args], {
    cwd: new URL('../../../../', import.meta.url).pathname,
    env: {
      APP_ENV_PATH: '/dev/null',
      DATABASE_ADMIN_URL: connections.admin.connectionString,
      DATABASE_URL: connections.runtime.connectionString,
      ONTOS_QUANTITY_MIGRATIONS: migrationsDirectory,
      ONTOS_QUANTITY_SCHEMA: new URL('../../src/database/schema.ts', import.meta.url).pathname,
    },
    extendEnv: true,
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const [status, stderr] = yield* Effect.all(
    [child.exitCode, child.stderr.pipe(Stream.decodeText(), Stream.mkString), Stream.runDrain(child.stdout)],
    {
      concurrency: 3,
    },
  );
  if (Number(status) !== 0) {
    yield* Effect.logError({
      diagnostic: stderr.slice(-2500),
      failureClass: 'OWNED_MIGRATION_COMMAND_FAILED',
      operation: command,
      owner,
    });
  }
  expect(Number(status)).toBe(0);
});
const applyApprovalFreshProfileCurrentMigrations = Effect.fn('ApprovalFreshProofTests.currentMigrations')(
  function* migrate(connections: ApprovalFreshMigrationConnections, state: ClockMigrationState) {
    const source = yield* loadDatabaseConnectionPair();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const currentDirectory = new URL('../../drizzle/', import.meta.url).pathname;
    const currentSql = yield* fs.readFileString(
      path.join(currentDirectory, '20261020081653_purchase_approval_fresh_proof/migration.sql'),
    );
    const sqlSource = state === 'OLD_CLOCK' ? oldClockDefinition(currentSql) : currentSql;
    const migrationsDirectory = currentDirectory;
    expect(connections.admin.database).toBe(connections.runtime.database);
    expect(connections.admin.database.startsWith('ontos_test_party_gateway_')).toBe(true);
    expect(connections.admin.database).not.toBe(source.admin.database);
    expect(connections.admin.database).not.toBe(source.runtime.database);
    const sourceCore = yield* approvalFreshJournalReceipt(source.admin, 'core');
    const sourceOwner = yield* approvalFreshJournalReceipt(source.admin, 'commerce_customer_context');
    // Finalizers are installed before any copy/migration, including failures during setup.
    yield* Effect.addFinalizer(() =>
      Effect.scoped(
        Effect.gen(function* sourceJournalsUnchanged() {
          expect(yield* approvalFreshJournalReceipt(source.admin, 'core')).toEqual(sourceCore);
          expect(yield* approvalFreshJournalReceipt(source.admin, 'commerce_customer_context')).toEqual(sourceOwner);
        }),
      ).pipe(Effect.orDie),
    );
    yield* copyApprovalFreshMigrationJournal(source.admin, connections.admin, 'core');
    yield* copyApprovalFreshMigrationJournal(source.admin, connections.admin, 'commerce_customer_context');
    yield* runApprovalFreshMigrationCommand(connections, 'core', 'migrate', migrationsDirectory);
    yield* runApprovalFreshMigrationCommand(connections, 'core', 'verify', migrationsDirectory);
    const currentCore = yield* approvalFreshJournalReceipt(connections.admin, 'core');
    yield* runApprovalFreshMigrationCommand(connections, 'core', 'migrate', migrationsDirectory);
    expect(yield* approvalFreshJournalReceipt(connections.admin, 'core')).toEqual(currentCore);
    yield* runApprovalFreshMigrationCommand(connections, 'commerce_customer_context', 'migrate', migrationsDirectory);
    yield* runApprovalFreshMigrationCommand(connections, 'commerce_customer_context', 'verify', migrationsDirectory);
    const currentOwner = yield* approvalFreshJournalReceipt(connections.admin, 'commerce_customer_context');
    yield* runApprovalFreshMigrationCommand(connections, 'commerce_customer_context', 'migrate', migrationsDirectory);
    expect(yield* approvalFreshJournalReceipt(connections.admin, 'commerce_customer_context')).toEqual(currentOwner);
    expect(yield* approvalFreshJournalReceipt(connections.admin, 'core')).toEqual(currentCore);

    const client = yield* PgClient.make({ url: Redacted.make(connections.admin.connectionString) }).pipe(
      Effect.provide(Reactivity.layer),
    );
    const admin = yield* makeWithDefaults({ relations: commerceCustomerContextRelations }).pipe(
      Effect.provideService(PgClient.PgClient, client),
    );
    if (state === 'OLD_CLOCK') {
      // Explicit component preimage control on the disposable clone only. The
      // source may already contain this migration and later migrations. Retain
      // their genuine journal receipts; install the checksum-pinned old routine
      // bodies separately instead of claiming an old migration was rerun.
      for (const definition of sqlSource.split('CREATE OR REPLACE FUNCTION').slice(1)) {
        yield* admin.execute(sql.raw(`CREATE OR REPLACE FUNCTION${definition}`), 'objects');
      }
    }
    const definitions = sqlSource.split('CREATE OR REPLACE FUNCTION').slice(1);
    expect(definitions).toHaveLength(2);
    for (const name of ['revalidate_purchase_approval', 'consume_purchase_approval']) {
      const definition = definitions.find((value) => value.startsWith(` "commerce_customer_context"."${name}"(`));
      assert.isOk(definition !== undefined);
      const [, suffix] = definition.split('AS $$');
      const [expectedBody] = suffix?.split('$$;') ?? [];
      assert.isOk(expectedBody !== undefined);
      const [row] = yield* admin.execute<{
        readonly body: string;
        readonly canonicalPath: boolean;
        readonly currentReceipt: boolean;
        readonly ownerIsAdmin: boolean;
        readonly publicExecute: boolean;
        readonly rowSecurity: boolean;
        readonly runtimeExecute: boolean;
        readonly securityDefiner: boolean;
      }>(
        sql`select routine.prosrc as body,
        'search_path=pg_catalog, commerce_customer_context, pg_temp'=any(routine.proconfig) as "canonicalPath",
        'row_security=on'=any(routine.proconfig) as "rowSecurity",
        routine.prosecdef as "securityDefiner", pg_get_userbyid(routine.proowner)=current_user as "ownerIsAdmin",
        has_function_privilege('ontos_runtime',routine.oid,'EXECUTE') as "runtimeExecute",
        exists(select 1 from aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) acl
          where acl.grantee=0 and acl.privilege_type='EXECUTE') as "publicExecute",
        exists(select 1 from drizzle.__drizzle_migrations_commerce_customer_context
          where created_at=${Date.UTC(2026, 9, 20, 8, 16, 53)} and name='20261020081653_purchase_approval_fresh_proof'
          and hash=${createHash('sha256').update(currentSql).digest('hex')}) as "currentReceipt"
        from pg_catalog.pg_proc routine join pg_catalog.pg_namespace namespace on namespace.oid=routine.pronamespace
        where namespace.nspname='commerce_customer_context' and routine.proname=${name}`,
        'objects',
      );
      const verified = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          body: Schema.String,
          canonicalPath: Schema.Literal(true),
          currentReceipt: Schema.Literal(true),
          ownerIsAdmin: Schema.Literal(true),
          publicExecute: Schema.Literal(false),
          rowSecurity: Schema.Literal(true),
          runtimeExecute: Schema.Literal(true),
          securityDefiner: Schema.Literal(true),
        }),
      )(row);
      expect(verified.body.trim()).toBe(expectedBody.trim());
    }
    expect(yield* approvalFreshJournalReceipt(source.admin, 'core')).toEqual(sourceCore);
    expect(yield* approvalFreshJournalReceipt(source.admin, 'commerce_customer_context')).toEqual(sourceOwner);
    return { commerceCustomerContext: currentOwner, core: currentCore };
  },
);

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

const authorityUnavailable = (cause: unknown): PurchasingApprovalRejected => {
  const failure = new PurchasingApprovalRejected({
    code: 'CURRENT_STATE_INDETERMINATE',
    reason: 'The exact TEST authority observation is unavailable',
    retryable: true,
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

type ApprovalNativeOwner = Effect.Success<ReturnType<typeof makePurchasingApprovalNativeFixture>>;

const actualCurrentReplayFrame = (
  owner: ApprovalNativeOwner,
  context: ApprovalNativeOwner['runtimeContext'],
  request: PurchaseApprovalRequest,
  claimed: RevalidatePurchaseApprovalInput,
) =>
  owner.fixture
    .prepareOwner(
      (transaction, scope) =>
        Effect.gen(function* actualScopedCurrentnessFrame() {
          const trusted = {
            ...scope,
            legalEntityId: owner.legalEntityId,
            trustedStorefrontId: request.proposal.context.storefrontId,
          };
          const evaluationSource = yield* Context.get(context, PurchaseLimitEvaluationSourceFactory).make(
            transaction,
            trusted,
          );
          const currentness = Context.get(context, PurchaseApprovalCurrentnessFactory).make(
            transaction,
            trusted,
            Context.get(context, ContextAccess),
            Context.get(context, PurchaseLimitEvaluationCurrentnessPort),
            evaluationSource,
          );
          return yield* currentness.resolveRevalidation({
            claimed,
            scope: {
              legalEntityId: owner.legalEntityId,
              principalId: scope.principalId,
              storefrontId: owner.storefrontId,
              tenantId: owner.tenantId,
            },
          });
        }),
      'required',
    )
    .pipe(Effect.provideContext(context));

/** These exact final identities/state are TEST facts only, never a real Order owner producer. */
const scenario = Effect.fn('ApprovalFreshProofTests.scenario')(function* scenario(
  state: ClockMigrationState = 'CURRENT',
  requestTtlMilliseconds = 60_000,
  apiKeyManager = false,
  hierarchyTtlMilliseconds?: number,
) {
  const snapshot = yield* enrollmentApplicationCompositionSnapshot;
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: snapshot,
    // Core's db:verify below checks the trust catalog against the provisioned gateway audiences.
    databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
    mode: 'schema-only',
    purpose: 'stabilization-1257-approval-fresh-proof',
    sourceConnections: yield* loadDatabaseConnectionPair(),
  });
  yield* isolated.assertClonedSchema();
  yield* applyApprovalFreshProfileCurrentMigrations(isolated.connections, state);
  const owner = yield* makePurchasingApprovalNativeFixture({
    apiKeyManager,
    connections: isolated.connections,
    finalProofTest: true,
    snapshot,
  });
  const chain = yield* owner.createRequest({ hierarchyTtlMilliseconds, ttlMilliseconds: requestTtlMilliseconds });
  const approved = yield* chain.decide();
  expect(approved.request.status).toBe('APPROVED');
  const binding = yield* Schema.decodeUnknownEffect(PurchaseApprovalFinalBindingSchema)({
    attemptRef: {
      moduleId: 'test.approval-final-owner',
      resourceId: randomUUID(),
      resourceType: 'test.approval-final-owner.attempt',
      tenantId: owner.tenantId,
    },
    bundleHash: 'd'.repeat(64),
    bundleRef: {
      moduleId: 'test.approval-final-owner',
      resourceId: randomUUID(),
      resourceType: 'test.approval-final-owner.bundle',
      tenantId: owner.tenantId,
    },
    bundleVersion: 'TEST_APPROVAL_FINAL_BUNDLE.v1',
  });
  const correlation = randomUUID();
  let eligible = true;
  let observationSeconds: typeof initialObservationSeconds | typeof extendedObservationSeconds =
    initialObservationSeconds;
  let authorityEntries = 0;
  let pause: { readonly entered: Deferred.Deferred<boolean>; readonly release: Deferred.Deferred<boolean> } | null =
    null;
  const authority: PurchaseApprovalFinalBindingAuthorityService = {
    verifyConsumption: () =>
      Effect.fail(
        new PurchasingApprovalRejected({
          code: 'CURRENT_STATE_INDETERMINATE',
          reason: 'No actual committed Order producer is configured in this TEST',
          retryable: true,
        }),
      ),
    verifyRevalidation: ({ binding: claim, claimed, request, scope }) =>
      Effect.gen(function* exactTestFinalAuthority() {
        if (
          !eligible ||
          JSON.stringify(claim) !== JSON.stringify(binding) ||
          request.requestRef.resourceId !== approved.request.requestRef.resourceId ||
          request.requestRevision !== approved.request.requestRevision ||
          request.proposal.canonicalHash !== chain.proposal.canonicalHash ||
          claimed.commitmentCorrelationId !== correlation ||
          scope.tenantId !== owner.tenantId ||
          scope.legalEntityId !== owner.legalEntityId ||
          scope.storefrontId !== owner.storefrontId ||
          scope.principalId !== owner.principal.principalId
        ) {
          return yield* Effect.fail(
            new PurchasingApprovalRejected({
              code: 'CURRENT_STATE_INDETERMINATE',
              reason: 'TEST exact final authority denies unknown, changed or ineligible Attempt',
              retryable: true,
            }),
          );
        }
        authorityEntries += 1;
        if (pause !== null) {
          yield* Deferred.succeed(pause.entered, true);
          yield* Deferred.await(pause.release);
        }
        // This TEST authority is consumed on the Effect clock, independently of the SQL eligibility clock.
        const at = yield* owner.observationNow();
        return {
          binding,
          observedAt: at,
          provenance: 'TEST_ONLY_FIXED_FINAL_OWNER_STATE',
          validUntil: DateTime.add(at, { seconds: observationSeconds }),
        };
      }).pipe(Effect.mapError(authorityUnavailable)),
  };
  const context = Context.add(owner.runtimeContext, PurchaseApprovalFinalBindingAuthority, authority);
  const claimFor = (intent: string) =>
    Effect.gen(function* exactPublicClaim() {
      const { at } = yield* owner.nativeNow();
      return yield* Schema.decodeUnknownEffect(RevalidatePurchaseApprovalInputSchema)({
        buyerPermission: 'ALLOWED',
        checkedAt: DateTime.formatIso(at),
        commitmentCorrelationId: correlation,
        counterpartyRef: chain.counterpartyRef,
        decisionBundleHash: approved.decision.decisionBundleHash,
        decisionBundleVersion: approved.decision.decisionBundleVersion,
        decisionRef: approved.decision.decisionRef,
        expectedProposalHash: chain.proposal.canonicalHash,
        finalBinding: yield* Schema.encodeEffect(PurchaseApprovalFinalBindingSchema)(binding),
        hierarchyRef: chain.hierarchy.hierarchyRef,
        idempotencyKey: intent,
        profileState: 'ACTIVE',
        proposalRevisionRef: chain.proposal.proposalRevisionRef,
        requestRef: approved.request.requestRef,
        routeCurrent: true,
        routeRef: approved.request.route.routeRef,
        sourceRevisions: chain.sourceRevisions,
        storefrontId: owner.storefrontId,
        validUntil: chain.expiresAtText,
      });
    });
  const check = (intent: string, patch: Partial<RevalidatePurchaseApprovalInput> = {}, withAuthority = true) =>
    Effect.gen(function* registeredRevalidation() {
      const payload = yield* claimFor(intent);
      return yield* Context.get(context, ActionRuntime)
        .runAction({
          payload: yield* Schema.encodeEffect(revalidatePurchaseApprovalAction.descriptor.payloadSchema)({
            ...payload,
            ...patch,
          }),
          principal: yield* owner.authenticatedPrincipal(),
          registration: revalidatePurchaseApprovalAction,
          transport: {
            correlationId: randomUUID(),
            idempotencyKey: randomUUID(),
            targetModuleKey: 'commerce.customer-context',
          },
        })
        .pipe(Effect.provideContext(withAuthority ? context : owner.runtimeContext));
    });

  const prepareReplayFrame = (intent: string) =>
    claimFor(intent).pipe(
      Effect.flatMap((claimed) => actualCurrentReplayFrame(owner, context, approved.request, claimed)),
    );
  const directReplay = (frame: TrustedRevalidatePurchaseApprovalInput, originalInvocation: string) =>
    owner.fixture
      .prepareOwner(
        (transaction, scope) =>
          purchasingApprovalWorkflowForScope(transaction, scope).pipe(
            Effect.flatMap((workflow) => workflow.forActionInvocation(originalInvocation).revalidate(frame)),
          ),
        'required',
      )
      .pipe(Effect.provideContext(context));
  // Persistence component control only: this deliberately permissive foreign
  // authority double exercises the native consumption guards, not a real Order
  // producer, committed Order, or downstream reconciliation.
  const consumeComponent = (input: ConsumePurchaseApprovalInput, apiKey = true) =>
    Effect.gen(function* consumeRegisteredComponent() {
      return yield* Context.get(context, ActionRuntime).runAction({
        payload: yield* Schema.encodeEffect(consumePurchaseApprovalAction.descriptor.payloadSchema)(input),
        principal: yield* owner.authenticatedPrincipal(
          apiKey ? owner.fixture.manager : { ...owner.fixture.manager, authMethod: 'session' },
        ),
        registration: consumePurchaseApprovalAction,
        transport: {
          correlationId: randomUUID(),
          idempotencyKey: randomUUID(),
          targetModuleKey: 'commerce.customer-context',
        },
      });
    }).pipe(
      Effect.provideContext(
        Context.add(context, PurchaseApprovalFinalBindingAuthority, {
          ...authority,
          verifyConsumption: ({ claimed }) =>
            Effect.gen(function* testOnlyConsumptionAuthority() {
              if (claimed.revalidationRef === undefined) {
                return yield* new PurchasingApprovalRejected({
                  code: 'CURRENT_STATE_INDETERMINATE',
                  reason: 'TEST consumption requires a proof reference',
                  retryable: false,
                });
              }
              authorityEntries += 1;
              if (pause !== null) {
                yield* Deferred.succeed(pause.entered, true);
                yield* Deferred.await(pause.release);
              }
              const { at } = yield* owner.nativeNow();
              return {
                bindingEvidence: {
                  binding,
                  observedAt: at,
                  provenance: 'TEST_ONLY_CONSUMPTION_AUTHORITY_DOUBLE',
                  validUntil: DateTime.add(at, { minutes: 1 }),
                },
                orderRef: claimed.orderRef,
                revalidationRef: claimed.revalidationRef,
              };
            }).pipe(Effect.mapError(authorityUnavailable)),
        }),
      ),
    );
  const componentConsumptionClaim = (revalidationRef: ConsumePurchaseApprovalInput['revalidationRef']) =>
    Effect.gen(function* makeComponentConsumptionClaim() {
      const { at } = yield* owner.nativeNow();
      return yield* Schema.decodeUnknownEffect(ConsumePurchaseApprovalInputSchema)({
        commitmentCorrelationId: correlation,
        committedAt: DateTime.formatIso(at),
        counterpartyRef: chain.counterpartyRef,
        decisionBundleHash: approved.decision.decisionBundleHash,
        decisionBundleVersion: approved.decision.decisionBundleVersion,
        finalBinding: binding,
        idempotencyKey: randomUUID(),
        orderRef: {
          moduleId: 'commerce.order',
          resourceId: 'TEST_COMPONENT_ORDER',
          resourceType: 'commerce.order.order',
          tenantId: owner.tenantId,
        },
        proposalRevisionRef: chain.proposal.proposalRevisionRef,
        requestRef: approved.request.requestRef,
        revalidationRef,
        storefrontId: owner.storefrontId,
      });
    });
  const readProofs = () =>
    owner.admin.select().from(approvalRevalidations).where(eq(approvalRevalidations.tenantId, owner.tenantId));
  const readRequest = () =>
    owner.admin.select().from(purchaseApprovalRequests).where(eq(purchaseApprovalRequests.tenantId, owner.tenantId));
  const expire = (validUntil: DateTime.Utc) =>
    Effect.gen(function* realProofExpiry() {
      const { at } = yield* owner.nativeNow();
      const wait = DateTime.toEpochMillis(validUntil) - DateTime.toEpochMillis(at) + 20;
      expect(wait).toBeLessThanOrEqual(initialObservationSeconds * 1000 + 500);
      if (wait > 0) {
        yield* owner.admin.execute(sql`select pg_sleep(${wait / 1000})`, 'objects');
      }
      expect(DateTime.isGreaterThanOrEqualTo((yield* owner.nativeNow()).at, validUntil)).toBe(true);
    });
  return {
    approved,
    authorityEntries: () => authorityEntries,
    binding,
    chain,
    check,
    componentConsumptionClaim,
    consumeComponent,
    context,
    directReplay,
    expire,
    owner,
    pauseAuthority: () =>
      Effect.gen(function* installTestAuthorityBarrier() {
        const entered = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();
        pause = { entered, release };
        return pause;
      }),
    prepareReplayFrame,
    readProofs,
    readRequest,
    setEligible: (value: boolean) => {
      eligible = value;
    },
    setObservationWindow: (seconds: typeof initialObservationSeconds | typeof extendedObservationSeconds) => {
      observationSeconds = seconds;
    },
    submitAgain: () =>
      Effect.gen(function* registeredDifferentIntentSubmission() {
        return yield* Context.get(context, ActionRuntime)
          .runAction({
            payload: yield* Schema.encodeEffect(submitPurchaseApprovalRequestAction.descriptor.payloadSchema)(
              yield* Schema.decodeUnknownEffect(
                Schema.toType(submitPurchaseApprovalRequestAction.descriptor.payloadSchema),
              )({
                counterpartyRef: chain.counterpartyRef,
                idempotencyKey: randomUUID(),
                proposalRevision: chain.proposal.revision,
                proposalRevisionRef: chain.proposal.proposalRevisionRef,
                requestExpiresAt: yield* Schema.decodeUnknownEffect(Schema.DateTimeUtcFromString)(chain.expiresAtText),
                storefrontId: owner.storefrontId,
              }),
            ),
            principal: yield* owner.authenticatedPrincipal(),
            registration: submitPurchaseApprovalRequestAction,
            transport: {
              correlationId: randomUUID(),
              idempotencyKey: randomUUID(),
              targetModuleKey: 'commerce.customer-context',
            },
          })
          .pipe(Effect.provideContext(context));
      }),
  };
});

// These native clone/migration scenarios measured 31–32s with 20–31 assertions completed under shard load.
it.live(
  'commits distinct immutable same-Attempt proofs after expiry and refuses expired intent replay',
  () =>
    Effect.scoped(
      Effect.gen(function* distinctDurableProofs() {
        const test = yield* scenario();
        const intent = randomUUID();
        const first = yield* test.check(intent);
        expect(first.outcome).toBe('APPROVAL_VALID');
        expect(first.revalidation.evidence.finalBindingEvidence?.binding).toEqual(test.binding);
        const firstEvidence = first.revalidation.evidence.finalBindingEvidence;
        assert.isOk(firstEvidence !== undefined);
        expect(firstEvidence.validUntil).toEqual(
          DateTime.add(firstEvidence.observedAt, { seconds: initialObservationSeconds }),
        );
        const original = yield* test.readProofs();
        expect(original).toHaveLength(1);
        const authorityEntriesBeforeUnsignedClaim = test.authorityEntries();
        const unsignedClaim = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(test.check(intent, { expectedProposalHash: 'e'.repeat(64) })),
        );
        expect(unsignedClaim.code).toBe('PERMISSION_DENIED');
        expect(unsignedClaim.reason).toBe('The claimed approval identity does not match the owner-current snapshots');
        expect(test.authorityEntries()).toBe(authorityEntriesBeforeUnsignedClaim);
        expect(yield* test.readProofs()).toEqual(original);
        const replay = yield* test.check(intent);
        expect(replay.revalidation.revalidationRef).toEqual(first.revalidation.revalidationRef);
        expect(replay.revalidation.checkedAt).toEqual(first.revalidation.checkedAt);
        yield* test.expire(first.revalidation.validUntil);
        const refusal = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(test.check(intent)),
        );
        expect(refusal.code).toBe('OWNER_CONFIRMATION_EXPIRED');
        const second = yield* test.check(randomUUID());
        expect(second.revalidation.revalidationRef.resourceId).not.toBe(first.revalidation.revalidationRef.resourceId);
        expect(second.revalidation.requestRef).toEqual(first.revalidation.requestRef);
        expect(second.revalidation.evidence.finalBindingEvidence?.binding).toEqual(test.binding);
        const records = yield* test.readProofs();
        expect(records).toHaveLength(2);
        expect(records.find((row) => row.revalidationResourceId === original[0]?.revalidationResourceId)).toEqual(
          original[0],
        );
        expect(DateTime.isGreaterThan(second.revalidation.checkedAt, first.revalidation.checkedAt)).toBe(true);
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);

it.live(
  'rejects proof-changing writer frames after actual Current resolution without new effects or history',
  () =>
    Effect.scoped(
      Effect.gen(function* nativeWriterIntegrityControls() {
        const test = yield* scenario();
        const intent = randomUUID();
        const first = yield* test.check(intent);
        const invocation = first.revalidation.evidence.actionInvocationId;
        assert.isOk(invocation !== undefined);
        yield* test.expire(first.revalidation.validUntil);
        test.setObservationWindow(extendedObservationSeconds);
        // These are deliberately corrupted owner-service frames, not legitimate lifecycle changes
        // or genuine Order facts. Every baseline frame first passes the actual Current factory.
        for (const replay of [false, true]) {
          const frame = yield* test.prepareReplayFrame(replay ? intent : randomUUID());
          const changedBinding = { ...frame.finalBinding, bundleHash: 'e'.repeat(64) };
          const changedAttempt = yield* Schema.decodeUnknownEffect(Schema.toType(PurchaseApprovalFinalBindingSchema))({
            ...frame.finalBinding,
            attemptRef: { ...frame.finalBinding.attemptRef, resourceId: randomUUID() },
          });
          const controls: {
            readonly code: PurchasingApprovalRejected['code'];
            readonly label: string;
            readonly patch: Partial<TrustedRevalidatePurchaseApprovalInput>;
          }[] = [
            {
              code: 'PROPOSAL_MATERIAL_CHANGE',
              label: 'request',
              patch: { requestRef: { ...frame.requestRef, resourceId: randomUUID() } },
            },
            {
              code: 'PROPOSAL_MATERIAL_CHANGE',
              label: 'proposal reference',
              patch: { proposalRevisionRef: { ...frame.proposalRevisionRef, resourceId: randomUUID() } },
            },
            {
              code: 'PROPOSAL_MATERIAL_CHANGE',
              label: 'proposal hash',
              patch: { expectedProposalHash: 'e'.repeat(64) },
            },
            {
              code: 'PROPOSAL_MATERIAL_CHANGE',
              label: 'decision reference',
              patch: { decisionRef: { ...frame.decisionRef, resourceId: randomUUID() } },
            },
            { code: 'PROPOSAL_MATERIAL_CHANGE', label: 'decision hash', patch: { decisionBundleHash: 'e'.repeat(64) } },
            {
              code: 'PROPOSAL_MATERIAL_CHANGE',
              label: 'route',
              patch: { routeRef: { ...frame.routeRef, resourceId: randomUUID() } },
            },
            {
              code: 'PROPOSAL_MATERIAL_CHANGE',
              label: 'hierarchy',
              patch: { hierarchyRef: { ...frame.hierarchyRef, resourceId: randomUUID() } },
            },
            {
              code: 'PROPOSAL_MATERIAL_CHANGE',
              label: 'source vector',
              patch: {
                sourceRevisions: frame.sourceRevisions.map((source) => ({ ...source, revision: source.revision + 1 })),
              },
            },
            {
              code: 'PERMISSION_DENIED',
              label: 'final binding versus observation',
              patch: { finalBinding: changedBinding },
            },
            {
              code: 'PERMISSION_DENIED',
              label: 'different binding with matching observation',
              patch: {
                finalBinding: changedBinding,
                finalBindingEvidence: { ...frame.finalBindingEvidence, binding: changedBinding },
              },
            },
            {
              code: 'PERMISSION_DENIED',
              label: 'different Attempt with matching observation',
              patch: {
                finalBinding: changedAttempt,
                finalBindingEvidence: { ...frame.finalBindingEvidence, binding: changedAttempt },
              },
            },
          ];
          if (replay) {
            controls.push({
              code: 'IDEMPOTENCY_CONFLICT',
              label: 'correlation',
              patch: { commitmentCorrelationId: randomUUID() },
            });
          }

          const proofs = yield* test.readProofs();
          const request = yield* test.readRequest();
          const history = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
          const entries = test.authorityEntries();
          for (const control of controls) {
            const tampered = yield* Schema.decodeUnknownEffect(
              Schema.toType(TrustedRevalidatePurchaseApprovalInputSchema),
            )({ ...frame, ...control.patch });
            const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
              yield* Effect.flip(test.directReplay(tampered, invocation)),
            );
            expect(failure.code, `${replay ? 'I1 replay' : 'new intent'}: ${control.label}`).toBe(
              replay ? 'IDEMPOTENCY_CONFLICT' : control.code,
            );
            expect(failure.retryable).toBe(false);
            expect(yield* test.readProofs()).toEqual(proofs);
            expect(yield* test.readRequest()).toEqual(request);
            expect(yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor)).toEqual(history);
            expect(test.authorityEntries()).toBe(entries);
          }
        }
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);

it.live(
  'retains native proof identity and idempotency UNIQUE guards and rolls back actual collisions',
  () =>
    Effect.scoped(
      Effect.gen(function* nativeProofUniqueness() {
        const test = yield* scenario();
        yield* test.check(randomUUID());
        const proofs = yield* test.readProofs();
        const request = yield* test.readRequest();
        const history = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        const constraints = yield* test.owner.admin.execute<{ readonly definition: string; readonly name: string }>(
          sql`
        select conname as name, pg_get_constraintdef(oid) as definition from pg_catalog.pg_constraint
        where conrelid='commerce_customer_context.approval_revalidations'::regclass
        and conname in ('ccc_approval_revalidations_resource_uk', 'ccc_approval_revalidations_idempotency_uk')
        order by conname`,
          'objects',
        );
        expect(constraints).toEqual([
          {
            definition: 'UNIQUE (tenant_id, legal_entity_id, idempotency_key)',
            name: 'ccc_approval_revalidations_idempotency_uk',
          },
          {
            definition: 'UNIQUE (tenant_id, legal_entity_id, revalidation_resource_id)',
            name: 'ccc_approval_revalidations_resource_uk',
          },
        ]);
        for (const column of ['revalidation_resource_id', 'idempotency_key'] as const) {
          const constraint =
            column === 'idempotency_key'
              ? 'ccc_approval_revalidations_idempotency_uk'
              : 'ccc_approval_revalidations_resource_uk';
          const otherColumn = column === 'idempotency_key' ? 'revalidation_resource_id' : 'idempotency_key';
          // Admin-only storage corruption control in this isolated database. The attempted copy
          // changes the primary key and the other unique value, isolating exactly one guard.
          // PostgreSQL's exception subtransaction rolls back the rejected INSERT; an absent or
          // different constraint raises and fails this test instead of silently accepting a copy.
          yield* test.owner.admin.execute(
            sql.raw(`DO $collision$
          DECLARE rejected_constraint text;
          BEGIN
            BEGIN
              INSERT INTO commerce_customer_context.approval_revalidations
              SELECT (jsonb_populate_record(null::commerce_customer_context.approval_revalidations,
                to_jsonb(proof) || jsonb_build_object('approval_revalidation_id', gen_random_uuid(),
                  '${otherColumn}', gen_random_uuid()::text))).*
              FROM commerce_customer_context.approval_revalidations proof LIMIT 1;
              RAISE EXCEPTION 'Expected native ${constraint} collision was accepted';
            EXCEPTION WHEN unique_violation THEN
              GET STACKED DIAGNOSTICS rejected_constraint = CONSTRAINT_NAME;
              IF rejected_constraint IS DISTINCT FROM '${constraint}' THEN
                RAISE EXCEPTION 'Unexpected native constraint: %', rejected_constraint;
              END IF;
            END;
          END $collision$`),
            'objects',
          );
          expect(yield* test.readProofs()).toEqual(proofs);
          expect(yield* test.readRequest()).toEqual(request);
          expect(yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor)).toEqual(history);
        }
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);

it.live('keeps unavailable, changed, foreign and unresolved final bindings proof-free', () =>
  Effect.scoped(
    Effect.gen(function* finalAuthorityDenials() {
      const test = yield* scenario();
      const unavailable = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
        yield* Effect.flip(test.check(randomUUID(), {}, false)),
      );
      expect(unavailable.code).toBe('CURRENT_STATE_INDETERMINATE');
      for (const finalBinding of [
        { ...test.binding, bundleHash: 'e'.repeat(64) },
        { ...test.binding, attemptRef: { ...test.binding.attemptRef, resourceId: randomUUID() } },
        { ...test.binding, attemptRef: { ...test.binding.attemptRef, tenantId: randomUUID() } },
      ]) {
        const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(
            test.check(randomUUID(), {
              finalBinding: yield* Schema.decodeUnknownEffect(PurchaseApprovalFinalBindingSchema)(finalBinding),
            }),
          ),
        );
        expect(failure.code).toBe('CURRENT_STATE_INDETERMINATE');
        expect(yield* test.readProofs()).toEqual([]);
      }
      test.setEligible(false);
      const unknown = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
        yield* Effect.flip(test.check(randomUUID())),
      );
      expect(unknown.code).toBe('CURRENT_STATE_INDETERMINATE');
      expect(yield* test.readProofs()).toEqual([]);
    }),
  ).pipe(Effect.provide(services)),
);

it.live('serializes distinct and same fresh intents without changing request revision or historical proof bytes', () =>
  Effect.scoped(
    Effect.gen(function* concurrentProofIssuance() {
      const test = yield* scenario();
      const first = yield* test.check(randomUUID());
      const original = yield* test.readProofs();
      yield* test.expire(first.revalidation.validUntil);
      const results = yield* Effect.all([test.check(randomUUID()), test.check(randomUUID())], { concurrency: 2 });
      expect(new Set(results.map((result) => result.revalidation.revalidationRef.resourceId)).size).toBe(2);
      expect(yield* test.readProofs()).toHaveLength(3);
      const intent = randomUUID();
      const replay = yield* Effect.all([test.check(intent), test.check(intent)], { concurrency: 2 });
      expect(replay[0].revalidation.revalidationRef).toEqual(replay[1].revalidation.revalidationRef);
      const records = yield* test.readProofs();
      expect(records).toHaveLength(4);
      expect(records.find((row) => row.revalidationResourceId === original[0]?.revalidationResourceId)).toEqual(
        original[0],
      );
      for (const record of records) {
        expect(record.evidence.requestRevision).toBe(test.approved.request.requestRevision);
      }
    }),
  ).pipe(Effect.provide(services)),
);

type FreshProofScenario = Effect.Success<ReturnType<typeof scenario>>;
const holdGenuineRequest = (test: FreshProofScenario) =>
  Effect.gen(function* holdOnlyOwnedRequest() {
    const held = yield* Deferred.make<number>();
    const release = yield* Deferred.make<boolean>();
    yield* Effect.addFinalizer(() => Deferred.succeed(release, true).pipe(Effect.asVoid));
    const holder = yield* test.owner.admin
      .transaction((transaction) =>
        Effect.gen(function* independentRequestHolder() {
          const [connection] = yield* transaction.execute<{ pid: number }>(
            sql`select pg_backend_pid() as pid`,
            'objects',
          );
          assert.isOk(connection !== undefined);
          const rows = yield* transaction
            .select()
            .from(purchaseApprovalRequests)
            .where(
              and(
                eq(purchaseApprovalRequests.tenantId, test.owner.tenantId),
                eq(purchaseApprovalRequests.legalEntityId, test.owner.legalEntityId),
                eq(purchaseApprovalRequests.requestResourceId, test.approved.request.requestRef.resourceId),
              ),
            )
            .for('update');
          expect(rows).toHaveLength(1);
          yield* Deferred.succeed(held, connection.pid);
          yield* Deferred.await(release);
        }),
      )
      .pipe(Effect.forkScoped);
    const blocker = yield* Deferred.await(held);
    return { blocker, holder, release };
  });

const waitForExactBlock = (
  test: FreshProofScenario,
  blocker: number,
  kind: 'TENANT' | 'REQUEST' | 'DIRECT',
  before?: DateTime.Utc,
) =>
  Effect.gen(function* observeActualNativeWait() {
    const needle = {
      DIRECT: 'revalidate_purchase_approval',
      REQUEST: 'read_current_purchase_approval_revalidation',
      TENANT: '"core"."tenants"',
    }[kind];
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const rows = yield* test.owner.admin.execute<{ beforeDeadline: boolean; exactQuery: boolean; pid: number }>(
        sql`select pid, (${before === undefined ? null : DateTime.formatIso(before)}::timestamptz is null or query_start < ${before === undefined ? null : DateTime.formatIso(before)}::timestamptz) as "beforeDeadline",
        position(${needle} in query)>0 as "exactQuery"
        from pg_stat_activity where datname=current_database() and wait_event_type='Lock'
          and ${blocker}::integer=any(pg_blocking_pids(pid))`,
        'objects',
      );
      const match = rows.find((row) => row.exactQuery);
      if (match !== undefined) {
        expect(match.beforeDeadline).toBe(true);
        return match.pid;
      }
      yield* test.owner.admin.execute(sql`select pg_sleep(0.005)`, 'objects');
    }
    return yield* Effect.die('The expected actual Tenant/request/direct-replay lock wait was not observed');
  });

const pausedRegisteredBackend = (test: FreshProofScenario) =>
  Effect.gen(function* exactPausedRegisteredBackend() {
    const rows = yield* test.owner.admin.execute<{ pid: number }>(
      sql`select pid from pg_stat_activity where datname=current_database() and state='idle in transaction' and pid<>pg_backend_pid()`,
      'objects',
    );
    expect(rows).toHaveLength(1);
    const [row] = rows;
    assert.isOk(row !== undefined);
    return row.pid;
  });

it.live('serializes actual registered revalidations at the Core Tenant gate before the second authority entry', () =>
  Effect.scoped(
    Effect.gen(function* tenantGateSerialization() {
      const test = yield* scenario();
      const first = yield* test.check(randomUUID());
      const original = yield* test.readProofs();
      yield* test.expire(first.revalidation.validUntil);
      const pause = yield* test.pauseAuthority();
      const entries = test.authorityEntries();
      const actionA = yield* test.check(randomUUID()).pipe(Effect.forkScoped);
      yield* Deferred.await(pause.entered);
      const blocker = yield* pausedRegisteredBackend(test);
      const actionB = yield* test.check(randomUUID()).pipe(Effect.forkScoped);
      yield* waitForExactBlock(test, blocker, 'TENANT');
      expect(test.authorityEntries()).toBe(entries + 1);
      yield* Deferred.succeed(pause.release, true);
      const a = yield* Fiber.join(actionA);
      const b = yield* Fiber.join(actionB);
      expect(a.revalidation.revalidationRef.resourceId).not.toBe(b.revalidation.revalidationRef.resourceId);
      expect(test.authorityEntries()).toBe(entries + 2);
      const records = yield* test.readProofs();
      expect(records).toHaveLength(3);
      expect(records.find((row) => row.revalidationResourceId === original[0]?.revalidationResourceId)).toEqual(
        original[0],
      );
    }),
  ).pipe(Effect.provide(services)),
);

it.live(
  'keeps actual different-intent Submit behind the same Tenant gate and preserves its existing typed conflict',
  () =>
    Effect.scoped(
      Effect.gen(function* actualSubmissionCompetition() {
        const test = yield* scenario();
        const pause = yield* test.pauseAuthority();
        const check = yield* test.check(randomUUID()).pipe(Effect.forkScoped);
        yield* Deferred.await(pause.entered);
        const blocker = yield* pausedRegisteredBackend(test);
        const submit = yield* test.submitAgain().pipe(Effect.result, Effect.forkScoped);
        yield* waitForExactBlock(test, blocker, 'TENANT');
        expect(test.authorityEntries()).toBe(1);
        yield* Deferred.succeed(pause.release, true);
        yield* Fiber.join(check);
        const result = yield* Fiber.join(submit);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(result.failure);
          expect(failure.code).toBe('IDEMPOTENCY_CONFLICT');
        }
        expect(yield* test.readProofs()).toHaveLength(1);
      }),
    ).pipe(Effect.provide(services)),
);

it.live('refuses original I1 after the actual registered request wait crosses exclusive P1 expiry', () =>
  Effect.scoped(
    Effect.gen(function* registeredExpiryAfterWait() {
      const test = yield* scenario();
      const intent = randomUUID();
      const first = yield* test.check(intent);
      const original = yield* test.readProofs();
      const held = yield* holdGenuineRequest(test);
      const replay = yield* test.check(intent).pipe(Effect.result, Effect.forkScoped);
      const pid = yield* waitForExactBlock(test, held.blocker, 'REQUEST', first.revalidation.validUntil);
      yield* test.expire(first.revalidation.validUntil);
      expect(yield* waitForExactBlock(test, held.blocker, 'REQUEST')).toBe(pid);
      yield* Deferred.succeed(held.release, true);
      yield* Fiber.join(held.holder);
      const result = yield* Fiber.join(replay);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(result.failure);
        expect(failure.code).toBe('OWNER_CONFIRMATION_EXPIRED');
      }
      expect(yield* test.readProofs()).toEqual(original);
    }),
  ).pipe(Effect.provide(services)),
);

for (const state of ['OLD_CLOCK', 'CURRENT'] as const) {
  it.live(
    state === 'OLD_CLOCK'
      ? 'OLD clock accepts an exact genuine P1 component replay after forced expiry with fresh incoming evidence'
      : 'CURRENT clock refuses an exact genuine P1 component replay after forced expiry with fresh incoming evidence',
    () =>
      Effect.scoped(
        Effect.gen(function* directOriginalFrameClockDiscriminator() {
          const test = yield* scenario(state);
          const intent = randomUUID();
          const first = yield* test.check(intent);
          const original = yield* test.readProofs();
          const [record] = original;
          assert.isOk(record !== undefined && record.actionInvocationId !== null && record.actorPrincipalId !== null);
          expect(record.actionInvocationId).toBe(first.revalidation.evidence.actionInvocationId);
          expect(record.actorPrincipalId).toBe(test.owner.principal.principalId);
          // Authorized durable replay of this exact P1, not an invented or unrelated invocation.
          test.setObservationWindow(extendedObservationSeconds);
          const frame = yield* test.prepareReplayFrame(intent);
          const encoded = yield* Schema.encodeEffect(TrustedRevalidatePurchaseApprovalInputSchema)(frame);
          expect(encoded.idempotencyKey).toBe(intent);
          expect(encoded.finalBinding).toEqual(
            yield* Schema.encodeEffect(PurchaseApprovalFinalBindingSchema)(test.binding),
          );
          expect(
            DateTime.isGreaterThan(frame.validUntil, DateTime.add(first.revalidation.validUntil, { seconds: 5 })),
          ).toBe(true);
          const held = yield* holdGenuineRequest(test);
          const replay = yield* test
            .directReplay(frame, record.actionInvocationId)
            .pipe(Effect.result, Effect.forkScoped);
          yield* waitForExactBlock(test, held.blocker, 'DIRECT', first.revalidation.validUntil);
          yield* test.expire(first.revalidation.validUntil);
          yield* Deferred.succeed(held.release, true);
          yield* Fiber.join(held.holder);
          expect(DateTime.isLessThan((yield* test.owner.nativeNow()).at, frame.validUntil)).toBe(true);
          const result = yield* Fiber.join(replay);
          if (state === 'OLD_CLOCK') {
            expect(Result.isSuccess(result)).toBe(true);
            if (Result.isSuccess(result)) {
              expect(result.success.revalidation.revalidationRef).toEqual(first.revalidation.revalidationRef);
              expect(result.success.revalidation.checkedAt).toEqual(first.revalidation.checkedAt);
              expect(result.success.revalidation.validUntil).toEqual(first.revalidation.validUntil);
            }
          } else {
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(result.failure);
              expect(failure.code).toBe('OWNER_CONFIRMATION_EXPIRED');
            }
          }
          expect(yield* test.readProofs()).toEqual(original);
        }),
      ).pipe(Effect.provide(services)),
  );
}

it.live('rejects fresh proof after actual buyer revocation and retains committed P1 history', () =>
  Effect.scoped(
    Effect.gen(function* revokedBuyerBetweenProofs() {
      const test = yield* scenario();
      const first = yield* test.check(randomUUID());
      const original = yield* test.readProofs();
      const request = yield* test.readRequest();
      yield* test.expire(first.revalidation.validUntil);
      const revoked = yield* test.chain.revokeBuyer();
      expect(revoked.outcome).toBe('RECONCILIATION_REQUIRED');
      expect(revoked.grant.state).toBe('RECONCILIATION_REQUIRED');
      assert.isOk(revoked.outcome === 'RECONCILIATION_REQUIRED');
      expect(revoked.reconciliation.staged).toBe(true);
      const entries = test.authorityEntries();
      const pending = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
        yield* Effect.flip(test.check(randomUUID())),
      );
      expect(pending.code).toBe('CURRENT_STATE_INDETERMINATE');
      expect(pending.reason).toBe('Current buyer authorization is unavailable');
      expect(test.authorityEntries()).toBe(entries);
      expect(yield* test.readProofs()).toEqual(original);
      // Complete the actual staged relation/native protocol explicitly at the fixture seam.
      // This is not a claim that the production Outbox Worker was executed.
      const settled = yield* test.owner.settleBuyerRevocation(
        test.chain.counterpartyRef,
        revoked.grant.grantRef.resourceId,
        revoked.reconciliation.mutationId,
      );
      expect(settled).toEqual([{ state: 'REVOKED' }]);
      const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
        yield* Effect.flip(test.check(randomUUID())),
      );
      expect(failure.code).toBe('BUYER_PERMISSION_DENIED');
      expect(test.authorityEntries()).toBe(entries + 1);
      expect(yield* test.readProofs()).toEqual(original);
      expect(yield* test.readRequest()).toEqual(request);
    }),
  ).pipe(Effect.provide(services)),
);

for (const change of ['POLICY', 'PROFILE'] as const) {
  it.live(`rejects fresh proof after actual ${change} change without rewriting P1 or request history`, () =>
    Effect.scoped(
      Effect.gen(function* changedOwnerStateBetweenProofs() {
        const test = yield* scenario();
        const first = yield* test.check(randomUUID());
        const original = yield* test.readProofs();
        const request = yield* test.readRequest();
        yield* test.expire(first.revalidation.validUntil);
        if (change === 'POLICY') {
          const changed = yield* test.chain.changeLimit();
          expect(changed.status).toBe('CHANGED');
          expect(changed.previousPolicy?.revision).toBe(1);
          expect(changed.currentPolicy?.revision).toBe(2);
        } else {
          const suspended = yield* test.chain.suspendProfile();
          expect(suspended.outcome).toBe('PROFILE_SUSPENDED');
          expect(suspended.state).toBe('SUSPENDED');
          expect(suspended.revision).toBe(test.chain.profile.revision + 1);
        }
        const entries = test.authorityEntries();
        const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(test.check(randomUUID())),
        );
        // Real owner revisions changed; the Current source check refuses stale proposal evidence
        // before the TEST final authority can approve a binding. No denial flag stands in for mutation.
        expect(failure.code).toBe('CURRENT_STATE_INDETERMINATE');
        expect(failure.reason).toBe('Current owner source revisions no longer match the captured approval');
        expect(test.authorityEntries()).toBe(entries);
        expect(yield* test.readProofs()).toEqual(original);
        expect(yield* test.readRequest()).toEqual(request);
      }),
    ).pipe(Effect.provide(services)),
  );
}

it.live(
  'rejects fresh intent at actual request expiry without replacing P1 or extending the request',
  () =>
    Effect.scoped(
      Effect.gen(function* actualRequestExpiryCutoff() {
        const requestTtlMilliseconds = 15_000;
        const test = yield* scenario('CURRENT', requestTtlMilliseconds);
        const first = yield* test.check(randomUUID());
        const original = yield* test.readProofs();
        const request = yield* test.readRequest();
        const expiry = test.approved.request.expiresAt;
        expect(DateTime.isLessThan(first.revalidation.validUntil, expiry)).toBe(true);
        yield* test.expire(first.revalidation.validUntil);
        test.setObservationWindow(extendedObservationSeconds);
        const second = yield* test.check(randomUUID());
        expect(second.revalidation.revalidationRef).not.toEqual(first.revalidation.revalidationRef);
        // Authority observation outlives the remaining request TTL. The native LEAST bound
        // must clip P2 exactly to the real Submit expiry, without manipulating either clock.
        const observation = second.revalidation.evidence.finalBindingEvidence;
        assert.isOk(observation !== undefined);
        expect(DateTime.isGreaterThan(observation.validUntil, expiry)).toBe(true);
        expect(second.revalidation.validUntil).toEqual(expiry);
        const boundedProofs = yield* test.readProofs();
        const stored = boundedProofs.find(
          (proof) => proof.revalidationResourceId === second.revalidation.revalidationRef.resourceId,
        );
        assert.isOk(stored !== undefined);
        expect(stored.validUntil.getTime()).toBe(DateTime.toEpochMillis(expiry));
        expect(
          boundedProofs.find((proof) => proof.revalidationResourceId === original[0]?.revalidationResourceId),
        ).toEqual(original[0]);
        // Wait against the real request expiry written by Submit, never UPDATE its timestamp/status.
        const remaining = DateTime.toEpochMillis(expiry) - DateTime.toEpochMillis((yield* test.owner.nativeNow()).at);
        expect(remaining).toBeGreaterThan(0);
        expect(remaining).toBeLessThanOrEqual(requestTtlMilliseconds);
        yield* test.owner.admin.execute(sql`select pg_sleep(${(remaining + 20) / 1000})`, 'objects');
        expect(DateTime.isGreaterThanOrEqualTo((yield* test.owner.nativeNow()).at, expiry)).toBe(true);
        const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(test.check(randomUUID())),
        );
        // Current resolution clips the owner confirmation to request expiry. At this
        // boundary the writer therefore rejects that expired confirmation first.
        expect(failure.code).toBe('OWNER_CONFIRMATION_EXPIRED');
        expect(failure.reason).toBe('The owner revalidation evidence is outside the trusted validity window');
        expect(yield* test.readProofs()).toEqual(boundedProofs);
        expect(yield* test.readRequest()).toEqual(request);
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);

for (const scope of ['TENANT', 'STOREFRONT'] as const) {
  it.live(`rejects wrong ${scope} scope before Current authority and preserves existing P1`, () =>
    Effect.scoped(
      Effect.gen(function* wrongRegisteredScope() {
        const test = yield* scenario();
        const first = yield* test.check(randomUUID());
        const original = yield* test.readProofs();
        const request = yield* test.readRequest();
        yield* test.expire(first.revalidation.validUntil);
        const entries = test.authorityEntries();
        const refused = yield* Effect.flip(
          test.check(
            randomUUID(),
            scope === 'TENANT'
              ? {
                  counterpartyRef: yield* Schema.decodeUnknownEffect(
                    RevalidatePurchaseApprovalInputSchema.fields.counterpartyRef,
                  )({ ...test.chain.counterpartyRef, tenantId: randomUUID() }),
                }
              : {
                  storefrontId: yield* Schema.decodeUnknownEffect(
                    RevalidatePurchaseApprovalInputSchema.fields.storefrontId,
                  )('different-native-approval-storefront'),
                },
          ),
        );
        if (scope === 'TENANT') {
          const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(refused);
          expect(failure.code).toBe('PERMISSION_DENIED');
          expect(failure.reason).toBe('Revalidation scope must match trusted Counterparty Storefront context');
          expect(failure.retryable).toBe(false);
        } else {
          const failure = yield* Schema.decodeUnknownEffect(ActionPermissionCheckError)(refused);
          expect(failure.reason).toBe('The declared business permission target does not match trusted scope');
        }
        expect(test.authorityEntries()).toBe(entries);
        expect(yield* test.readProofs()).toEqual(original);
        expect(yield* test.readRequest()).toEqual(request);
      }),
    ).pipe(Effect.provide(services)),
  );
}

it.live('rolls back a genuinely inserted fresh owner proof when its enclosing transaction fails', () =>
  Effect.scoped(
    Effect.gen(function* nativeFreshProofRollback() {
      const test = yield* scenario();
      const first = yield* test.check(randomUUID());
      const original = yield* test.readProofs();
      const request = yield* test.readRequest();
      yield* test.expire(first.revalidation.validUntil);
      const intent = randomUUID();
      test.setObservationWindow(extendedObservationSeconds);
      const frame = yield* test.prepareReplayFrame(intent);
      const invocation = first.revalidation.evidence.actionInvocationId;
      assert.isOk(invocation !== undefined);
      // Owner component rollback control: actual Current factory and native INSERT, then an explicit
      // TEST enclosing-transaction failure. Reuse genuine P1 invocation metadata only inside this
      // rollback-only component control; no new registered invocation/Order provenance is claimed.
      const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
        yield* Effect.flip(
          test.owner.fixture
            .prepareOwner(
              (transaction, scope) =>
                Effect.gen(function* insertThenAbort() {
                  const workflow = yield* purchasingApprovalWorkflowForScope(transaction, scope);
                  const staged = yield* workflow.forActionInvocation(invocation).revalidate(frame);
                  expect(staged.outcome).toBe('APPROVAL_VALID');
                  expect(staged.revalidation.revalidationRef.resourceId).not.toBe(
                    first.revalidation.revalidationRef.resourceId,
                  );
                  return yield* Effect.fail(
                    new PurchasingApprovalRejected({
                      code: 'CURRENT_STATE_INDETERMINATE',
                      reason: 'TEST abort after successful native fresh-proof INSERT',
                      retryable: true,
                    }),
                  );
                }),
              'required',
            )
            .pipe(Effect.provideContext(test.context)),
        ),
      );
      expect(failure.reason).toBe('TEST abort after successful native fresh-proof INSERT');
      expect(yield* test.readProofs()).toEqual(original);
      expect(yield* test.readRequest()).toEqual(request);
      // The rolled-back intent is reusable: it can subsequently commit exactly one new P2.
      const retried = yield* test.check(intent);
      expect(retried.outcome).toBe('APPROVAL_VALID');
      const committed = yield* test.readProofs();
      expect(committed).toHaveLength(2);
      expect(committed.find((row) => row.revalidationResourceId === original[0]?.revalidationResourceId)).toEqual(
        original[0],
      );
      expect(yield* test.readRequest()).toEqual(request);
    }),
  ).pipe(Effect.provide(services)),
);

it.live('reads exact fresh P2 and retained expired P1 through governed buyer evidence without renewing history', () =>
  Effect.scoped(
    Effect.gen(function* governedBuyerProofHistory() {
      // Governed lifecycle and CCC owner-read proof only. Final authority remains the scenario's
      // explicit TEST seam: no production HTTP, genuine final-owner issuance or full acceptance.
      const test = yield* scenario();
      const first = yield* test.check(randomUUID());
      const original = yield* test.readProofs();
      const request = yield* test.readRequest();
      yield* test.expire(first.revalidation.validUntil);
      test.setObservationWindow(extendedObservationSeconds);
      const second = yield* test.check(randomUUID());
      expect(second.revalidation.revalidationRef).not.toEqual(first.revalidation.revalidationRef);
      expect(DateTime.isGreaterThan(second.revalidation.checkedAt, first.revalidation.validUntil)).toBe(true);
      const proofs = yield* test.readProofs();
      expect(proofs).toHaveLength(2);
      expect(proofs.find((row) => row.revalidationResourceId === original[0]?.revalidationResourceId)).toEqual(
        original[0],
      );
      const before = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
      const authorityEntries = test.authorityEntries();
      const reader = Context.get(test.context, ReadRuntime);
      const read = (input: OrderCommitmentApprovalEvidenceRequest) =>
        Effect.gen(function* governedEvidenceRead() {
          return yield* reader
            .runRead({
              audience: 'commerce-customer-context',
              input: yield* Schema.encodeEffect(OrderCommitmentApprovalEvidenceRequestSchema)(input),
              // Fresh TEST-signed, verified and redeemed principal for every read, including refusals.
              principal: yield* test.owner.authenticatedPrincipal(),
              registration: orderCommitmentApprovalEvidenceRead,
              transport: { correlationId: randomUUID(), targetModuleKey: 'commerce.customer-context' },
            })
            .pipe(Effect.provideContext(test.context));
        });
      const input = yield* Schema.decodeUnknownEffect(OrderCommitmentApprovalEvidenceRequestSchema)({
        counterpartyRef: test.chain.counterpartyRef,
        finalBinding: test.binding,
        operation: 'VERIFY_PROOF',
        requestRef: test.approved.request.requestRef,
        revalidationRef: second.revalidation.revalidationRef,
        storefrontId: test.owner.storefrontId,
      });
      assert.isOk(input.operation === 'VERIFY_PROOF');
      const fresh = yield* read(input);
      assert.isOk(fresh.operation === 'VERIFY_PROOF');
      expect(fresh.proof).toEqual({
        checkedAt: second.revalidation.checkedAt,
        evidence: second.revalidation.evidence,
        proposalRevisionRef: second.revalidation.proposalRevisionRef,
        requestRef: input.requestRef,
        revalidationRef: second.revalidation.revalidationRef,
        status: second.revalidation.status,
        validUntil: second.revalidation.validUntil,
      });
      expect(fresh.proposal).toEqual(test.chain.proposal);
      expect(fresh.request).toEqual(test.approved.request);
      const historical = yield* read({ ...input, revalidationRef: first.revalidation.revalidationRef });
      assert.isOk(historical.operation === 'VERIFY_PROOF');
      expect(historical.proof).toEqual({
        checkedAt: first.revalidation.checkedAt,
        evidence: first.revalidation.evidence,
        proposalRevisionRef: first.revalidation.proposalRevisionRef,
        requestRef: input.requestRef,
        revalidationRef: first.revalidation.revalidationRef,
        status: first.revalidation.status,
        validUntil: first.revalidation.validUntil,
      });
      expect(historical.request).toEqual(fresh.request);
      expect(historical.proposal).toEqual(fresh.proposal);
      // APPROVAL_VALID is the retained issuance status, not a claim that expired P1 is Current.
      expect(DateTime.isGreaterThanOrEqualTo((yield* test.owner.nativeNow()).at, historical.proof.validUntil)).toBe(
        true,
      );
      for (const patch of [
        { revalidationRef: { ...input.revalidationRef, resourceId: randomUUID() } },
        { finalBinding: { ...input.finalBinding, bundleHash: 'e'.repeat(64) } },
        { requestRef: { ...input.requestRef, tenantId: randomUUID() } },
      ]) {
        const mismatched = yield* Schema.decodeUnknownEffect(OrderCommitmentApprovalEvidenceRequestSchema)({
          ...input,
          ...patch,
        });
        const failure = yield* Schema.decodeUnknownEffect(ReadHandlerNotFound)(yield* Effect.flip(read(mismatched)));
        expect(failure.code).toBe('read_handler_not_found');
        expect(failure.reason).toBe('Approval evidence is unavailable');
      }
      const wrongStorefront = yield* Schema.decodeUnknownEffect(OrderCommitmentApprovalEvidenceRequestSchema)({
        ...input,
        storefrontId: 'different-native-approval-storefront',
      });
      const scopeFailure = yield* Schema.decodeUnknownEffect(ReadHandlerExecutionError)(
        yield* Effect.flip(read(wrongStorefront)),
      );
      expect(scopeFailure.code).toBe('read_handler_execution_failed');
      expect(scopeFailure.reason).toBe('The declared read permission target is invalid');
      expect(test.authorityEntries()).toBe(authorityEntries);
      expect(yield* test.readProofs()).toEqual(proofs);
      expect(yield* test.readRequest()).toEqual(request);
      const after = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
      // Core must durably record the two allowed reads. No new business/Action effects are issued.
      expect(after.accesses).toHaveLength(before.accesses.length + 2);
      expect(after.invocations).toEqual(before.invocations);
      expect(after.audits).toEqual(before.audits);
      expect(after.events).toEqual(before.events);
      expect(after.outbox).toEqual(before.outbox);
    }),
  ).pipe(Effect.provide(services)),
);

it.live(
  'recovers exact original buyer intents after losing proof refs, including expired P1, without new effects',
  () =>
    Effect.scoped(
      Effect.gen(function* exactBuyerIntentRecovery() {
        // Native CCC + real ReadRuntime only. Final authority remains the explicit TEST seam;
        // no production HTTP, genuine Order eligibility or positive consumption is claimed.
        const test = yield* scenario();
        const i1 = randomUUID();
        const p1 = yield* test.check(i1);
        yield* test.expire(p1.revalidation.validUntil);
        test.setObservationWindow(extendedObservationSeconds);
        const i2 = randomUUID();
        const p2 = yield* test.check(i2);
        expect(p2.revalidation.revalidationRef).not.toEqual(p1.revalidation.revalidationRef);
        // A different real actor receives the same permission; retained buyer checks still apply.
        const otherBuyer = yield* test.owner.authorizeRecoveryReader(test.chain.counterpartyRef);
        const foreign = yield* test.owner.createRequest({ ttlMilliseconds: 60_000 });
        const proofs = yield* test.readProofs();
        const requests = yield* test.readRequest();
        const before = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        const entries = test.authorityEntries();
        const reader = Context.get(test.context, ReadRuntime);
        const read = (input: OrderCommitmentApprovalEvidenceRequest, actor = test.owner.fixture.manager) =>
          Effect.gen(function* recoverThroughRealReadRuntime() {
            return yield* reader
              .runRead({
                audience: 'commerce-customer-context',
                input: yield* Schema.encodeEffect(OrderCommitmentApprovalEvidenceRequestSchema)(input),
                principal: yield* test.owner.authenticatedPrincipal(actor),
                registration: orderCommitmentApprovalEvidenceRead,
                transport: { correlationId: randomUUID(), targetModuleKey: 'commerce.customer-context' },
              })
              .pipe(Effect.provideContext(test.context));
          });
        // No proofRef, proposalRef, revision or issuer is supplied: I1/I2 recover them durably.
        const input = yield* Schema.decodeUnknownEffect(OrderCommitmentApprovalEvidenceRequestSchema)({
          commitmentCorrelationId: p1.revalidation.evidence.commitmentCorrelationId,
          counterpartyRef: test.chain.counterpartyRef,
          finalBinding: test.binding,
          idempotencyKey: i1,
          operation: 'RECOVER_REVALIDATION',
          requestRef: test.approved.request.requestRef,
          storefrontId: test.owner.storefrontId,
        });
        assert.isOk(input.operation === 'RECOVER_REVALIDATION');
        const first = yield* read(input);
        assert.isOk(first.operation === 'RECOVER_REVALIDATION' && first.recovery === 'FOUND');
        expect(first.result).toEqual(p1);
        expect(first.request).toEqual(test.approved.request);
        expect(first.proposal).toEqual(test.chain.proposal);
        expect(
          DateTime.isGreaterThanOrEqualTo((yield* test.owner.nativeNow()).at, first.result.revalidation.validUntil),
        ).toBe(true);
        const second = yield* read({ ...input, idempotencyKey: i2 });
        assert.isOk(second.operation === 'RECOVER_REVALIDATION' && second.recovery === 'FOUND');
        expect(second.result).toEqual(p2);
        for (const recovered of [first.result.revalidation, second.result.revalidation]) {
          expect(recovered.evidence.actorPrincipalId).toBe(test.owner.principal.principalId);
          expect(
            proofs.find((proof) => proof.revalidationResourceId === recovered.revalidationRef.resourceId)
              ?.actionInvocationId,
          ).toBe(recovered.evidence.actionInvocationId);
        }
        const absent = { operation: 'RECOVER_REVALIDATION', recovery: 'NOT_FOUND' } as const;
        expect(yield* read({ ...input, idempotencyKey: randomUUID() })).toEqual(absent);
        for (const patch of [
          { finalBinding: { ...input.finalBinding, bundleHash: 'e'.repeat(64) } },
          {
            finalBinding: {
              ...input.finalBinding,
              attemptRef: { ...input.finalBinding.attemptRef, resourceId: randomUUID() },
            },
          },
          { commitmentCorrelationId: randomUUID() },
          { requestRef: { ...input.requestRef, resourceId: randomUUID() } },
        ]) {
          const changed = yield* Schema.decodeUnknownEffect(OrderCommitmentApprovalEvidenceRequestSchema)({
            ...input,
            ...patch,
          });
          const failure = yield* Schema.decodeUnknownEffect(ReadPolicyDenied)(yield* Effect.flip(read(changed)));
          expect(failure.httpStatus).toBe(409);
          expect(failure.policyReasonCode).toBe('APPROVAL_REVALIDATION_INTENT_CONFLICT');
        }
        // Authorized foreign buyer/Counterparty cannot distinguish a retained from unknown intent.
        expect(yield* read(input, otherBuyer)).toEqual(absent);
        expect(yield* read({ ...input, idempotencyKey: randomUUID() }, otherBuyer)).toEqual(absent);
        const foreignScope = yield* Schema.decodeUnknownEffect(OrderCommitmentApprovalEvidenceRequestSchema)({
          ...input,
          counterpartyRef: foreign.counterpartyRef,
          requestRef: foreign.request.request.requestRef,
        });
        expect(yield* read(foreignScope)).toEqual(absent);
        expect(
          yield* read(
            yield* Schema.decodeUnknownEffect(OrderCommitmentApprovalEvidenceRequestSchema)({
              ...foreignScope,
              idempotencyKey: randomUUID(),
            }),
          ),
        ).toEqual(absent);
        const wrongTenant = yield* Schema.decodeUnknownEffect(OrderCommitmentApprovalEvidenceRequestSchema)({
          ...input,
          requestRef: { ...input.requestRef, tenantId: randomUUID() },
        });
        expect(Schema.is(ReadHandlerNotFound)(yield* Effect.flip(read(wrongTenant)))).toBe(true);
        const wrongStorefront = yield* Schema.decodeUnknownEffect(OrderCommitmentApprovalEvidenceRequestSchema)({
          ...input,
          storefrontId: 'different-native-approval-storefront',
        });
        const refused = yield* Schema.decodeUnknownEffect(ReadHandlerExecutionError)(
          yield* Effect.flip(read(wrongStorefront)),
        );
        expect(refused.reason).toBe('The declared read permission target is invalid');
        expect(test.authorityEntries()).toBe(entries);
        expect(yield* test.readProofs()).toEqual(proofs);
        expect(yield* test.readRequest()).toEqual(requests);
        const after = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        // Seven successful governed results: two FOUND and five indistinguishable NOT_FOUND.
        // Core additionally records denied-read evidence for conflicts. No new Action effects.
        const priorAccessIds = new Set(before.accesses.map((access) => access.dataAccessEventId));
        const recoveryReads = after.accesses.filter(
          (access) => !priorAccessIds.has(access.dataAccessEventId) && access.outcome === 'allowed',
        );
        expect(recoveryReads).toHaveLength(7);
        expect(recoveryReads.filter((access) => access.resultCount === 1)).toHaveLength(2);
        expect(recoveryReads.filter((access) => access.resultCount === 0)).toHaveLength(5);
        for (const access of recoveryReads) {
          expect(access.evidencePolicyKey).toBe(
            orderCommitmentApprovalEvidenceRead.descriptor.evidencePolicy.policyKey,
          );
          expect(access.servingModuleKey).toBe('commerce.customer-context');
          expect(access.actionInvocationId).toBeNull();
        }
        expect(after.audits.filter((audit) => audit.actionInvocationId !== null)).toEqual(
          before.audits.filter((audit) => audit.actionInvocationId !== null),
        );
        expect(after.invocations).toEqual(before.invocations);
        expect(after.events).toEqual(before.events);
        expect(after.outbox).toEqual(before.outbox);
      }),
    ).pipe(Effect.provide(services)),
);

it.live('component consumption selects exact P2 once, retains P1 and rejects competing proof and Order claims', () =>
  Effect.scoped(
    Effect.gen(function* exactP2NativeConsumptionComponent() {
      const test = yield* scenario('CURRENT', 60_000, true);
      const p1 = yield* test.check(randomUUID());
      yield* test.expire(p1.revalidation.validUntil);
      test.setObservationWindow(extendedObservationSeconds);
      const p2 = yield* test.check(randomUUID());
      const proofs = yield* test.readProofs();
      const before = yield* test.readRequest();
      const beforeEffects = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
      const claim = yield* test.componentConsumptionClaim(p2.revalidation.revalidationRef);
      const sessionDenied = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ _tag: Schema.Literal('OperationAuthenticationRequired'), reason: Schema.String }),
      )(yield* Effect.flip(test.consumeComponent(claim, false)));
      expect(sessionDenied.reason).toBe('The authenticated principal subject type is not valid');
      const stale = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
        yield* Effect.flip(test.consumeComponent({ ...claim, revalidationRef: p1.revalidation.revalidationRef })),
      );
      expect(stale.code).toBe('PERMISSION_DENIED');
      expect(yield* test.readRequest()).toEqual(before);
      expect(yield* test.readProofs()).toEqual(proofs);
      const consumed = yield* test.consumeComponent(claim);
      expect(consumed.outcome).toBe('CONSUMED');
      expect(consumed.request.consumptionProofRef).toEqual(p2.revalidation.revalidationRef);
      expect(consumed.request.requestRevision).toBe(test.approved.request.requestRevision + 1);
      const stored = yield* test.readRequest();
      const replay = yield* test.consumeComponent(claim);
      expect(replay.outcome).toBe('ALREADY_CONSUMED');
      expect(replay.request).toEqual(consumed.request);
      const conflict = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
        yield* Effect.flip(
          test.consumeComponent({ ...claim, orderRef: { ...claim.orderRef, resourceId: randomUUID() } }),
        ),
      );
      expect(conflict.code).toBe('COMMIT_CONFLICT');
      const competing = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
        yield* Effect.flip(test.consumeComponent({ ...claim, revalidationRef: p1.revalidation.revalidationRef })),
      );
      expect(competing.code).toBe('COMMIT_CONFLICT');
      const afterConsumption = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
      const consumedEvents = afterConsumption.events.filter(
        (event) => event.eventType === 'commerce.customer-context.purchase-approval-consumed.v1',
      );
      expect(consumedEvents).toHaveLength(1);
      expect(afterConsumption.events).toHaveLength(beforeEffects.events.length + 1);
      expect(afterConsumption.outbox).toHaveLength(beforeEffects.outbox.length + 1);
      const afterConsumed = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
        yield* Effect.flip(test.check(randomUUID())),
      );
      expect(afterConsumed.code).toBe('CURRENT_STATE_INDETERMINATE');
      expect(afterConsumed.retryable).toBe(true);
      const afterRefusal = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
      expect(afterRefusal.events).toEqual(afterConsumption.events);
      expect(afterRefusal.outbox).toEqual(afterConsumption.outbox);
      expect(yield* test.readRequest()).toEqual(stored);
      expect(yield* test.readProofs()).toEqual(proofs);
    }),
  ).pipe(Effect.provide(services)),
);

it.live(
  'rejects fresh proof after the registered hierarchy scheduled end without changing retained P1 or effects',
  () =>
    Effect.scoped(
      Effect.gen(function* hierarchyScheduledEndNativeRejection() {
        const hierarchyTtlMilliseconds = 15_000;
        const test = yield* scenario('CURRENT', 60_000, false, hierarchyTtlMilliseconds);
        const p1 = yield* test.check(randomUUID());
        const proofs = yield* test.readProofs();
        const request = yield* test.readRequest();
        const before = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        assert.isOk(test.chain.hierarchy.effectiveTo !== null);
        const end = DateTime.toEpochMillis(test.chain.hierarchy.effectiveTo);
        const { at } = yield* test.owner.nativeNow();
        const wait = end - DateTime.toEpochMillis(at) + 20;
        expect(wait).toBeLessThanOrEqual(hierarchyTtlMilliseconds);
        if (wait > 0) {
          yield* test.owner.admin.execute(sql`select pg_sleep(${wait / 1000})`, 'objects');
        }
        expect(DateTime.toEpochMillis((yield* test.owner.nativeNow()).at)).toBeGreaterThanOrEqual(end);
        expect(DateTime.toEpochMillis((yield* test.owner.nativeNow()).at)).toBeGreaterThanOrEqual(
          DateTime.toEpochMillis(p1.revalidation.validUntil),
        );
        test.setObservationWindow(extendedObservationSeconds);
        const refused = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(test.check(randomUUID())),
        );
        expect(refused.code).toBe('POLICY_ROUTE_INVALID');
        expect(yield* test.readProofs()).toEqual(proofs);
        expect(yield* test.readRequest()).toEqual(request);
        const after = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        expect(after.events).toEqual(before.events);
        expect(after.outbox).toEqual(before.outbox);
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);

it.live('component consumption rejects mismatched evidence without effects and still accepts exact P2', () =>
  Effect.scoped(
    Effect.gen(function* consumptionMismatchMatrix() {
      const test = yield* scenario('CURRENT', 60_000, true);
      const p1 = yield* test.check(randomUUID());
      yield* test.expire(p1.revalidation.validUntil);
      test.setObservationWindow(extendedObservationSeconds);
      const p2 = yield* test.check(randomUUID());
      const claim = yield* test.componentConsumptionClaim(p2.revalidation.revalidationRef);
      const proofs = yield* test.readProofs();
      const request = yield* test.readRequest();
      const before = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
      const otherBundle = yield* Schema.decodeUnknownEffect(PurchaseApprovalFinalBindingSchema)({
        ...test.binding,
        bundleRef: { ...test.binding.bundleRef, resourceId: randomUUID() },
      });
      const otherAttempt = yield* Schema.decodeUnknownEffect(PurchaseApprovalFinalBindingSchema)({
        ...test.binding,
        attemptRef: { ...test.binding.attemptRef, resourceId: randomUUID() },
      });
      const controls: readonly {
        readonly code: PurchasingApprovalRejected['code'];
        readonly label: string;
        readonly patch: Partial<ConsumePurchaseApprovalInput>;
      }[] = [
        {
          code: 'CURRENT_STATE_INDETERMINATE',
          label: 'request',
          patch: { requestRef: { ...claim.requestRef, resourceId: randomUUID() } },
        },
        {
          code: 'PERMISSION_DENIED',
          label: 'proposal',
          patch: { proposalRevisionRef: { ...claim.proposalRevisionRef, resourceId: randomUUID() } },
        },
        { code: 'PERMISSION_DENIED', label: 'Decision hash', patch: { decisionBundleHash: 'e'.repeat(64) } },
        { code: 'PERMISSION_DENIED', label: 'correlation', patch: { commitmentCorrelationId: randomUUID() } },
        {
          code: 'PERMISSION_DENIED',
          label: 'Bundle',
          patch: {
            finalBinding: otherBundle,
          },
        },
        {
          code: 'PERMISSION_DENIED',
          label: 'Attempt',
          patch: {
            finalBinding: otherAttempt,
          },
        },
        {
          code: 'PERMISSION_DENIED',
          label: 'Bundle hash',
          patch: { finalBinding: { ...test.binding, bundleHash: 'e'.repeat(64) } },
        },
        {
          code: 'PERMISSION_DENIED',
          label: 'unknown proof',
          patch: { revalidationRef: { ...p2.revalidation.revalidationRef, resourceId: randomUUID() } },
        },
        {
          code: 'PERMISSION_DENIED',
          label: 'foreign proof',
          patch: { revalidationRef: { ...p2.revalidation.revalidationRef, tenantId: randomUUID() } },
        },
        { code: 'PERMISSION_DENIED', label: 'expired P1', patch: { revalidationRef: p1.revalidation.revalidationRef } },
      ];
      for (const control of controls) {
        const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(test.consumeComponent({ ...claim, ...control.patch })),
        );
        expect(failure.code, control.label).toBe(control.code);
        expect(yield* test.readRequest(), control.label).toEqual(request);
        expect(yield* test.readProofs(), control.label).toEqual(proofs);
        const after = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        expect(after.events, control.label).toEqual(before.events);
        expect(after.outbox, control.label).toEqual(before.outbox);
      }
      const consumed = yield* test.consumeComponent(claim);
      expect(consumed.outcome).toBe('CONSUMED');
      expect(consumed.request.consumptionProofRef).toEqual(p2.revalidation.revalidationRef);
      const stored = yield* test.readRequest();
      const committed = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
      for (const patch of [
        { idempotencyKey: randomUUID() },
        { commitmentCorrelationId: randomUUID() },
        { committedAt: DateTime.add(claim.committedAt, { milliseconds: 1 }) },
      ]) {
        const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(test.consumeComponent({ ...claim, ...patch })),
        );
        expect(failure.code).toBe('COMMIT_CONFLICT');
        expect(yield* test.readRequest()).toEqual(stored);
        expect(yield* test.readProofs()).toEqual(proofs);
        const after = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        expect(after.events).toEqual(committed.events);
        expect(after.outbox).toEqual(committed.outbox);
      }
    }),
  ).pipe(Effect.provide(services)),
);

it.live('component reconciliation uses the exclusive stored P2 commitment interval after real expiry', () =>
  Effect.scoped(
    Effect.gen(function* exactCommitmentInterval() {
      const test = yield* scenario('CURRENT', 60_000, true);
      const p1 = yield* test.check(randomUUID());
      yield* test.expire(p1.revalidation.validUntil);
      const p2 = yield* test.check(randomUUID());
      const claim = yield* test.componentConsumptionClaim(p2.revalidation.revalidationRef);
      const proofs = yield* test.readProofs();
      const request = yield* test.readRequest();
      const before = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
      yield* test.expire(p2.revalidation.validUntil);
      for (const committedAt of [
        p2.revalidation.validUntil,
        DateTime.subtract(p2.revalidation.checkedAt, { milliseconds: 1 }),
      ]) {
        const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(test.consumeComponent({ ...claim, committedAt })),
        );
        expect(failure.code).toBe('PERMISSION_DENIED');
        expect(yield* test.readRequest()).toEqual(request);
        expect(yield* test.readProofs()).toEqual(proofs);
        const after = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        expect(after.events).toEqual(before.events);
        expect(after.outbox).toEqual(before.outbox);
      }
      const timelyCommitment = {
        ...claim,
        committedAt: DateTime.subtract(p2.revalidation.validUntil, { milliseconds: 1 }),
      };
      expect(DateTime.isGreaterThan(timelyCommitment.committedAt, p2.revalidation.checkedAt)).toBe(true);
      const consumed = yield* test.consumeComponent(timelyCommitment);
      expect(consumed.outcome).toBe('CONSUMED');
      expect(consumed.request.consumptionProofRef).toEqual(p2.revalidation.revalidationRef);
      const committed = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
      const replay = yield* test.consumeComponent(timelyCommitment);
      expect(replay.outcome).toBe('ALREADY_CONSUMED');
      expect(replay.request).toEqual(consumed.request);
      expect(yield* test.readProofs()).toEqual(proofs);
      const after = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
      expect(after.events).toEqual(committed.events);
      expect(after.outbox).toEqual(committed.outbox);
      expect(after.events).toHaveLength(before.events.length + 1);
      expect(after.outbox).toHaveLength(before.outbox.length + 1);
    }),
  ).pipe(Effect.provide(services)),
);

it.live('component competing proofs and Order claims consume once under concurrent registered Actions', () =>
  Effect.scoped(
    Effect.gen(function* competingConsumption() {
      const test = yield* scenario('CURRENT', 60_000, true);
      const p1 = yield* test.check(randomUUID());
      yield* test.expire(p1.revalidation.validUntil);
      test.setObservationWindow(extendedObservationSeconds);
      const p2 = yield* test.check(randomUUID());
      const p3 = yield* test.check(randomUUID());
      expect(p2.revalidation.revalidationRef).not.toEqual(p3.revalidation.revalidationRef);
      const first = yield* test.componentConsumptionClaim(p2.revalidation.revalidationRef);
      const second = yield* test.componentConsumptionClaim(p3.revalidation.revalidationRef);
      const claims = [
        first,
        { ...second, orderRef: { ...second.orderRef, resourceId: 'TEST_COMPONENT_COMPETING_ORDER' } },
      ];
      const proofs = yield* test.readProofs();
      const before = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
      const pause = yield* test.pauseAuthority();
      const entries = test.authorityEntries();
      const actionA = yield* test.consumeComponent(first).pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(pause.entered);
      const blocker = yield* pausedRegisteredBackend(test);
      const [, competingClaim] = claims;
      assert.isOk(competingClaim !== undefined);
      const actionB = yield* test.consumeComponent(competingClaim).pipe(Effect.result, Effect.forkScoped);
      yield* waitForExactBlock(test, blocker, 'TENANT');
      expect(test.authorityEntries()).toBe(entries + 1);
      yield* Deferred.succeed(pause.release, true);
      const results = yield* Effect.all([Fiber.join(actionA), Fiber.join(actionB)], { concurrency: 2 });
      expect(test.authorityEntries()).toBe(entries + 2);
      const winners = results.filter(Result.isSuccess);
      const losers = results.filter(Result.isFailure);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const [winner] = winners;
      const [loser] = losers;
      assert.isOk(winner !== undefined && loser !== undefined);
      expect(winner.success.outcome).toBe('CONSUMED');
      expect(winner.success.request.consumptionProofRef).toEqual(p2.revalidation.revalidationRef);
      expect(winner.success.request.committedOrderRef).toEqual(first.orderRef);
      const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(loser.failure);
      expect(failure.code).toBe('COMMIT_CONFLICT');
      const selected = claims.find(
        (claim) => claim.revalidationRef?.resourceId === winner.success.request.consumptionProofRef?.resourceId,
      );
      assert.isOk(selected !== undefined);
      expect(winner.success.request.committedOrderRef).toEqual(selected.orderRef);
      expect(winner.success.request.requestRevision).toBe(test.approved.request.requestRevision + 1);
      const stored = yield* test.readRequest();
      const committed = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
      expect(committed.events).toHaveLength(before.events.length + 1);
      expect(committed.outbox).toHaveLength(before.outbox.length + 1);
      const replay = yield* test.consumeComponent(selected);
      expect(replay.outcome).toBe('ALREADY_CONSUMED');
      expect(replay.request).toEqual(winner.success.request);
      expect(yield* test.readRequest()).toEqual(stored);
      expect(yield* test.readProofs()).toEqual(proofs);
      const after = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
      expect(after.events).toEqual(committed.events);
      expect(after.outbox).toEqual(committed.outbox);
    }),
  ).pipe(Effect.provide(services)),
);

it.live('rejects fresh I2 after Current source or material-value drift and preserves immutable P1', () =>
  Effect.scoped(
    Effect.gen(function* changedCurrentEvidenceRefusal() {
      const test = yield* scenario();
      const p1 = yield* test.check(randomUUID());
      yield* test.expire(p1.revalidation.validUntil);
      const proofs = yield* test.readProofs();
      const request = yield* test.readRequest();
      const before = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
      const entries = test.authorityEntries();
      const currentSourceRevisions = test.chain.sourceRevisions.filter(
        ({ source }) => source !== 'counterparty-policy' && source !== 'principal-override',
      );
      for (const source of [
        'purchase-proposal',
        'customer-commerce-policy',
        'storefront-context',
        'purchasing-profile',
      ] as const) {
        yield* test.chain.changeCurrentFacts({
          currentSourceRevisions: currentSourceRevisions.map((revision) =>
            revision.source === source ? { ...revision, revision: '2' } : revision,
          ),
          purchaseValue: test.chain.proposal.purchaseValue,
        });
        const refused = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(test.check(randomUUID())),
        );
        expect(refused.code, source).toBe('CURRENT_STATE_INDETERMINATE');
        expect(yield* test.readProofs(), source).toEqual(proofs);
        expect(yield* test.readRequest(), source).toEqual(request);
        expect(test.authorityEntries(), source).toBe(entries);
        const after = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        expect(after.events, source).toEqual(before.events);
        expect(after.outbox, source).toEqual(before.outbox);
      }
      yield* test.chain.changeCurrentFacts({
        currentSourceRevisions,
        purchaseValue: yield* Schema.decodeUnknownEffect(
          Schema.toType(PurchaseProposalRevisionSchema.fields.purchaseValue),
        )({
          ...test.chain.proposal.purchaseValue,
          monetaryAmount: { ...test.chain.proposal.purchaseValue.monetaryAmount, amount: '121' },
        }),
      });
      const material = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
        yield* Effect.flip(test.check(randomUUID())),
      );
      expect(material.code).toBe('CURRENT_STATE_INDETERMINATE');
      expect(yield* test.readProofs()).toEqual(proofs);
      expect(yield* test.readRequest()).toEqual(request);
      expect(test.authorityEntries()).toBe(entries);
      const refused = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
      expect(refused.events).toEqual(before.events);
      expect(refused.outbox).toEqual(before.outbox);
      yield* test.chain.changeCurrentFacts({
        currentSourceRevisions,
        purchaseValue: test.chain.proposal.purchaseValue,
      });
      test.setObservationWindow(extendedObservationSeconds);
      const p2 = yield* test.check(randomUUID());
      expect(p2.outcome).toBe('APPROVAL_VALID');
      expect(p2.revalidation.revalidationRef).not.toEqual(p1.revalidation.revalidationRef);
      expect(yield* test.readRequest()).toEqual(request);
      const after = yield* test.readProofs();
      expect(after).toHaveLength(2);
      for (const original of proofs) {
        expect(after.find((proof) => proof.revalidationResourceId === original.revalidationResourceId)).toEqual(
          original,
        );
      }
    }),
  ).pipe(Effect.provide(services)),
);

it.live('refuses terminal decision rewrites of an approved proof-bearing request without superseding P1', () =>
  Effect.scoped(
    Effect.gen(function* approvedLifecycleRejection() {
      const test = yield* scenario();
      const p1 = yield* test.check(randomUUID());
      yield* test.expire(p1.revalidation.validUntil);
      const proofs = yield* test.readProofs();
      const request = yield* test.readRequest();
      const before = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
      for (const decision of ['RETURN', 'REJECT'] as const) {
        const refused = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(
            test.chain.decide({
              decision,
              expectedRequestRevision: test.approved.request.requestRevision,
              idempotencyKey: randomUUID(),
              reason: 'TEST refuses rewriting an already approved request and proposal',
            }),
          ),
        );
        // The native Decision routine combines state/revision checks in pa_request_cas.
        expect(refused.code).toBe('COMMIT_CONFLICT');
        expect(refused.retryable).toBe(true);
        expect(yield* test.readProofs()).toEqual(proofs);
        expect(yield* test.readRequest()).toEqual(request);
        const after = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        expect(after.events).toEqual(before.events);
        expect(after.outbox).toEqual(before.outbox);
      }
      test.setObservationWindow(extendedObservationSeconds);
      const p2 = yield* test.check(randomUUID());
      expect(p2.outcome).toBe('APPROVAL_VALID');
      expect(p2.revalidation.revalidationRef).not.toEqual(p1.revalidation.revalidationRef);
      expect(yield* test.readRequest()).toEqual(request);
      const after = yield* test.readProofs();
      expect(after).toHaveLength(2);
      for (const original of proofs) {
        expect(after.find((proof) => proof.revalidationResourceId === original.revalidationResourceId)).toEqual(
          original,
        );
      }
    }),
  ).pipe(Effect.provide(services)),
);
