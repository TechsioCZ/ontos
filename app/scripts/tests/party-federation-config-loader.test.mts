import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/unstable/process';

import { collectToolingProcess } from './tooling-process-fixture.mts';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const partyDirectory = 'verticals/party-registry';
const configFiles = ['module-federation.config.ts', 'backend-federation.config.ts'];
const LoadedConfigSchema = Schema.Struct({
  exposes: Schema.Record(Schema.String, Schema.String),
  filename: Schema.String,
  name: Schema.String,
  shared: Schema.Record(Schema.String, Schema.Struct({ requiredVersion: Schema.String, singleton: Schema.Boolean })),
});

// Use Party's installed MF package, whose getMFConfig owns the synchronous Jiti loader.
// A native import or Modern's generic config loader would miss this build-time boundary.
const probe = `
import { createRequire } from 'node:module';
import path from 'node:path';
const party = path.resolve('${partyDirectory}');
const require = createRequire(path.join(party, 'package.json'));
const { getMFConfig } = require('@module-federation/modern-js-v3/config-plugin');
const configs = [];
for (const file of process.argv.slice(1)) {
  const config = await getMFConfig({ configPath: path.join(party, file) });
  configs.push({
    name: config.name,
    filename: config.filename,
    exposes: config.exposes,
    shared: config.shared,
  });
}
process.stdout.write(JSON.stringify(configs));
`;

it.live(
  'Party federation configs keep package-version decoding behind the Schema-only import',
  Effect.fn(function* schemaImportBoundary() {
    const fs = yield* FileSystem.FileSystem;
    for (const file of configFiles) {
      const source = yield* fs.readFileString(`${workspaceRoot}/${partyDirectory}/${file}`);
      expect(source, file).toMatch(/import \* as Schema from ['"]effect\/Schema['"]/u);
      expect(source, file).not.toMatch(/from\s*['"]effect['"]/u);
    }
  }, Effect.provide(NodeServices.layer)),
);

it.live(
  'the published Module Federation Jiti loader imports both actual Party configs',
  Effect.fn(
    function* publishedFederationConfigLoader() {
      const result = yield* collectToolingProcess(
        ChildProcess.make(process.execPath, ['--input-type=module', '--eval', probe, ...configFiles], {
          cwd: workspaceRoot,
          extendEnv: true,
          stderr: 'pipe',
          stdin: 'ignore',
          stdout: 'pipe',
        }),
      );
      expect(result.status, result.stderr).toBe(0);
      const configs = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(LoadedConfigSchema)))(result.stdout);
      expect(configs).toMatchObject([
        {
          exposes: {
            './PageContacts': './src/routes/[lang]/contacts/page.tsx',
            './PageCustomers': './src/routes/[lang]/prodej/zakaznici/page.tsx',
          },
          filename: 'remoteEntry.js',
          name: 'verticalPartyRegistry',
          shared: { react: { singleton: true } },
        },
        {
          exposes: { './effect-api': './api/effect-api.ts' },
          filename: 'backendRemoteEntry.cjs',
          name: 'verticalPartyRegistryBackend',
          shared: { effect: { singleton: true } },
        },
      ]);
    },
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);
