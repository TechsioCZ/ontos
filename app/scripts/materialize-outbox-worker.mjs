import fs from 'node:fs';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import { build } from 'esbuild';
import { outboxWorkerDelivery } from './outbox-worker-delivery.mjs';

/** Bundle owner + Core code; retain exact production dependencies, never workspace links. */
export const materializeOutboxWorker = async ({
  workspaceRoot,
  appId,
  packageName,
  packageDir,
  runtimeDir,
}) => {
  const topology = JSON.parse(
    fs.readFileSync(path.join(workspaceRoot, 'topology/reference-topology.json'), 'utf-8'),
  );
  const vertical = topology.verticals.find((candidate) => candidate.id === appId);
  if (!vertical || vertical.package !== packageName || vertical.path !== packageDir) {
    throw new Error('Worker identity must match its topology owner');
  }
  const delivery = outboxWorkerDelivery(workspaceRoot, vertical);
  if (!delivery) {
    throw new Error(`${appId} has no generated Outbox Worker host`);
  }
  const dependencies = {};
  const packages = new Map();
  for (const directory of ['packages', 'apps', 'verticals']) {
    const parent = path.join(workspaceRoot, directory);
    if (!fs.existsSync(parent)) {
      continue;
    }
    for (const entry of fs.readdirSync(parent)) {
      const manifest = path.join(parent, entry, 'package.json');
      if (!fs.existsSync(manifest)) {
        continue;
      }
      const value = JSON.parse(fs.readFileSync(manifest, 'utf-8'));
      packages.set(value.name, { directory: path.dirname(manifest), manifest: value });
    }
  }
  const result = await build({
    absWorkingDir: workspaceRoot,
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    bundle: true,
    entryPoints: [path.join(packageDir, delivery.entry)],
    format: 'esm',
    metafile: true,
    outfile: path.join(runtimeDir, 'worker.mjs'),
    platform: 'node',
    plugins: [
      {
        name: 'worker-production-dependencies',
        setup(builder) {
          // eslint-disable-next-line require-unicode-regexp -- esbuild accepts Go regular expressions and rejects the JavaScript `u` flag.
          builder.onResolve({ filter: /^@effect\/platform-node$/ }, () => ({
            namespace: 'worker-platform-node',
            path: '@effect/platform-node',
          }));
          // eslint-disable-next-line require-unicode-regexp -- esbuild accepts Go regular expressions and rejects the JavaScript `u` flag.
          builder.onLoad({ filter: /.*/, namespace: 'worker-platform-node' }, () => ({
            contents: [
              "import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';",
              "import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';",
              "import * as NodePath from '@effect/platform-node/NodePath';",
              'export { NodeFileSystem, NodeHttpServer, NodePath };',
            ].join('\n'),
            loader: 'js',
            resolveDir: workspaceRoot,
          }));
          // eslint-disable-next-line require-unicode-regexp -- esbuild accepts Go regular expressions and rejects the JavaScript `u` flag.
          builder.onResolve({ filter: /^[^./]/ }, (args) => {
            if (isBuiltin(args.path)) {
              return { external: true, path: args.path };
            }
            const name = args.path.startsWith('@')
              ? args.path.split('/').slice(0, 2).join('/')
              : args.path.split('/').at(0);
            if (args.path === '@app/core-runtime') {
              return {
                path: path.join(
                  workspaceRoot,
                  'packages/core-runtime/src/outbox/worker-entrypoint.ts',
                ),
              };
            }
            if (packages.has(name)) {
              return;
            }
            return { external: true, path: args.path };
          });
        },
      },
    ],
    target: 'node26',
  });
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports.filter((item) => item.external)) {
      if (isBuiltin(imported.path)) {
        continue;
      }
      const name = imported.path.startsWith('@')
        ? imported.path.split('/').slice(0, 2).join('/')
        : imported.path.split('/').at(0);
      const versions = [...packages.values()].flatMap(({ manifest }) => {
        const version = manifest.dependencies?.[name];
        return version && !version.startsWith('workspace:') ? [version] : [];
      });
      const uniqueVersions = [...new Set(versions)];
      if (uniqueVersions.length !== 1) {
        throw new Error(`Worker dependency ${name} must have one declared production version`);
      }
      const [version] = uniqueVersions;
      dependencies[name] = version;
    }
  }
  fs.copyFileSync(
    path.join(workspaceRoot, 'topology/reference-topology.json'),
    path.join(runtimeDir, 'topology.json'),
  );
  fs.writeFileSync(
    path.join(runtimeDir, 'worker-artifact.json'),
    `${JSON.stringify(
      {
        appId,
        entry: 'worker.mjs',
        schemaVersion: 1,
        serviceId: delivery.id,
        sourceInputs: Object.keys(result.metafile.inputs).toSorted(),
        sourceRevision: process.env.ULTRAMODERN_SOURCE_REVISION ?? null,
      },
      null,
      2,
    )}\n`,
  );
  return {
    dependencies,
    name: `${delivery.id}-runtime`,
    private: true,
    scripts: { serve: 'node worker.mjs' },
    type: 'module',
  };
};
