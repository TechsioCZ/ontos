import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Cause, Effect, Exit, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { hashAuthorizationEvidence } from '../check-authorization-readiness.mts';
import {
  planDeploymentImpact as planDeploymentImpactEffect,
  validateAuthorizationPromotionGate,
} from '../plan-deployment-impact.mts';
import type { AuthorizationPromotionGateInput, PlanDeploymentImpactOptions } from '../plan-deployment-impact.mts';
import {
  findStageDeploymentBase,
  resolveStageDeploymentBase,
  StatusPagesJsonSchema,
} from '../resolve-stage-deployment-base.mts';
import type { StageDeploymentSource } from '../resolve-stage-deployment-base.mts';

const planningFailure = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.exit,
    Effect.map(
      Exit.match({
        onFailure: Cause.pretty,
        onSuccess: () => {
          throw new Error('Expected planning failure');
        },
      }),
    ),
  );

interface FixtureOptions {
  readonly cloudflareBuildEnvironment?: Readonly<Record<string, string>>;
  readonly cloudflarePlacement?: readonly string[];
  readonly cloudflareRetiredWorkers?: readonly string[];
  readonly cloudflareUnitServiceBindings?: Readonly<Record<string, readonly string[]>>;
  readonly extraSharedPackages?: readonly FixtureOwner[];
  /** A second vertical, ordered before the first by id, with its own owner, project and setup. */
  readonly extraVerticalId?: string;
  readonly includeContactOwner?: boolean;
  readonly includeWorker?: boolean;
  readonly omitVerticalWorkerName?: boolean;
  readonly setupIds?: readonly string[];
  readonly shellVerticalRefs?: readonly string[];
  readonly verticalId?: string;
}

interface FixtureOwner {
  readonly id: string;
  readonly package: string;
  readonly path: string;
}

interface FixtureOwnership {
  readonly owners: readonly FixtureOwner[];
  readonly schemaVersion?: number;
}

interface FixtureTopology {
  readonly schemaVersion: number;
  readonly sharedPackages: readonly FixtureOwner[];
  readonly shell: {
    readonly cloudflare: { readonly workerName: string };
    readonly id: string;
    readonly package: string;
    readonly verticalRefs: readonly string[];
  };
  readonly verticals: readonly {
    readonly cloudflare?: { readonly workerName: string };
    readonly id: string;
    readonly moduleFederation: {
      readonly remotes: readonly string[];
      readonly verticalRefs: readonly string[];
    };
    readonly package: string;
    readonly path: string;
  }[];
}

interface FixtureCloudflarePlacement {
  readonly buildEnvironment: Readonly<Record<string, string>>;
  readonly retiredWorkers: readonly string[];
  readonly schemaVersion: 1;
  readonly units: readonly string[];
  readonly unitServiceBindings?: Readonly<Record<string, readonly string[]>>;
}

type FixtureDocument = FixtureCloudflarePlacement | FixtureOwnership | FixtureTopology;

const CORE_RUNTIME_OWNER = {
  id: 'core-runtime',
  package: '@app/core-runtime',
  path: 'packages/core-runtime',
} as const satisfies FixtureOwner;
const SHARED_CONTRACTS_OWNER = {
  id: 'shared-contracts',
  package: '@app/shared-contracts',
  path: 'packages/shared-contracts',
} as const satisfies FixtureOwner;
const SHELL_ID = 'shell-super-app';
const SHELL_PACKAGE = '@app/shell-super-app';
const SHELL_WORKER = 'app-shell-super-app';
const CONTACTS_WORKER = 'app-contacts';
const SHELL_OWNER = {
  id: SHELL_ID,
  package: SHELL_PACKAGE,
  path: 'apps/shell-super-app',
} as const satisfies FixtureOwner;
const CLOUDFLARE_PLACEMENT_PATH = 'topology/cloudflare-placement.json';
const OWNERSHIP_PATH = 'topology/ownership.json';
const TOPOLOGY_PATH = 'topology/reference-topology.json';
const WORKSPACE_MANIFEST_PATH = 'pnpm-workspace.yaml';
const DOCUMENTATION_PATH = 'docs/README.md';
const SHARED_CONTRACT_PATH = 'packages/shared-contracts/src/gateway-context.ts';

const planDeploymentImpact = (options: PlanDeploymentImpactOptions) =>
  planDeploymentImpactEffect(options).pipe(Effect.provide(NodeServices.layer));

const writeJson = (root: string, relativePath: string, value: FixtureDocument) =>
  Effect.gen(function* testEffect1() {
    const target = path.join(root, relativePath);
    yield* Effect.tryPromise(() => mkdir(path.dirname(target), { recursive: true }));
    yield* Effect.tryPromise(() => writeFile(target, `${JSON.stringify(value, undefined, 2)}\n`, 'utf-8'));
  });

const writeWorkspaceProject = (root: string, owner: FixtureOwner) =>
  Effect.gen(function* writeWorkspaceProjectEffect() {
    const projectRoot = path.join(root, owner.path);
    yield* Effect.tryPromise(() => mkdir(projectRoot, { recursive: true }));
    yield* Effect.tryPromise(() =>
      writeFile(path.join(projectRoot, 'package.json'), `${JSON.stringify({ name: owner.package })}\n`, 'utf-8'),
    );
  });

