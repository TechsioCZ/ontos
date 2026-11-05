import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, Effect, FileSystem, Layer } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { OpsShell } from '../ops/ops-shell.mts';
import { main, serviceIdVariable } from '../publish-active-application-composition.mts';
import { planDeploymentImpact } from '../plan-deployment-impact.mts';

const HOST = 'outbox-worker-host';
const EXCLUDED = 'commerce-order-worker';
const INVENTORY_WORKER = 'inventory-worker';
const APPROVED = ['party-registry-worker', 'commerce-customer-context-worker', INVENTORY_WORKER, 'privacy-worker'];
const INVENTORY = [...APPROVED, EXCLUDED, HOST];
const CUSTOM_INTENT = 'topology/drift-custom-intent.json';
const appDirectory = path.resolve(import.meta.dirname, '../..');

interface DriftScenario {
  readonly active: readonly string[];
  readonly deleted?: readonly string[];
  readonly drift: boolean;
  readonly missingVariables?: readonly string[];
  readonly mode: 'dedicated' | 'host';
  readonly modules?: readonly string[];
  readonly name: string;
  readonly stopped?: readonly string[];
}

const scenarios: readonly DriftScenario[] = [
  {
    active: APPROVED,
    drift: false,
    missingVariables: [EXCLUDED],
    mode: 'dedicated',
    name: 'five reviewed dedicated workers and no excluded service are settled',
  },
  {
    active: APPROVED,
    deleted: [EXCLUDED],
    drift: false,
    mode: 'dedicated',
    name: 'a deleted excluded dedicated service does not cause permanent drift',
  },
  {
    active: [HOST],
    drift: false,
    mode: 'host',
    name: 'the reviewed host with stopped dedicated inventory is settled',
  },
  {
    active: [...APPROVED, EXCLUDED],
    drift: true,
    mode: 'dedicated',
    name: 'a running excluded dedicated worker still causes drift',
    stopped: [EXCLUDED],
  },
  {
    active: [...APPROVED, HOST],
    drift: true,
    mode: 'dedicated',
    name: 'the other mode host remains detectable',
    stopped: [HOST],
  },
  {
    active: [HOST, EXCLUDED],
    drift: true,
    mode: 'host',
    name: 'an excluded owner running in the other mode remains detectable',
    stopped: [EXCLUDED],
  },
  {
    active: APPROVED.slice(1),
    drift: true,
    mode: 'dedicated',
    name: 'a stopped reviewed worker still requires reconciliation',
  },
  {
    active: APPROVED,
    drift: true,
    missingVariables: [APPROVED[0] ?? ''],
    mode: 'dedicated',
    name: 'an unprovisioned reviewed worker still requires reconciliation',
  },
  {
    active: APPROVED,
    deleted: [APPROVED[0] ?? ''],
    drift: true,
    mode: 'dedicated',
    name: 'a deleted reviewed worker still requires reconciliation',
  },
  {
    active: [INVENTORY_WORKER],
    drift: false,
    mode: 'dedicated',
    modules: ['inventory'],
    name: 'a custom intent requires only its reviewed dedicated worker',
  },
  {
    active: [HOST],
    drift: false,
    mode: 'host',
    modules: ['inventory'],
    name: 'a custom intent with a worker requires the host',
  },
  {
    active: [],
    drift: false,
    mode: 'host',
    modules: ['tax'],
    name: 'a custom intent without workers does not require a host',
  },
  {
    active: [HOST],
    drift: true,
    mode: 'host',
    modules: ['tax'],
    name: 'a running host outside reviewed worker membership remains detectable',
    stopped: [HOST],
  },
  {
    active: [INVENTORY_WORKER, EXCLUDED],
    drift: true,
    mode: 'dedicated',
    modules: ['inventory'],
    name: 'a custom dedicated intent stops its excluded running own-mode worker',
    stopped: [EXCLUDED],
  },
  {
    active: [EXCLUDED],
    drift: true,
    mode: 'dedicated',
    modules: [],
    name: 'empty dedicated membership reconciles with stops and no new worker phases',
    stopped: [EXCLUDED, HOST],
  },
  {
    active: [HOST, EXCLUDED],
    drift: true,
    mode: 'host',
    modules: [],
    name: 'empty host membership stops own and other-mode executable inventory',
    stopped: INVENTORY,
  },
];

