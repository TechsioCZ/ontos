import { consumePurchaseApprovalAction } from '../../src/actions/consume-purchase-approval.action.ts';
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
  PurchasingApprovalRejected,
  RevalidatePurchaseApprovalInputSchema,
} from '../../shared/domain/purchasing-approval.ts';
import type {
  ConsumePurchaseApprovalInput,
  PurchaseApprovalRequest,
  RevalidatePurchaseApprovalInput,
  TrustedRevalidatePurchaseApprovalInput,
} from '../../shared/domain/purchasing-approval.ts';
import { revalidatePurchaseApprovalAction } from '../../src/actions/revalidate-purchase-approval.action.ts';
import { makeEnrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';
import { nativeTestDatabaseContainer } from '../support/native-test-database.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { makePurchasingApprovalNativeFixture } from '../support/purchasing-approval-native.ts';
import { createHash, randomUUID } from 'node:crypto';
import { ActionRuntime, loadDatabaseConnectionPair } from '@app/core-runtime';
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
  Schema,
  Stream,
} from 'effect';
import { ChildProcess } from 'effect/process';
import { Reactivity } from 'effect/reactivity';
import { assert, expect } from 'effect-rstest';
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
export const initialObservationSeconds = 5;
export const extendedObservationSeconds = 15;

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
const approvalFreshJournalReceipt = Effect.fn('ApprovalFreshProofTests.journalReceipt')(
  (connection: MigrationConnection, owner: 'core' | 'commerce_customer_context') =>
    Effect.scoped(
      Effect.gen(function* receipt() {
        const client = yield* PgClient.make({ url: Redacted.make(connection.connectionString) }).pipe(
          Effect.provide(Reactivity.layer),
        );
        const admin = yield* makeWithDefaults({ relations: commerceCustomerContextRelations }).pipe(
          Effect.provideService(PgClient.PgClient, client),
        );
        const table = sql.identifier(
          owner === 'core' ? '__drizzle_migrations_core' : '__drizzle_migrations_commerce_customer_context',
        );
        return yield* admin.transaction(
          Effect.fn('ApprovalFreshProofTests.readJournal')(function* readJournal(transaction) {
            yield* transaction.execute(sql`set local time zone 'UTC'`, 'objects');
            const [row] = yield* transaction.execute<{ readonly receipt: unknown }>(
              sql`select json_build_object('count', count(*)::integer, 'digest',
                md5(coalesce(jsonb_agg(to_jsonb(journal) order by to_jsonb(journal)::text)::text,'[]'))) as receipt
                from drizzle.${table} journal`,
              'objects',
            );
            return yield* Schema.decodeUnknownEffect(MigrationReceiptSchema)(row?.receipt);
          }),
        );
      }),
    ),
);
const copyApprovalFreshMigrationJournal = Effect.fn('ApprovalFreshProofTests.copyMigrationJournal')(function* copy(
  source: MigrationConnection,
  target: MigrationConnection,
  owner: 'core' | 'commerce_customer_context',
) {
  const before = yield* approvalFreshJournalReceipt(source, owner);
  expect((yield* approvalFreshJournalReceipt(target, owner)).count).toBe(0);
  const table =
    owner === 'core' ? 'drizzle.__drizzle_migrations_core' : 'drizzle.__drizzle_migrations_commerce_customer_context';
  // The suite runs pg_dump/psql only inside the database container this run owns.
  const container = yield* nativeTestDatabaseContainer;
  const dump = yield* ChildProcess.make(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      'PGPASSWORD',
      container,
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
      container,
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
      '--single-transaction',
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
  // Execute the package scripts' actual entrypoints in the inherited mise runtime. Repeated
  // pnpm workspace discovery is not part of the migration proof and dominated fixture setup.
  const ownerDirectory = new URL(owner === 'core' ? '../../../../packages/core-runtime/' : '../../', import.meta.url)
    .pathname;
  const drizzleMigration = owner === 'commerce_customer_context' && command === 'migrate';
  const executable = drizzleMigration
    ? new URL('../../node_modules/.bin/drizzle-kit', import.meta.url).pathname
    : process.execPath;
  let args: readonly string[];
  if (drizzleMigration) {
    args = ['migrate', '--config', configuration];
  } else if (owner !== 'core') {
    args = ['scripts/verify-db-schema.mts'];
  } else if (command === 'migrate') {
    args = ['../../scripts/migration-convergence-cli.mts', 'core'];
  } else {
    args = ['../../scripts/verify-core-db-schema.mts'];
  }
  const child = yield* ChildProcess.make(executable, args, {
    cwd: ownerDirectory,
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

export const services = NodeChildProcessSpawner.layer.pipe(
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
export const scenario = Effect.fn('ApprovalFreshProofTests.scenario')(function* scenario(
  state: ClockMigrationState = 'CURRENT',
  requestTtlMilliseconds = 60_000,
  orderModule = false,
  hierarchyTtlMilliseconds?: number,
  orderBinding = false,
) {
  // Order consumes as the calling module, so its release must name Order for the Shell to sign it as the actor.
  const snapshot = yield* makeEnrollmentApplicationCompositionSnapshot(
    ultramodernApiMarker.buildMarker,
    orderModule === true || orderBinding === true ? ['commerce-order'] : [],
  );
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: snapshot,
    // Core's db:verify below checks the trust catalog against the provisioned gateway audiences.
    databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
    mode: 'schema-only',
    purpose: 'stabilization-1257-approval-fresh-proof',
    sourceConnections: yield* loadDatabaseConnectionPair(),
  });
  yield* applyApprovalFreshProfileCurrentMigrations(isolated.connections, state);
  const owner = yield* makePurchasingApprovalNativeFixture({
    connections: isolated.connections,
    finalProofTest: true,
    snapshot,
  });
  const chain = yield* owner.createRequest({ hierarchyTtlMilliseconds, ttlMilliseconds: requestTtlMilliseconds });
  const approved = yield* chain.decide();
  expect(approved.request.status).toBe('APPROVED');
  const binding = yield* Schema.decodeUnknownEffect(PurchaseApprovalFinalBindingSchema)({
    attemptRef: {
      moduleId: orderBinding === true ? 'commerce.order' : 'test.approval-final-owner',
      resourceId: randomUUID(),
      resourceType: orderBinding === true ? 'commerce.order.commitment-attempt' : 'test.approval-final-owner.attempt',
      tenantId: owner.tenantId,
    },
    bundleHash: 'd'.repeat(64),
    bundleRef: {
      moduleId: orderBinding === true ? 'commerce.order' : 'test.approval-final-owner',
      resourceId: randomUUID(),
      resourceType: orderBinding === true ? 'commerce.order.acceptance-bundle' : 'test.approval-final-owner.bundle',
      tenantId: owner.tenantId,
    },
    bundleVersion: orderBinding === true ? 'order-acceptance-bundle.v1' : 'TEST_APPROVAL_FINAL_BUNDLE.v1',
  });
  const correlation = randomUUID();
  let eligible = true;
  let observationSeconds: typeof initialObservationSeconds | typeof extendedObservationSeconds =
    initialObservationSeconds;
  let authorityEntries = 0;
  const authorityPauses: {
    readonly entered: Deferred.Deferred<boolean>;
    readonly release: Deferred.Deferred<boolean>;
  }[] = [];
  const awaitAuthorityPause = Effect.fn('ApprovalFreshProofTests.awaitAuthorityPause')(function* awaitAuthorityPause() {
    const pause = authorityPauses.shift();
    if (pause !== undefined) {
      yield* Deferred.succeed(pause.entered, true);
      yield* Deferred.await(pause.release);
    }
  });
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
          scope.trustedStorefrontId !== owner.storefrontId ||
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
        yield* awaitAuthorityPause();
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
  // The buyer is the verified subject; `orderActor` false is the buyer calling without the Order module.
  const consumeComponent = (input: ConsumePurchaseApprovalInput, orderActor = true) =>
    Effect.gen(function* consumeRegisteredComponent() {
      return yield* Context.get(context, ActionRuntime).runAction({
        payload: yield* Schema.encodeEffect(consumePurchaseApprovalAction.descriptor.payloadSchema)(input),
        principal: orderActor
          ? yield* owner.authenticatedPrincipal(owner.fixture.manager, 'commerce-order')
          : yield* owner.authenticatedPrincipal(owner.fixture.manager),
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
              yield* awaitAuthorityPause();
              const at = yield* owner.observationNow();
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
    correlation,
    directReplay,
    expire,
    owner,
    pauseAuthority: () =>
      Effect.gen(function* installTestAuthorityBarrier() {
        const entered = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();
        yield* Effect.addFinalizer(() => Deferred.succeed(release, true).pipe(Effect.asVoid));
        const pause = { entered, release };
        authorityPauses.push(pause);
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
    snapshot,
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

type FreshProofScenario = Effect.Success<ReturnType<typeof scenario>>;
export const holdGenuineRequest = (test: FreshProofScenario) =>
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

export const waitForExactBlock = (
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

/** Each scenario owns an isolated database; with all Actions at authority barriers, no client transaction remains. */
export const assertNoOpenActionTransaction = (test: FreshProofScenario) =>
  Effect.gen(function* noActionSqlDuringAuthorityRead() {
    const rows = yield* test.owner.admin.execute<{ pid: number; query: string; state: string }>(
      sql`select pid, query, state from pg_stat_activity
        where datname=current_database() and backend_type='client backend'
          and (xact_start is not null or state in ('idle in transaction', 'idle in transaction (aborted)'))
          and pid<>pg_backend_pid()`,
      'objects',
    );
    expect(rows).toEqual([]);
  });

export const awaitPausedAuthority = <Value, Failure>(
  pause: { readonly entered: Deferred.Deferred<boolean> },
  action: Fiber.Fiber<Value, Failure>,
) =>
  Effect.raceFirst(
    Deferred.await(pause.entered),
    Fiber.join(action).pipe(
      Effect.flatMap((result) =>
        Effect.die({ reason: 'The Action completed before reaching its authority barrier', result }),
      ),
    ),
  );

/** Test-owned lock acquired only after both Actions have released SQL and entered remote preparation. */
export const holdGenuineTenant = (test: FreshProofScenario) =>
  Effect.gen(function* holdOnlyOwnedTenant() {
    const held = yield* Deferred.make<number>();
    const release = yield* Deferred.make<boolean>();
    yield* Effect.addFinalizer(() => Deferred.succeed(release, true).pipe(Effect.asVoid));
    const holder = yield* test.owner.admin
      .transaction((transaction) =>
        Effect.gen(function* independentTenantHolder() {
          const rows = yield* transaction.execute<{ pid: number; tenantId: string }>(
            sql`select pg_backend_pid() as pid, tenant_id as "tenantId" from core.tenants
          where tenant_id=${test.owner.tenantId}::uuid for update`,
            'objects',
          );
          expect(rows).toHaveLength(1);
          const [row] = rows;
          assert.isOk(row !== undefined);
          expect(row.tenantId).toBe(test.owner.tenantId);
          yield* Deferred.succeed(held, row.pid);
          yield* Deferred.await(release);
        }),
      )
      .pipe(Effect.forkScoped);
    const blocker = yield* Effect.raceFirst(
      Deferred.await(held),
      Fiber.join(holder).pipe(Effect.andThen(Effect.die('The test Tenant holder exited before acquiring its row'))),
    );
    return { blocker, holder, release };
  });