const makeFixture = (options: FixtureOptions = {}) =>
  Effect.gen(function* testEffect2() {
    const root = yield* Effect.acquireRelease(
      Effect.tryPromise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-deployment-impact-'))),
      (directory) => Effect.tryPromise(() => rm(directory, { force: true, recursive: true })).pipe(Effect.orDie),
    );
    const verticalId = options.verticalId ?? 'contacts';
    const verticalPackage = `@app/${verticalId}`;
    const verticalPath = `verticals/${verticalId}`;
    const vertical: FixtureTopology['verticals'][number] = {
      id: verticalId,
      moduleFederation: { remotes: [], verticalRefs: [] },
      package: verticalPackage,
      path: verticalPath,
    };
    yield* writeJson(root, TOPOLOGY_PATH, {
      schemaVersion: 1,
      sharedPackages: [CORE_RUNTIME_OWNER, SHARED_CONTRACTS_OWNER, ...(options.extraSharedPackages ?? [])],
      shell: {
        cloudflare: { workerName: SHELL_WORKER },
        id: SHELL_ID,
        package: SHELL_PACKAGE,
        verticalRefs: options.shellVerticalRefs ?? [verticalId],
      },
      verticals: [
        options.omitVerticalWorkerName === true
          ? vertical
          : { ...vertical, cloudflare: { workerName: `app-${verticalId}` } },
        ...(options.extraVerticalId === undefined
          ? []
          : [
              {
                cloudflare: { workerName: `app-${options.extraVerticalId}` },
                id: options.extraVerticalId,
                moduleFederation: { remotes: [], verticalRefs: [] },
                package: `@app/${options.extraVerticalId}`,
                path: `verticals/${options.extraVerticalId}`,
              },
            ]),
      ],
    });
    const extraVerticalOwners =
      options.extraVerticalId === undefined
        ? []
        : [
            {
              id: options.extraVerticalId,
              package: `@app/${options.extraVerticalId}`,
              path: `verticals/${options.extraVerticalId}`,
            },
          ];
    const placement: FixtureCloudflarePlacement = {
      buildEnvironment: options.cloudflareBuildEnvironment ?? {},
      retiredWorkers: options.cloudflareRetiredWorkers ?? [],
      schemaVersion: 1,
      units: options.cloudflarePlacement ?? [],
    };
    yield* writeJson(
      root,
      CLOUDFLARE_PLACEMENT_PATH,
      options.cloudflareUnitServiceBindings === undefined
        ? placement
        : { ...placement, unitServiceBindings: options.cloudflareUnitServiceBindings },
    );
    yield* writeJson(root, OWNERSHIP_PATH, {
      owners: [
        CORE_RUNTIME_OWNER,
        SHARED_CONTRACTS_OWNER,
        SHELL_OWNER,
        ...(options.extraSharedPackages ?? []),
        ...(options.includeContactOwner === false
          ? []
          : [{ id: verticalId, package: verticalPackage, path: verticalPath }]),
        ...extraVerticalOwners,
      ],
      schemaVersion: 1,
    });
    yield* Effect.tryPromise(() =>
      writeFile(
        path.join(root, WORKSPACE_MANIFEST_PATH),
        'packages:\n  - \'apps/*\'\n  - verticals/*\n  - "packages/*"\nminimumReleaseAge: 1440\n',
        'utf-8',
      ),
    );
    for (const owner of [CORE_RUNTIME_OWNER, SHARED_CONTRACTS_OWNER, SHELL_OWNER]) {
      yield* writeWorkspaceProject(root, owner);
    }
    yield* writeWorkspaceProject(root, { id: verticalId, package: verticalPackage, path: verticalPath });
    for (const owner of extraVerticalOwners) {
      yield* writeWorkspaceProject(root, owner);
    }
    if (options.includeWorker === true) {
      const workerRoot = path.join(root, verticalPath);
      yield* Effect.tryPromise(() => mkdir(path.join(workerRoot, 'src/worker-host'), { recursive: true }));
      yield* Effect.tryPromise(() =>
        writeFile(
          path.join(workerRoot, 'package.json'),
          `${JSON.stringify({ name: verticalPackage, scripts: { 'worker:start': 'node --experimental-strip-types ./src/worker-host/main.ts' } })}\n`,
        ),
      );
      yield* Effect.tryPromise(() =>
        writeFile(
          path.join(workerRoot, 'src/worker-host/main.ts'),
          '// @generated by scaffold:outbox-worker worker-host\n',
        ),
      );
    }
    const setups = options.setupIds ?? [
      'migrator',
      'spicedb',
      verticalId,
      ...(options.extraVerticalId === undefined ? [] : [options.extraVerticalId]),
      ...(options.includeWorker === true ? [`${verticalId}-worker`] : []),
      'shellsuperapp',
    ];
    const setupLines = setups.map((setup) => `  - setup: '${setup}'`).join('\n');
    yield* Effect.tryPromise(() => writeFile(path.join(root, 'zerops.yaml'), `zerops:\n${setupLines}\n`, 'utf-8'));
    return root;
  });

const withFixture = (run: (root: string) => Effect.Effect<void, unknown>, options?: FixtureOptions) =>
  Effect.gen(function* testEffect3() {
    const root = yield* makeFixture(options);
    yield* run(root);
  }).pipe(Effect.scoped);

for (const termination of ['failure', 'interruption'] as const) {
  it.live(`removes the fixture after ${termination}`, () =>
    Effect.gen(function* verifiesFixtureCleanup() {
      let fixtureRoot = '';
      const outcome = yield* withFixture((root) => {
        fixtureRoot = root;
        return termination === 'failure' ? Effect.fail('fixture failure') : Effect.interrupt;
      }).pipe(Effect.exit);
      expect(Exit.isFailure(outcome)).toBe(true);
      expect(fixtureRoot).not.toBe('');
      const remaining = yield* Effect.tryPromise(() => access(fixtureRoot)).pipe(Effect.exit);
      expect(Exit.isFailure(remaining)).toBe(true);
    }),
  );
}

it.live('deploys a generated owner worker immediately after its provider', () =>
  Effect.gen(function* testEffect4() {
    yield* withFixture(
      (root) =>
        Effect.gen(function* testEffect5() {
          const plan = yield* planDeploymentImpact({
            changedPaths: ['verticals/contacts/src/workers/project-contact.worker.ts'],
            rootDirectory: root,
          });
          expect(plan.units.providers).toEqual(['contacts', 'contacts-worker']);
          expect(plan.phases.map((phase) => phase.id)).toEqual(['contacts', 'contacts-worker']);
          expect(plan.phases[1]?.serviceIdEnv).toBe('ZEROPS_CONTACTS_WORKER_SERVICE_ID');
        }),
      { includeWorker: true },
    );
  }),
);

const runGit = (root: string, argumentsList: readonly string[]): string =>
  execFileSync(
    '/usr/bin/git',
    ['-c', 'user.email=ontos-ci@example.invalid', '-c', 'user.name=OntOS CI', ...argumentsList],
    {
      cwd: root,
      encoding: 'utf-8',
    },
  ).trim();

it.live('plans current Contacts owner-local changes without a hard-coded owner registry', () =>
  Effect.gen(function* testEffect6() {
    yield* withFixture((root) =>
      Effect.gen(function* testEffect7() {
        const plan = yield* planDeploymentImpact({
          changedPaths: ['app/verticals/contacts/src/features/customers/customer-form.tsx'],
          rootDirectory: root,
        });
        expect(plan.units).toEqual({
          cloudflare: [],
          cloudflareRetirements: [],
          migrator: false,
          providers: ['contacts'],
          shell: false,
          spicedb: false,
        });
        expect(plan.phases.map((phase) => phase.id)).toEqual(['contacts']);
      }),
    );
  }),
);

it.live('orders authorization schema and replay migration before every affected consumer', () =>
  Effect.gen(function* testEffect8() {
    yield* withFixture((root) =>
      Effect.gen(function* testEffect9() {
        const plan = yield* planDeploymentImpact({
          changedPaths: ['app/scripts/authorization/rollout-contract.mts'],
          rootDirectory: root,
        });
        expect(plan.phases.map(({ id }) => id)).toEqual(['migrator', 'spicedb', 'contacts', SHELL_ID]);
      }),
    );
  }),
);

it.live('plans Shell-only changes for the topology-derived Shell owner', () =>
  Effect.gen(function* testEffect10() {
    yield* withFixture((root) =>
      Effect.gen(function* testEffect11() {
        const plan = yield* planDeploymentImpact({
          changedPaths: ['apps/shell-super-app/src/routes/shell-frame.tsx'],
          rootDirectory: root,
        });
        expect(plan.phases.map((phase) => phase.id)).toEqual([SHELL_ID]);
        expect(plan.units.shell).toBe(true);
      }),
    );
  }),
);

it.live('adds the migrator before an owner whose schema or migration contract changed', () =>
  Effect.gen(function* testEffect12() {
    yield* withFixture((root) =>
      Effect.gen(function* testEffect13() {
        const plan = yield* planDeploymentImpact({
          changedPaths: ['verticals/contacts/drizzle/0003_add_customer.sql'],
          rootDirectory: root,
        });
        expect(plan.phases.map((phase) => phase.id)).toEqual(['migrator', 'contacts']);
      }),
    );
  }),
);