for (const scenario of scenarios) {
  it.effect(`actual worker-mode-drift CLI: ${scenario.name}`, () =>
    Effect.gen(function* actualWorkerModeDrift() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-worker-mode-drift-' });
      const output = path.join(directory, 'github-output');
      const requests: string[] = [];
      const client = HttpClient.make((request, destination) => {
        expect(request.method).toBe('GET');
        expect(destination.pathname).toMatch(/^\/api\/rest\/public\/service-stack\/[^/]+$/u);
        const setup = destination.pathname.split('/').at(-1) ?? '';
        requests.push(setup);
        const response =
          scenario.deleted?.includes(setup) === true
            ? Response.json({ error: { code: 'serviceStackNotFound' } }, { status: 400 })
            : Response.json({
                name: setup,
                status: scenario.active.includes(setup) ? 'ACTIVE' : 'STOPPED',
                subdomainAccess: false,
              });
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      });
      const customLocation = path.join(appDirectory, CUSTOM_INTENT);
      const files = Layer.succeed(FileSystem.FileSystem, {
        ...fs,
        readFileString: (location, options) =>
          location === customLocation && scenario.modules !== undefined
            ? Effect.succeed(JSON.stringify({ modules: scenario.modules.map((appId) => ({ appId })) }))
            : fs.readFileString(location, options),
        realPath: (location) => (location === customLocation ? Effect.succeed(location) : fs.realPath(location)),
      });
      const variables = Object.fromEntries(
        INVENTORY.filter((setup) => scenario.missingVariables?.includes(setup) !== true).map((setup) => [
          serviceIdVariable(setup),
          setup,
        ]),
      );
      const config = {
        COMPOSITION_INTENT_FILE:
          scenario.modules === undefined ? 'topology/application-release-intent.json' : CUSTOM_INTENT,
        GITHUB_OUTPUT: output,
        OUTBOX_WORKER_MODE: scenario.mode,
        STAGE_VARIABLES_JSON: JSON.stringify(variables),
        ZEROPS_TOKEN: 'controlled-drift-token',
      };
      const services = Layer.mergeAll(
        NodeServices.layer,
        files,
        Reactivity.layer,
        Layer.succeed(HttpClient.HttpClient, client),
        Layer.succeed(OpsShell, { run: () => Effect.die('Drift detection must not spawn a mutation or a command') }),
      );
      const previousArguments = process.argv;
      process.argv = [process.execPath, 'publish-active-application-composition.mts', 'worker-mode-drift'];
      try {
        yield* Layer.build(
          Layer.effectDiscard(main).pipe(
            Layer.provide(services),
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
          ),
        ).pipe(Effect.scoped);
      } finally {
        process.argv = previousArguments;
      }
      expect(yield* fs.readFileString(output)).toBe(`drift=${String(scenario.drift)}\n`);
      expect(new Set(requests).size).toBe(requests.length);
      for (const setup of scenario.missingVariables ?? []) {
        expect(requests).not.toContain(setup);
      }
      const plan = yield* planDeploymentImpact({
        changedPaths: [],
        outboxWorkerMode: scenario.mode,
        reconcileWorkers: scenario.drift,
        rootDirectory: appDirectory,
      }).pipe(Effect.provide(services), Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))));
      for (const setup of scenario.stopped ?? []) {
        expect(plan.units.stoppedWorkers).toContain(setup);
      }
      expect(plan.any).toBe(scenario.drift);
      if (scenario.modules?.length === 0) {
        expect(plan.phases).toEqual([]);
        expect(plan.units.workers).toEqual([]);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}
