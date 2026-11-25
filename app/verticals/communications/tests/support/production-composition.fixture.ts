import { createHash } from 'node:crypto';

import {
  applicationCompositionContentRevision,
  closeApplicationCompositionDurableAdmission,
  drainApplicationCompositionAuthority,
  lockApplicationCompositionPublication,
  OntosModuleDeploymentContractSchema,
  publishApplicationCompositionAuthority,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import type { ApplicationComposition } from '@app/core-runtime';
import { ActiveApplicationCompositionSnapshotSchema } from '@app/core-runtime/modules/active-application-composition';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { eq, sql } from 'drizzle-orm';
import { Context, Effect, FileSystem, Schema } from 'effect';

import { applicationCompositionAuthority, coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import {
  layerTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';

/**
 * TEST-ONLY: the active Application Composition of the native acceptance suites. It is built from the ACTUAL Codesmith deployment
 * contracts of this workspace (Communications, Privacy's published contract, and the Portal Auth source worker's module), published
 * as the Core authority exactly as Core's own native tests publish theirs. Shared by the production HTTP suite and the
 * no-automatic-backfill scenario so both stand on the same composition.
 */
const digest = (value: string) => createHash('sha256').update(value, 'utf-8').digest('hex');

/** The Core database as the administrator role, the owner of authority publication in these native suites. */
class AdministratorCore extends Context.Service<AdministratorCore, TestDatabaseFromClient<typeof coreRelations>>()(
  '@app/communications/tests/support/AdministratorCore',
) {}

const ContractDocumentSchema = Schema.fromJsonString(OntosModuleDeploymentContractSchema);

/**
 * One composition module from the actual Codesmith deployment artifact of this workspace. Its deployment identity is the
 * release under test: these source-mode runtime layers always run as the workspace build marker, while the generator stamps
 * a promotable release marker whenever the Git tree is clean, so the approved release is pinned to the runtime's own.
 */
const publishedModule = Effect.fnUntraced(function* publishedModule(
  manifestPath: URL,
  requiredShellAbi: ApplicationComposition['modules'][number]['requiredShellAbi'],
  pinToThisRuntime: boolean,
) {
  const filesystem = yield* FileSystem.FileSystem;
  const generated = yield* Schema.decodeUnknownEffect(ContractDocumentSchema)(
    yield* filesystem.readFileString(manifestPath.pathname),
  );
  // only the release under test runs here; another module keeps the deployment its generated contract names
  const contract = pinToThisRuntime
    ? { ...generated, deployment: { ...generated.deployment, buildMarker: ultramodernDeliveryUnit.buildMarker } }
    : generated;
  const document = yield* Schema.encodeEffect(ContractDocumentSchema)(contract);
  // the composition entry is derived from the contract's own public surface, exactly as Core's published fixture does
  const { components, shellContributions } = contract.manifest.publicSurface;
  const [component] = components;
  const origin = `https://${contract.deployment.appId}.native-tests.example`;
  return {
    allowedContributions: Object.values(shellContributions).flatMap((items) =>
      items.map(({ contributionKey }) => contributionKey),
    ),
    backend: { baseUrl: `${origin}/`, transport: 'node-http' },
    contract: { sha256: digest(document), url: `${origin}/.well-known/ontos-module-manifest.json` },
    contractDocument: document,
    dependencies: (contract.manifest.requirements?.intrinsic ?? []).map(({ moduleId }) => moduleId).toSorted(),
    deployment: contract.deployment,
    federation:
      component === undefined
        ? { execution: 'server' }
        : {
            execution: 'browser',
            exposes: components.map(({ expose }) => expose),
            manifest: {
              sha256: digest(`${contract.deployment.buildMarker}-manifest`),
              url: `${origin}/releases/${contract.deployment.buildMarker}/mf-manifest.json`,
            },
            remoteName: component.mfBoundaryId,
          },
    moduleId: contract.manifest.module.id,
    publicContract: { id: contract.manifest.module.id, sha256: digest(document), version: contract.schemaVersion },
    requiredCoreCapabilities: contract.manifest.requirements?.coreCapabilities ?? [],
    requiredShellAbi,
    sharedSingletons: [],
  } satisfies ApplicationComposition['modules'][number];
});

/**
 * The active composition with the actual Communications deployment and Privacy's actual published contract (both generated
 * by this package's `test:integration` script), published as the Core authority and served. Privacy is an approved release
 * only (no Privacy process runs here), so a Privacy-delegated assertion names a real calling module and Communications'
 * conditional requirement to report to Privacy resolves against Privacy's genuine `record-owner-execution-outcome` contract.
 */
export const publishComposition = Effect.fnUntraced(function* publishComposition() {
  const base = yield* makeApplicationCompositionSnapshotFixture([]);
  const { contributionAbi } = base.composition.shell;
  const privacy = yield* publishedModule(
    new URL('../../../privacy/dist/public/.well-known/ontos-module-manifest.json', import.meta.url),
    contributionAbi,
    false,
  );
  const communications = yield* publishedModule(
    new URL('../../dist/public/.well-known/ontos-module-manifest.json', import.meta.url),
    contributionAbi,
    true,
  );
  // the registered source worker of Portal Auth (`commerce-customer-context`) is an approved release of the composition, so a
  // Shell-signed workload assertion naming it as its source resolves against its genuine published contract
  const customerContext = yield* publishedModule(
    new URL('../../../commerce-customer-context/dist/public/.well-known/ontos-module-manifest.json', import.meta.url),
    contributionAbi,
    false,
  );
  const modules = [...base.composition.modules, privacy, communications, customerContext];
  // the receiving Shell offers every Core capability the composed contracts require (Privacy's dependency contracts)
  const coreCapabilities = [
    ...new Map(
      modules
        .flatMap(({ requiredCoreCapabilities }) => requiredCoreCapabilities)
        .map((entry) => [entry.id, entry] as const),
    ).values(),
  ];
  const input = { ...base.composition, modules, shell: { ...base.composition.shell, coreCapabilities } };
  const snapshot = yield* validateActiveApplicationCompositionSnapshot({
    composition: { ...input, revision: yield* applicationCompositionContentRevision(input) },
    observedAt: base.observedAt,
    validUntil: base.validUntil,
  });
  const { admin } = yield* testDatabaseClients;
  const core = yield* AdministratorCore.pipe(
    Effect.provide(layerTestDatabaseFromClient(AdministratorCore, admin, coreRelations)),
  );
  yield* core.transaction((transaction) =>
    Effect.gen(function* publish() {
      yield* lockApplicationCompositionPublication(transaction);
      const [predecessor] = yield* transaction
        .select({ revision: applicationCompositionAuthority.revision })
        .from(applicationCompositionAuthority)
        .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
      if (predecessor !== undefined && predecessor.revision !== snapshot.composition.revision) {
        yield* closeApplicationCompositionDurableAdmission(transaction, predecessor.revision);
        yield* drainApplicationCompositionAuthority(transaction, predecessor.revision);
      }
      yield* publishApplicationCompositionAuthority(transaction, snapshot);
    }),
  );
  const document = yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
    snapshot,
  );
  return { core, document, snapshot };
});

export const activateCommunications = (
  core: Effect.Success<ReturnType<typeof publishComposition>>['core'],
  tenantId: string,
) =>
  core.transaction((transaction) =>
    transaction.execute(
      sql`insert into core.tenant_module_states (tenant_id, module_key, state)
          values (${tenantId}::uuid, 'communications.core', 'active')
          on conflict (tenant_id, module_key) do update set state = excluded.state`,
      'objects',
    ),
  );