for (const changedPath of [
  'scripts/run-zerops-migrator.mjs',
  'scripts/verify-application-db-schema.mts',
  'scripts/postgres/bootstrap-runtime-role.mts',
]) {
  it.live(`includes the migrator for root migration contract ${changedPath}`, () =>
    Effect.gen(function* testEffect14() {
      yield* withFixture((root) =>
        Effect.gen(function* testEffect15() {
          const plan = yield* planDeploymentImpact({
            changedPaths: [changedPath],
            rootDirectory: root,
          });
          expect(plan.phases.map((phase) => phase.id)).toEqual(['migrator']);
        }),
      );
    }),
  );
}

it.live('expands shared-package changes to every consumer in dependency order', () =>
  Effect.gen(function* testEffect18() {
    yield* withFixture((root) =>
      Effect.gen(function* testEffect19() {
        const plan = yield* planDeploymentImpact({
          changedPaths: [SHARED_CONTRACT_PATH],
          rootDirectory: root,
        });
        expect(plan.phases.map((phase) => phase.id)).toEqual(['contacts', SHELL_ID]);
      }),
    );
  }),
);

it.live('deploys placed Cloudflare units that are impacted, providers before the Shell', () =>
  Effect.gen(function* plansCloudflareDeployments() {
    yield* withFixture(
      (root) =>
        Effect.gen(function* plansCloudflareDeploymentsInFixture() {
          const shared = yield* planDeploymentImpact({
            changedPaths: [SHARED_CONTRACT_PATH],
            rootDirectory: root,
          });
          expect(shared.units.cloudflare).toEqual([
            { id: 'contacts', packageName: '@app/contacts', workerName: CONTACTS_WORKER },
            { id: SHELL_ID, packageName: SHELL_PACKAGE, workerName: SHELL_WORKER },
          ]);
          const shellOnly = yield* planDeploymentImpact({
            changedPaths: ['apps/shell-super-app/src/routes/page.tsx'],
            rootDirectory: root,
          });
          expect(shellOnly.units.cloudflare.map(({ id }) => id)).toEqual([SHELL_ID]);
        }),
      { cloudflarePlacement: [SHELL_ID, 'contacts'] },
    );
  }),
);

it.live('replans every placed unit when the edge deploy workflow changes', () =>
  Effect.gen(function* replansPlacedUnitsForDeployInputs() {
    yield* withFixture(
      (root) =>
        Effect.gen(function* replansPlacedUnitsForDeployInputsInFixture() {
          for (const changedPath of [
            '.github/workflows/ultramodern-workspace-gates.yml',
            '.github/actions/install-app/action.yml',
          ]) {
            const plan = yield* planDeploymentImpact({ changedPaths: [changedPath], rootDirectory: root });
            expect(plan.units.cloudflare.map(({ id }) => id)).toEqual(['contacts']);
            expect(plan.phases).toEqual([]);
          }
        }),
      { cloudflarePlacement: ['contacts'] },
    );
  }),
);

it.live('replans every unit, on Zerops and the edge, when the planner itself changes', () =>
  Effect.gen(function* replansEverythingForPlannerChanges() {
    yield* withFixture(
      (root) =>
        Effect.gen(function* replansEverythingForPlannerChangesInFixture() {
          const plan = yield* planDeploymentImpact({
            changedPaths: ['scripts/plan-deployment-impact.mts'],
            rootDirectory: root,
          });
          expect(plan.units.cloudflare.map(({ id }) => id)).toEqual(['contacts', SHELL_ID]);
          expect(plan.phases.map((phase) => phase.id)).toEqual(['migrator', 'spicedb', 'contacts', SHELL_ID]);
        }),
      { cloudflarePlacement: [SHELL_ID, 'contacts'] },
    );
  }),
);

it.live('replans every placed unit when the edge build environment changes', () =>
  Effect.gen(function* replansPlacedUnitsForBuildEnvironment() {
    yield* withFixture(
      (root) =>
        Effect.gen(function* replansPlacedUnitsForBuildEnvironmentInFixture() {
          const plan = yield* planDeploymentImpact({ changedPaths: [CLOUDFLARE_PLACEMENT_PATH], rootDirectory: root });
          expect(plan.units.cloudflare.map(({ id }) => id)).toEqual(['contacts']);
        }),
      {
        cloudflareBuildEnvironment: { ULTRAMODERN_MF_DEV_ORIGIN: 'https://stage.example.test' },
        cloudflarePlacement: ['contacts'],
      },
    );
  }),
);

it.live('fails closed for an edge build variable the Cloudflare builds do not read', () =>
  Effect.gen(function* failsClosedForForeignBuildVariable() {
    yield* withFixture(
      (root) =>
        Effect.gen(function* failsClosedForForeignBuildVariableInFixture() {
          expect(
            yield* planningFailure(planDeploymentImpact({ changedPaths: [DOCUMENTATION_PATH], rootDirectory: root })),
          ).toMatch(/buildEnvironment key "CLOUDFLARE_API_TOKEN" must be a MODERN_, ULTRAMODERN_ or VERTICAL_ build/u);
        }),
      { cloudflareBuildEnvironment: { CLOUDFLARE_API_TOKEN: 'leaked' }, cloudflarePlacement: ['contacts'] },
    );
  }),
);

it.live('fails closed when edge build configuration overrides the run or Worker identity', () =>
  Effect.gen(function* failsClosedForReservedBuildVariables() {
    for (const key of [
      'ULTRAMODERN_SOURCE_REVISION',
      'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT',
      'VERTICAL_PRICING_WORKER_NAME',
    ]) {
      yield* withFixture(
        (root) =>
          Effect.gen(function* failsClosedForReservedBuildVariableInFixture() {
            expect(
              yield* planningFailure(planDeploymentImpact({ changedPaths: [DOCUMENTATION_PATH], rootDirectory: root })),
            ).toContain(`buildEnvironment must not set "${key}"`);
          }),
        { cloudflareBuildEnvironment: { [key]: 'forged' }, cloudflarePlacement: ['contacts'] },
      );
    }
  }),
);

const commitPlacement = (
  root: string,
  placement: readonly string[],
  retiredWorkers: readonly string[],
  message: string,
) =>
  Effect.gen(function* commitPlacementEffect() {
    yield* writeJson(root, CLOUDFLARE_PLACEMENT_PATH, {
      buildEnvironment: {},
      retiredWorkers,
      schemaVersion: 1,
      units: placement,
    });
    runGit(root, ['add', '.']);
    runGit(root, ['commit', '-m', message]);
    return runGit(root, ['rev-parse', 'HEAD']);
  });

