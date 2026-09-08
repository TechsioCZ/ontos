import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, ManagedRuntime, Path, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';

import { outboxWorkerDelivery } from './outbox-worker-delivery.mjs';

const TopologySchema = Schema.fromJsonString(
  Schema.Struct({
    verticals: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        moduleFederation: Schema.Struct({ manifestUrl: Schema.String }),
        package: Schema.String,
        path: Schema.String,
      })
    ),
  })
);

class OutboxWorkerDeploymentError extends Error {
  /** @param {string} message Error detail. */
  constructor(message) {
    super(message);
    this.name = 'OutboxWorkerDeploymentError';
    this._tag = 'OutboxWorkerDeploymentError';
  }
}

/** @param {string} message Error detail. */
const failure = (message) => new OutboxWorkerDeploymentError(message);

const nodeRuntime = ManagedRuntime.make(NodeServices.layer);

/**
 * @param {string} root Workspace root.
 * @param {string} source Existing Zerops deployment source.
 */
const generateOutboxWorkerDeploymentEffect = (root, source) =>
  Effect.gen(function* generateDeployment() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const topologySource = yield* fs.readFileString(
      path.join(root, 'topology/reference-topology.json')
    );
    const topology =
      yield* Schema.decodeUnknownEffect(TopologySchema)(topologySource);
    let result = source.replace(
      /\n {2}# <generated-outbox-worker-deployments>[\s\S]*? {2}# <\/generated-outbox-worker-deployments>\n?/u,
      '\n'
    );
    /** @type {string[]} */
    const services = [];
    for (const vertical of topology.verticals) {
      const delivery = yield* outboxWorkerDelivery(root, vertical).pipe(
        Effect.mapError(() =>
          failure(`Invalid generated worker delivery for ${vertical.id}`)
        )
      );
      if (delivery === undefined) {
        continue;
      }
      const ownerSection = result
        .split(/(?=^ {2}- setup:)/mu)
        .find((section) => section.startsWith(`  - setup: '${vertical.id}'\n`));
      if (ownerSection === undefined) {
        return yield* Effect.fail(
          failure(`Missing owner deployment for ${vertical.id}`)
        );
      }
      const port = /^ {8}PORT: '(?<port>[0-9]+)'$/mu.exec(ownerSection)?.groups
        ?.port;
      const topologyPort = yield* Effect.try({
        catch: () =>
          failure(`Invalid topology manifest URL for ${vertical.id}`),
        try: () => new URL(vertical.moduleFederation.manifestUrl).port,
      });
      if (port === undefined || port.length === 0 || port !== topologyPort) {
        return yield* Effect.fail(
          failure(`Owner port disagrees with topology for ${vertical.id}`)
        );
      }
      const service = ownerSection
        .trimEnd()
        .replace(`setup: '${vertical.id}'`, `setup: '${delivery.id}'`)
        .replaceAll(`runtime/${vertical.id}`, `runtime/${delivery.id}`)
        .split('\n')
        .filter(
          (line) =>
            !line.includes(' run build') &&
            !line.includes("- cp 'app/topology/") &&
            !line.includes('VERTICAL_')
        )
        .map((line) =>
          line.includes('run zerops:materialize')
            ? line.replace(
                'cd app && ',
                'cd app && ULTRAMODERN_SOURCE_REVISION="$(git rev-parse HEAD)" '
              )
            : line
        )
        .join('\n')
        .replace(
          /(?<command>run zerops:materialize[^\n]*)/u,
          '$<command> --worker'
        )
        .replaceAll(`/${vertical.id}-api/${vertical.id}/readiness`, '/ready')
        .replace(
          `ULTRAMODERN_ZEROPS_SERVICE: ${vertical.id}`,
          `ULTRAMODERN_ZEROPS_SERVICE: ${delivery.id}`
        )
        .replace(
          `        PORT: '${port}'`,
          `        PORT: '${port}'\n        OUTBOX_WORKER_HEALTH_PORT: '${port}'\n        DATABASE_URL: \${${vertical.id}_DATABASE_URL}`
        );
      services.push(service);
    }
    if (services.length === 0) {
      return result;
    }
    result = `${result.trimEnd()}\n\n  # <generated-outbox-worker-deployments>\n${services.join('\n\n')}\n  # </generated-outbox-worker-deployments>\n`;
    return result;
  });

/**
 * @param {string} root Workspace root.
 * @param {string} source Existing Zerops deployment source.
 * @returns {PromiseLike<string>} Deployment source with generated worker services.
 */
export const generateOutboxWorkerDeployment = (root, source) =>
  nodeRuntime.runPromise(generateOutboxWorkerDeploymentEffect(root, source));

/** @param {{ write: boolean }} options Parsed command options. */
const runCommand = ({ write }) =>
  Effect.gen(function* runDeploymentGenerator() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve();
    const file = path.join(root, 'zerops.yaml');
    const source = yield* fs.readFileString(file);
    const generated = yield* generateOutboxWorkerDeploymentEffect(root, source);
    if (write) {
      yield* fs.writeFileString(file, generated);
    } else if (source !== generated) {
      yield* Effect.fail(
        failure(
          'Worker deployment drift: run node scripts/generate-outbox-worker-deployment.mjs --write'
        )
      );
    }
  });

const command = Command.make(
  'generate-outbox-worker-deployment',
  { write: Flag.boolean('write').pipe(Flag.withDefault(false)) },
  runCommand
);

/** @type {ImportMeta & { main?: boolean }} */
const moduleMetadata = import.meta;

if (moduleMetadata.main === true) {
  void nodeRuntime.runPromise(Command.run(command, { version: '1.0.0' }));
}