it.live('refuses to drop a deployed Worker from placement until it is listed for retirement', () =>
  Effect.gen(function* retiresRemovedWorkers() {
    yield* withFixture(
      (root) =>
        Effect.gen(function* retiresRemovedWorkersInFixture() {
          runGit(root, ['init']);
          runGit(root, ['add', '.']);
          runGit(root, ['commit', '-m', 'contacts and Shell on the edge']);
          const deployed = runGit(root, ['rev-parse', 'HEAD']);
          const dropped = yield* commitPlacement(root, ['contacts'], [], 'drop the Shell');
          expect(
            yield* planningFailure(
              planDeploymentImpact({ baseRevision: deployed, headRevision: dropped, rootDirectory: root }),
            ),
          ).toContain(`no longer places or retires Worker "${SHELL_WORKER}"; keep it in retiredWorkers`);
          // A full plan of the same head still reconciles against the last edge deployment.
          expect(
            yield* planningFailure(
              planDeploymentImpact({ headRevision: dropped, placementBaseRevision: deployed, rootDirectory: root }),
            ),
          ).toContain(`no longer places or retires Worker "${SHELL_WORKER}"`);
          const retired = yield* commitPlacement(root, ['contacts'], [SHELL_WORKER], 'retire the Shell');
          const plan = yield* planDeploymentImpact({
            baseRevision: deployed,
            headRevision: retired,
            rootDirectory: root,
          });
          expect(plan.units.cloudflareRetirements).toEqual([{ packageName: SHELL_PACKAGE, workerName: SHELL_WORKER }]);
          // The ledger carries forward: a later placement cannot forget a retired Worker.
          const forgotten = yield* commitPlacement(root, ['contacts'], [], 'forget the retired Shell');
          expect(
            yield* planningFailure(
              planDeploymentImpact({ baseRevision: retired, headRevision: forgotten, rootDirectory: root }),
            ),
          ).toContain(`no longer places or retires Worker "${SHELL_WORKER}"`);
          // A Worker still placed cannot also be retired.
          const contradictory = yield* commitPlacement(root, ['contacts'], [CONTACTS_WORKER], 'retire contacts');
          expect(
            yield* planningFailure(
              planDeploymentImpact({ baseRevision: retired, headRevision: contradictory, rootDirectory: root }),
            ),
          ).toContain(`retires "${CONTACTS_WORKER}", which a placed unit still deploys`);
          // The placed Shell binds every vertical, so no vertical can leave placement while it stays.
          const orphaning = yield* commitPlacement(
            root,
            [SHELL_ID],
            [CONTACTS_WORKER],
            'drop contacts under the Shell',
          );
          expect(
            yield* planningFailure(
              planDeploymentImpact({ baseRevision: deployed, headRevision: orphaning, rootDirectory: root }),
            ),
          ).toContain('places the Shell, which binds every vertical, but not "contacts"');
        }),
      { cloudflarePlacement: [SHELL_ID, 'contacts'] },
    );
  }),
);

it.live('fails when the placement base names Workers it has no topology for', () =>
  Effect.gen(function* failsForPlacementWithoutTopology() {
    yield* withFixture(
      (root) =>
        Effect.gen(function* failsForPlacementWithoutTopologyInFixture() {
          runGit(root, ['init']);
          runGit(root, ['add', CLOUDFLARE_PLACEMENT_PATH]);
          runGit(root, ['commit', '-m', 'placement without topology']);
          const base = runGit(root, ['rev-parse', 'HEAD']);
          runGit(root, ['add', '.']);
          runGit(root, ['commit', '-m', 'everything']);
          expect(
            yield* planningFailure(planDeploymentImpact({ placementBaseRevision: base, rootDirectory: root })),
          ).toContain(`has ${CLOUDFLARE_PLACEMENT_PATH} but no reference topology`);
        }),
      { cloudflarePlacement: ['contacts'] },
    );
  }),
);

it.live('fails closed when two placed units share a Worker name', () =>
  Effect.gen(function* failsClosedForSharedWorkerName() {
    yield* withFixture(
      (root) =>
        Effect.gen(function* failsClosedForSharedWorkerNameInFixture() {
          const topologyPath = path.join(root, 'topology/reference-topology.json');
          const topology = yield* Effect.tryPromise(() => readFile(topologyPath, 'utf-8'));
          yield* Effect.tryPromise(() =>
            writeFile(
              topologyPath,
              topology.replace(`"workerName": "${CONTACTS_WORKER}"`, `"workerName": "${SHELL_WORKER}"`),
              'utf-8',
            ),
          );
          expect(
            yield* planningFailure(planDeploymentImpact({ changedPaths: [DOCUMENTATION_PATH], rootDirectory: root })),
          ).toContain(`under the same Worker "${SHELL_WORKER}"`);
        }),
      { cloudflarePlacement: [SHELL_ID, 'contacts'] },
    );
  }),
);

const UNREFERENCED_VERTICAL = 'zeta-ledger';

it.live('deploys the Shell Worker after every placed vertical it binds, not only its MF remotes', () =>
  Effect.gen(function* ordersShellAfterAllVerticals() {
    yield* withFixture(
      (root) =>
        Effect.gen(function* ordersShellAfterAllVerticalsInFixture() {
          const plan = yield* planDeploymentImpact({ changedPaths: [SHARED_CONTRACT_PATH], rootDirectory: root });
          expect(plan.units.cloudflare.map(({ id }) => id)).toEqual([UNREFERENCED_VERTICAL, SHELL_ID]);
        }),
      {
        cloudflarePlacement: [SHELL_ID, UNREFERENCED_VERTICAL],
        shellVerticalRefs: [],
        verticalId: UNREFERENCED_VERTICAL,
      },
    );
  }),
);

const BINDING_CONSUMER = 'alpha-orders';

it.live('deploys a service-binding target before the vertical that binds it', () =>
  Effect.gen(function* ordersServiceBindingTargetsFirst() {
    for (const [unitServiceBindings, expected] of [
      [{}, [BINDING_CONSUMER, 'contacts', SHELL_ID]],
      [{ [BINDING_CONSUMER]: ['contacts'] }, ['contacts', BINDING_CONSUMER, SHELL_ID]],
    ] as const) {
      yield* withFixture(
        (root) =>
          Effect.gen(function* ordersServiceBindingTargetsFirstInFixture() {
            const plan = yield* planDeploymentImpact({ changedPaths: [SHARED_CONTRACT_PATH], rootDirectory: root });
            expect(plan.units.cloudflare.map(({ id }) => id)).toEqual(expected);
          }),
        {
          cloudflarePlacement: [SHELL_ID, BINDING_CONSUMER, 'contacts'],
          cloudflareUnitServiceBindings: unitServiceBindings,
          extraVerticalId: BINDING_CONSUMER,
        },
      );
    }
  }),
);

it.live('rejects a service binding that does not name another placed vertical', () =>
  Effect.gen(function* rejectsInvalidServiceBindings() {
    for (const [unitServiceBindings, message] of [
      [{ [BINDING_CONSUMER]: [BINDING_CONSUMER] }, `binds "${BINDING_CONSUMER}" to "${BINDING_CONSUMER}"`],
      [{ [BINDING_CONSUMER]: [SHELL_ID] }, `binds "${BINDING_CONSUMER}" to "${SHELL_ID}"`],
      [{ [BINDING_CONSUMER]: ['missing'] }, `binds "${BINDING_CONSUMER}" to "missing"`],
      [{ missing: ['contacts'] }, 'unitServiceBindings names "missing"'],
    ] as const) {
      yield* withFixture(
        (root) =>
          Effect.gen(function* rejectsInvalidServiceBindingsInFixture() {
            expect(
              yield* planningFailure(planDeploymentImpact({ changedPaths: [DOCUMENTATION_PATH], rootDirectory: root })),
            ).toContain(message);
          }),
        {
          cloudflarePlacement: [SHELL_ID, BINDING_CONSUMER, 'contacts'],
          cloudflareUnitServiceBindings: unitServiceBindings,
          extraVerticalId: BINDING_CONSUMER,
        },
      );
    }
  }),
);

it.live('keeps unplaced units off Cloudflare', () =>
  Effect.gen(function* keepsUnplacedUnitsOffCloudflare() {
    yield* withFixture((root) =>
      Effect.gen(function* keepsUnplacedUnitsOffCloudflareInFixture() {
        const plan = yield* planDeploymentImpact({
          changedPaths: [SHARED_CONTRACT_PATH],
          rootDirectory: root,
        });
        expect(plan.units.cloudflare).toEqual([]);
        expect(plan.phases.map((phase) => phase.id)).toEqual(['contacts', SHELL_ID]);
      }),
    );
  }),
);

for (const [placement, failure] of [
  [['billing'], /places "billing", which is not a topology delivery unit/u],
  [['contacts', 'contacts'], /places "contacts" more than once/u],
  [['core-runtime'], /places "core-runtime", which is not a topology delivery unit/u],
] as const) {
  it.live(`fails closed for Cloudflare placement ${placement.join(', ')}`, () =>
    Effect.gen(function* failsClosedForPlacement() {
      yield* withFixture(
        (root) =>
          Effect.gen(function* failsClosedForPlacementInFixture() {
            expect(
              yield* planningFailure(planDeploymentImpact({ changedPaths: [DOCUMENTATION_PATH], rootDirectory: root })),
            ).toMatch(failure);
          }),
        { cloudflarePlacement: placement },
      );
    }),
  );
}

it.live('fails closed for a Cloudflare placement whose topology entry names no Worker', () =>
  Effect.gen(function* failsClosedWithoutWorkerName() {
    yield* withFixture(
      (root) =>
        Effect.gen(function* failsClosedWithoutWorkerNameInFixture() {
          expect(
            yield* planningFailure(planDeploymentImpact({ changedPaths: [DOCUMENTATION_PATH], rootDirectory: root })),
          ).toMatch(/places "contacts", whose topology entry names no Cloudflare workerName/u);
        }),
      { cloudflarePlacement: ['contacts'], omitVerticalWorkerName: true },
    );
  }),
);

it.live('expands a provider public-contract change to the dependent Shell', () =>
  Effect.gen(function* testEffect20() {
    yield* withFixture((root) =>
      Effect.gen(function* testEffect21() {
        const plan = yield* planDeploymentImpact({
          changedPaths: ['verticals/contacts/shared/api.ts'],
          rootDirectory: root,
        });
        expect(plan.phases.map((phase) => phase.id)).toEqual(['contacts', SHELL_ID]);
      }),
    );
  }),
);

it.live('orders SpiceDB before all consumers for authorization runtime changes', () =>
  Effect.gen(function* testEffect22() {
    yield* withFixture((root) =>
      Effect.gen(function* testEffect23() {
        const plan = yield* planDeploymentImpact({
          changedPaths: ['packages/core-runtime/spicedb/bootstrap.yaml'],
          rootDirectory: root,
        });
        expect(plan.phases.map((phase) => phase.id)).toEqual(['spicedb', 'contacts', SHELL_ID]);
      }),
    );
  }),
);

for (const changedPath of ['scripts/run-zerops-spicedb.sh', 'scripts/spicedb-datastore-uri.sh']) {
  it.live(`redeploys SpiceDB and its consumers for the SpiceDB service script ${changedPath}`, () =>
    Effect.gen(function* spiceDbServiceScriptEffect() {
      yield* withFixture((root) =>
        Effect.gen(function* spiceDbServiceScriptPlanEffect() {
          const plan = yield* planDeploymentImpact({ changedPaths: [changedPath], rootDirectory: root });
          expect(plan.phases.map((phase) => phase.id)).toEqual(['spicedb', 'contacts', SHELL_ID]);
        }),
      );
    }),
  );
}

for (const changedPath of [
  'scripts/postgres/bootstrap-spicedb-database.mts',
  'packages/core-runtime/src/install/spicedb-database-config.ts',
  'pnpm-lock.yaml',
  WORKSPACE_MANIFEST_PATH,
  '.mise.toml',
  'scripts/generate-outbox-worker-deployment.mjs',
  'scripts/materialize-outbox-worker.mjs',
  'scripts/materialize-zerops-runtime.mjs',
  'scripts/locked-registry-overrides.mjs',
  'scripts/outbox-worker-delivery.mjs',
  'scripts/install-zerops-node.sh',
  'scripts/verify-zerops-workspace-install.mts',
  'zerops.yaml',
  TOPOLOGY_PATH,
  'module-federation.shared.ts',
  'tsconfig.base.json',
  'scripts/generate-ontos-module-contract.mts',
]) {
  it.live(`conservatively deploys every phase for ${changedPath}`, () =>
    Effect.gen(function* testEffect24() {
      yield* withFixture((root) =>
        Effect.gen(function* testEffect25() {
          const plan = yield* planDeploymentImpact({
            changedPaths: [changedPath],
            rootDirectory: root,
          });
          expect(plan.phases.map((phase) => phase.id)).toEqual(['migrator', 'spicedb', 'contacts', SHELL_ID]);
        }),
      );
    }),
  );
}

it.live('produces a reviewed no-op for documentation-only changes', () =>
  Effect.gen(function* testEffect26() {
    yield* withFixture((root) =>
      Effect.gen(function* testEffect27() {
        const plan = yield* planDeploymentImpact({
          changedPaths: ['docs/architecture/DEPLOYMENT.md'],
          rootDirectory: root,
        });
        expect(plan.any).toBe(false);
        expect(plan.phases).toEqual([]);
      }),
    );
  }),
);

it.live('fails closed for the unknown destination of a renamed application directory', () =>
  Effect.gen(function* testEffect28() {
    yield* withFixture((root) =>
      Effect.gen(function* testEffect29() {
        expect(
          yield* planningFailure(
            planDeploymentImpact({
              changedPaths: ['verticals/contacts/src/index.ts', 'verticals/relationships/src/index.ts'],
              rootDirectory: root,
            }),
          ),
        ).toMatch(/unknown changed path "verticals\/relationships\/src\/index\.ts" in application area "verticals"/u);
      }),
    );
  }),
);

it.live('fails closed when a topology delivery unit has no ownership entry', () =>
  Effect.gen(function* testEffect30() {
    yield* withFixture(
      (root) =>
        Effect.gen(function* testEffect31() {
          expect(
            yield* planningFailure(
              planDeploymentImpact({
                changedPaths: [DOCUMENTATION_PATH],
                rootDirectory: root,
              }),
            ),
          ).toMatch(/topology delivery unit "contacts" is missing from topology\/ownership\.json/u);
        }),
      { includeContactOwner: false },
    );
  }),
);

it.live('fails closed when topology and ownership identities disagree', () =>
  Effect.gen(function* testEffect32() {
    yield* withFixture((root) =>
      Effect.gen(function* testEffect33() {
        yield* writeJson(root, OWNERSHIP_PATH, {
          owners: [
            CORE_RUNTIME_OWNER,
            SHARED_CONTRACTS_OWNER,
            SHELL_OWNER,
            {
              id: 'contacts',
              package: '@app/contacts-old',
              path: 'verticals/contacts-old',
            },
          ],
        });
        expect(
          yield* planningFailure(
            planDeploymentImpact({
              changedPaths: [DOCUMENTATION_PATH],
              rootDirectory: root,
            }),
          ),
        ).toMatch(/topology and ownership disagree for "contacts"/u);
      }),
    );
  }),
);

it.live('fails closed when shared-package topology and ownership identities disagree', () =>
  Effect.gen(function* testEffect34() {
    yield* withFixture((root) =>
      Effect.gen(function* testEffect35() {
        yield* writeJson(root, OWNERSHIP_PATH, {
          owners: [
            { ...CORE_RUNTIME_OWNER, path: 'packages/core-runtime-old' },
            SHARED_CONTRACTS_OWNER,
            SHELL_OWNER,
            {
              id: 'contacts',
              package: '@app/contacts',
              path: 'verticals/contacts',
            },
          ],
        });
        expect(
          yield* planningFailure(
            planDeploymentImpact({
              changedPaths: [DOCUMENTATION_PATH],
              rootDirectory: root,
            }),
          ),
        ).toMatch(/topology and ownership disagree for shared package "core-runtime"/u);
      }),
    );
  }),
);

it.live('fails closed when a topology unit has no supported stage setup', () =>
  Effect.gen(function* testEffect36() {
    yield* withFixture(
      (root) =>
        Effect.gen(function* testEffect37() {
          expect(
            yield* planningFailure(
              planDeploymentImpact({
                changedPaths: [DOCUMENTATION_PATH],
                rootDirectory: root,
              }),
            ),
          ).toMatch(/topology delivery unit "contacts" has unsupported stage setup "contacts"/u);
        }),
      { setupIds: ['migrator', 'spicedb', 'shellsuperapp'] },
    );
  }),
);

it.live('rejects an all-zero comparison base instead of planning a full deployment', () =>
  Effect.gen(function* testEffect38() {
    yield* withFixture((root) =>
      Effect.gen(function* testEffect39() {
        const failure = yield* planningFailure(
          planDeploymentImpact({
            baseRevision: '0000000000000000000000000000000000000000',
            headRevision: 'HEAD',
            rootDirectory: root,
          }),
        );
        expect(failure).toContain('is not a commit in this checkout');
        expect(failure).toContain('-f full=true');
      }),
    );
  }),
);

const UNDECLARED_PACKAGE = {
  id: 'foo',
  package: '@app/foo',
  path: 'packages/foo',
} as const satisfies FixtureOwner;

it.live('fails a full deployment for a workspace package missing from the topology', () =>
  Effect.gen(function* testEffectUndeclaredPackage() {
    yield* withFixture((root) =>
      Effect.gen(function* testEffectUndeclaredPackageBody() {
        yield* writeWorkspaceProject(root, UNDECLARED_PACKAGE);
        const failure = yield* planningFailure(planDeploymentImpact({ rootDirectory: root }));
        expect(failure).toContain(
          'workspace project "packages/foo" is not declared in topology; add it to reference-topology.json sharedPackages and topology/ownership.json owners',
        );
      }),
    );
  }),
);

it.live('plans a full deployment once the workspace package is declared in topology and ownership', () =>
  Effect.gen(function* testEffectDeclaredPackage() {
    yield* withFixture(
      (root) =>
        Effect.gen(function* testEffectDeclaredPackageBody() {
          yield* writeWorkspaceProject(root, UNDECLARED_PACKAGE);
          const plan = yield* planDeploymentImpact({ rootDirectory: root });
          expect(plan.comparison.mode).toBe('full');
          expect(plan.phases.map((phase) => phase.id)).toEqual(['migrator', 'spicedb', 'contacts', SHELL_ID]);
        }),
      { extraSharedPackages: [UNDECLARED_PACKAGE] },
    );
  }),
);

it.live('fails a diff deployment for a workspace vertical missing from the topology', () =>
  Effect.gen(function* testEffectUndeclaredVertical() {
    yield* withFixture((root) =>
      Effect.gen(function* testEffectUndeclaredVerticalBody() {
        yield* writeWorkspaceProject(root, { id: 'orders', package: '@app/orders', path: 'verticals/orders' });
        const failure = yield* planningFailure(
          planDeploymentImpact({ changedPaths: [DOCUMENTATION_PATH], rootDirectory: root }),
        );
        expect(failure).toContain('workspace project "verticals/orders" is not declared in topology');
      }),
    );
  }),
);

it.live('ignores workspace directories without a package manifest', () =>
  Effect.gen(function* testEffectNonProjectDirectory() {
    yield* withFixture((root) =>
      Effect.gen(function* testEffectNonProjectDirectoryBody() {
        yield* Effect.tryPromise(() => mkdir(path.join(root, 'packages/.cache'), { recursive: true }));
        const plan = yield* planDeploymentImpact({ changedPaths: [DOCUMENTATION_PATH], rootDirectory: root });
        expect(plan.any).toBe(false);
      }),
    );
  }),
);

it.live('reads every workspace glob of an indentationless YAML list with comments', () =>
  Effect.gen(function* testEffectCommentedWorkspace() {
    yield* withFixture((root) =>
      Effect.gen(function* testEffectCommentedWorkspaceBody() {
        yield* Effect.tryPromise(() =>
          writeFile(
            path.join(root, WORKSPACE_MANIFEST_PATH),
            "packages:\n- 'apps/*'\n\n# verticals and shared packages\n- verticals/* # providers\n- packages/*\ncatalogs: {}\n",
            'utf-8',
          ),
        );
        yield* writeWorkspaceProject(root, UNDECLARED_PACKAGE);
        const failure = yield* planningFailure(planDeploymentImpact({ rootDirectory: root }));
        expect(failure).toContain('workspace project "packages/foo" is not declared in topology');
      }),
    );
  }),
);

it.live('rejects workspace globs the planner cannot enumerate', () =>
  Effect.gen(function* testEffectUnsupportedGlob() {
    yield* withFixture((root) =>
      Effect.gen(function* testEffectUnsupportedGlobBody() {
        yield* Effect.tryPromise(() =>
          writeFile(path.join(root, WORKSPACE_MANIFEST_PATH), "packages:\n  - 'packages/**'\n", 'utf-8'),
        );
        const failure = yield* planningFailure(planDeploymentImpact({ rootDirectory: root }));
        expect(failure).toContain('pnpm-workspace.yaml glob "packages/**" is unsupported');
      }),
    );
  }),
);

it.live('rejects an unavailable comparison base', () =>
  Effect.gen(function* testEffect40() {
    yield* withFixture((root) =>
      Effect.gen(function* testEffect41() {
        const failure = yield* planningFailure(
          planDeploymentImpact({
            baseRevision: 'missing-base-revision',
            headRevision: 'HEAD',
            rootDirectory: root,
          }),
        );
        expect(failure).toContain('comparison base "missing-base-revision" is not a commit in this checkout');
      }),
    );
  }),
);

it.live('rejects a comparison base that is not an ancestor of the head', () =>
  Effect.gen(function* testEffect42() {
    yield* withFixture((root) =>
      Effect.gen(function* testEffect43() {
        runGit(root, ['init']);
        runGit(root, ['add', '.']);
        runGit(root, ['commit', '-m', 'fixture root']);
        const rootRevision = runGit(root, ['rev-parse', 'HEAD']);
        yield* Effect.tryPromise(() => writeFile(path.join(root, 'main-marker.txt'), 'main\n', 'utf-8'));
        runGit(root, ['add', 'main-marker.txt']);
        runGit(root, ['commit', '-m', 'main change']);
        const rewrittenBase = runGit(root, ['rev-parse', 'HEAD']);
        runGit(root, ['checkout', '-b', 'rewritten', rootRevision]);
        yield* Effect.tryPromise(() => writeFile(path.join(root, 'rewritten-marker.txt'), 'rewritten\n', 'utf-8'));
        runGit(root, ['add', 'rewritten-marker.txt']);
        runGit(root, ['commit', '-m', 'rewritten change']);

        const failure = yield* planningFailure(
          planDeploymentImpact({
            baseRevision: rewrittenBase,
            headRevision: 'HEAD',
            rootDirectory: root,
          }),
        );
        expect(failure).toContain(`comparison base "${rewrittenBase}" is not an ancestor of "HEAD"`);
        expect(failure).toContain('-f full=true');
      }),
    );
  }),
);

const deploymentSource = (
  deployments: readonly {
    /** `null` records a status without a log URL. */
    readonly logPath?: string | null;
    readonly runId: string;
    readonly sha: string;
    readonly states: readonly string[];
  }[],
): StageDeploymentSource<never, never> => ({
  page: (page) => Effect.succeed(page === 1 ? deployments.map((deployment, id) => ({ id, sha: deployment.sha })) : []),
  statuses: (deploymentId) => {
    const deployment = deployments[deploymentId];
    return Effect.succeed(
      deployment === undefined
        ? []
        : deployment.states.map((state) => ({
            logUrl:
              deployment.logPath === null
                ? ''
                : `https://github.com/TechsioCZ/ontos/actions/runs/${deployment.runId}${deployment.logPath ?? '/job/1'}`,
            state,
          })),
    );
  },
});

it.live('diffs from the last successful stage deployment so failed and cancelled ranges are redeployed', () =>
  Effect.gen(function* testEffectDeploymentBase() {
    yield* withFixture((root) =>
      Effect.gen(function* testEffectDeploymentBaseBody() {
        runGit(root, ['init']);
        runGit(root, ['add', '.']);
        runGit(root, ['commit', '-m', 'A deployed']);
        const deployedA = runGit(root, ['rev-parse', 'HEAD']);
        yield* Effect.tryPromise(() => mkdir(path.join(root, 'verticals/contacts/src'), { recursive: true }));
        yield* Effect.tryPromise(() =>
          writeFile(path.join(root, 'verticals/contacts/src/failed.ts'), 'export {};\n', 'utf-8'),
        );
        runGit(root, ['add', '.']);
        runGit(root, ['commit', '-m', 'B failed']);
        const failedB = runGit(root, ['rev-parse', 'HEAD']);
        yield* Effect.tryPromise(() => writeFile(path.join(root, 'cancelled-marker.txt'), 'cancelled\n', 'utf-8'));
        runGit(root, ['add', '.']);
        runGit(root, ['commit', '-m', 'C cancelled']);
        const cancelledC = runGit(root, ['rev-parse', 'HEAD']);
        yield* Effect.tryPromise(() => writeFile(path.join(root, 'head-marker.txt'), 'head\n', 'utf-8'));
        runGit(root, ['add', '.']);
        runGit(root, ['commit', '-m', 'D head']);
        const headD = runGit(root, ['rev-parse', 'HEAD']);

        const base = yield* resolveStageDeploymentBase(
          deploymentSource([
            { runId: '4', sha: headD, states: ['in_progress'] },
            { runId: '3', sha: cancelledC, states: ['inactive', 'in_progress'] },
            { runId: '2', sha: failedB, states: ['failure', 'in_progress'] },
            { runId: '1', sha: deployedA, states: ['success', 'in_progress'] },
          ]),
          { currentRunId: '4', environment: 'stage' },
        );
        expect(base).toBe(deployedA);

        const plan = yield* planDeploymentImpact({ baseRevision: base, headRevision: headD, rootDirectory: root });
        expect(plan.comparison).toEqual({ baseRevision: deployedA, headRevision: headD, mode: 'diff' });
        expect(plan.changedPaths).toContain('verticals/contacts/src/failed.ts');
        expect(plan.units.providers).toContain('contacts');
      }),
    );
  }),
);

it.live('reports no base, for a full plan, when the environment has no successful deployment yet', () =>
  Effect.gen(function* testEffectNoBase() {
    const base = yield* findStageDeploymentBase(
      deploymentSource([{ runId: '7', sha: 'first-seed', states: ['failure', 'in_progress'] }]),
      { currentRunId: '8' },
    );
    expect(Option.isNone(base)).toBe(true);
  }),
);

it.live('skips a successful deployment of the current run and keeps the base GitHub marked inactive', () =>
  Effect.gen(function* testEffectCurrentRun() {
    const base = yield* resolveStageDeploymentBase(
      deploymentSource([
        { logPath: '', runId: '9', sha: 'rerun-of-current', states: ['success', 'in_progress'] },
        { runId: '8', sha: 'previous', states: ['inactive', 'success', 'in_progress'] },
      ]),
      { currentRunId: '9', environment: 'stage' },
    );
    expect(base).toBe('previous');
  }),
);

it.live('never takes a success whose log URL names no workflow run as the base', () =>
  Effect.gen(function* testEffectUnknownRun() {
    const base = yield* resolveStageDeploymentBase(
      deploymentSource([
        { logPath: null, runId: '9', sha: 'unknown-run', states: ['success', 'in_progress'] },
        { runId: '8', sha: 'previous', states: ['success', 'in_progress'] },
      ]),
      { currentRunId: '9', environment: 'stage' },
    );
    expect(base).toBe('previous');
  }),
);

it.live('takes a deployment whose older success came from another run', () =>
  Effect.gen(function* testEffectOlderForeignSuccess() {
    const base = yield* resolveStageDeploymentBase(
      {
        page: (page) => Effect.succeed(page === 1 ? [{ id: 0, sha: 'redeployed' }] : []),
        statuses: () =>
          Effect.succeed([
            { logUrl: 'https://github.com/TechsioCZ/ontos/actions/runs/9/job/1', state: 'success' },
            { logUrl: 'https://github.com/TechsioCZ/ontos/actions/runs/8/job/1', state: 'success' },
          ]),
      },
      { currentRunId: '9', environment: 'stage' },
    );
    expect(base).toBe('redeployed');
  }),
);

it.live('decodes deployment statuses whose log URL is null or omitted', () =>
  Effect.gen(function* testEffectNullableLogUrl() {
    const pages = yield* Schema.decodeUnknownEffect(StatusPagesJsonSchema)(
      '[[{"log_url":null,"state":"success"},{"state":"in_progress"}]]',
    );
    expect(pages.flat().map((status) => status.state)).toEqual(['success', 'in_progress']);
  }),
);

it.live('names the missing seed when no successful stage deployment exists', () =>
  Effect.gen(function* testEffectNoDeployment() {
    const failure = yield* planningFailure(
      resolveStageDeploymentBase(
        deploymentSource([
          { runId: '2', sha: 'current', states: ['in_progress'] },
          { runId: '1', sha: 'failed', states: ['failure', 'in_progress'] },
        ]),
        { currentRunId: '2', environment: 'stage' },
      ),
    );
    expect(failure).toContain('no successful "stage" deployment exists outside run 2');
    expect(failure).toContain('gh workflow run ultramodern-workspace-gates.yml --ref main -f full=true');
  }),
);

it.live('changing a topology identity changes the plan without editing planner source', () =>
  Effect.gen(function* testEffect44() {
    yield* withFixture(
      (root) =>
        Effect.gen(function* testEffect45() {
          const plan = yield* planDeploymentImpact({
            changedPaths: ['verticals/relationships/src/index.ts'],
            rootDirectory: root,
          });
          expect(plan.units.providers).toEqual(['relationships']);
          expect(plan.phases.map((phase) => phase.id)).toEqual(['relationships']);
          expect(plan.phases[0]?.serviceIdEnv).toBe('ZEROPS_RELATIONSHIPS_SERVICE_ID');
        }),
      { verticalId: 'relationships' },
    );
  }),
);

const promotionFixture = (): AuthorizationPromotionGateInput => {
  const inventory = {
    businessPermissions: [],
    entries: [
      {
        authorization: { kind: 'public' as const },
        deployment: 'contacts',
        entrypointKey: 'contacts.route.home',
        owner: 'contacts.core',
        surface: 'route' as const,
      },
    ],
    inventoryHash: 'a'.repeat(64),
    schemaVersion: 2 as const,
    sourceRevision: 'revision',
  };
  const impact = {
    aggregates: [],
    inventoryHash: inventory.inventoryHash,
    observation: {
      endedAt: '2026-09-10T00:00:00.000Z',
      startedAt: '2026-09-02T00:00:00.000Z',
    },
    schemaVersion: 1 as const,
    sourceRevision: inventory.sourceRevision,
    totalWouldDeny: 0,
  };
  const negativeSmoke = {
    environment: 'stage' as const,
    inventoryHash: inventory.inventoryHash,
    scenarios: [],
    schemaVersion: 1 as const,
    sourceRevision: inventory.sourceRevision,
  };
  return {
    environment: 'stage',
    impact,
    inventory,
    negativeSmoke,
    nowEpochMs: Date.parse('2026-10-02T00:00:00.000Z'),
    readiness: {
      approvalReference: 'https://github.com/TechsioCZ/ontos/issues/169',
      environment: 'stage',
      fixedContextHash: 'b'.repeat(64),
      impactReportHash: hashAuthorizationEvidence(impact),
      inventoryHash: inventory.inventoryHash,
      moduleStateVersion: 'module-state-v1',
      negativeSmokeHash: hashAuthorizationEvidence(negativeSmoke),
      observation: { ...impact.observation },
      policyDataVersion: 'policy-v1',
      replayMigrationHash: 'c'.repeat(64),
      schemaVersion: 1,
      sourceRevision: inventory.sourceRevision,
      spiceDbSchemaHash: 'd'.repeat(64),
      status: 'ready',
      workerOwnershipVersion: 'worker-v1',
    },
    rollout: {
      activatedAt: '2026-09-01T00:00:00.000Z',
      baselineInventoryHash: inventory.inventoryHash,
      baselineSourceRevision: inventory.sourceRevision,
      compatibilityEligibleEntrypoints: [],
      decisionReference: 'https://github.com/TechsioCZ/ontos/issues/169',
      expiresAt: '2026-09-30T00:00:00.000Z',
      mode: 'enforced',
      schemaVersion: 1,
    },
  };
};

const withoutImpactEvidence = (input: AuthorizationPromotionGateInput): AuthorizationPromotionGateInput => {
  const { impact, ...remaining } = input;
  expect(impact !== undefined).toBe(true);
  return remaining;
};

const withoutNegativeSmokeEvidence = (input: AuthorizationPromotionGateInput): AuthorizationPromotionGateInput => {
  const { negativeSmoke, ...remaining } = input;
  expect(negativeSmoke !== undefined).toBe(true);
  return remaining;
};

const withoutReadinessEvidence = (input: AuthorizationPromotionGateInput): AuthorizationPromotionGateInput => {
  const { readiness, ...remaining } = input;
  expect(readiness !== undefined).toBe(true);
  return remaining;
};

it('requires exact impact, readiness, and negative-smoke evidence for enforced promotion', () => {
  expect(validateAuthorizationPromotionGate(promotionFixture())).toEqual({
    environment: 'stage',
    mode: 'enforced',
    status: 'ready',
  });
  for (const changed of [
    withoutImpactEvidence(promotionFixture()),
    withoutNegativeSmokeEvidence(promotionFixture()),
    withoutReadinessEvidence(promotionFixture()),
  ]) {
    expect(() => validateAuthorizationPromotionGate(changed)).toThrow(/requires impact/u);
  }
  const stale = promotionFixture();
  const staleReadiness = stale.readiness;
  expect(staleReadiness).toBeDefined();
  if (staleReadiness === undefined) {
    throw new Error('Expected readiness evidence');
  }
  expect(() =>
    validateAuthorizationPromotionGate({
      ...stale,
      readiness: { ...staleReadiness, inventoryHash: 'f'.repeat(64) },
    }),
  ).toThrow(/stale, mismatched/u);
});

it('report-only promotion is bounded, explicit-baseline-only, and never allowed in production', () => {
  const enforced = promotionFixture();
  const withoutRequiredEvidence = withoutReadinessEvidence(
    withoutNegativeSmokeEvidence(withoutImpactEvidence(enforced)),
  );
  const reportOnly = {
    ...withoutRequiredEvidence,
    nowEpochMs: Date.parse('2026-09-10T00:00:00.000Z'),
    rollout: { ...enforced.rollout, mode: 'report_only' as const },
  };
  expect(validateAuthorizationPromotionGate(reportOnly).status).toBe('observing');
  expect(() =>
    validateAuthorizationPromotionGate({
      ...reportOnly,
      environment: 'production',
    }),
  ).toThrow(/production.*report-only/u);
  expect(() =>
    validateAuthorizationPromotionGate({
      ...reportOnly,
      nowEpochMs: Date.parse(reportOnly.rollout.expiresAt),
    }),
  ).toThrow(/inactive or expired/u);
  expect(() =>
    validateAuthorizationPromotionGate({
      ...reportOnly,
      rollout: {
        ...reportOnly.rollout,
        compatibilityEligibleEntrypoints: ['contacts.route.new'],
      },
    }),
  ).toThrow(/unknown entrypoint/u);
});
