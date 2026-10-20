import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createPresetUltramodernWorkspaceConfig } from '@modern-js/ultramodern-app-tools';
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

const appRoot = path.resolve(import.meta.dirname, '../..');

const TopologyUnitSchema = Schema.Struct({
  cloudflare: Schema.Struct({ workerName: Schema.String }),
  id: Schema.String,
  path: Schema.String,
});
const TopologyFromJson = Schema.fromJsonString(
  Schema.Struct({ shell: TopologyUnitSchema, verticals: Schema.Array(TopologyUnitSchema) }),
);

const topology = Schema.decodeUnknownSync(TopologyFromJson)(
  readFileSync(path.join(appRoot, 'topology/reference-topology.json'), 'utf-8'),
);
const readConfig = (unitPath: string) => readFileSync(path.join(appRoot, unitPath, 'modern.config.ts'), 'utf-8');

// CI deploys, snapshots and restores each placed unit under its topology `cloudflare.workerName`,
// while Wrangler deploys the name its Modern config bakes into `.output/wrangler.json`. They must be
// the same Worker. Immutable module releases have separate native Worker identities.
it('resolves every Worker identity from the topology through the published workspace preset', () => {
  for (const unit of [topology.shell, ...topology.verticals]) {
    const config = createPresetUltramodernWorkspaceConfig({
      appId: unit.id,
      deployTarget: 'cloudflare',
      environment: {},
      from: pathToFileURL(path.join(appRoot, unit.path, 'modern.config.ts')),
    });
    expect(config.deploy?.worker?.name, unit.id).toBe(unit.cloudflare.workerName);
    const authored = readConfig(unit.path);
    expect(authored).toContain('presetUltramodernWorkspace(');
    expect(authored).not.toContain('cloudflareWorkerName');
  }
});

it('uses native public Worker fetch without fixed Shell vertical bindings or an SSR module API entry', () => {
  const shellConfig = readConfig(topology.shell.path);
  expect(shellConfig).toContain('createWorkspaceModernConfig(');
  expect(shellConfig).not.toContain('dispatch_namespaces');
  expect(shellConfig).not.toContain('ONTOS_MODULES_NAMESPACE');
  expect(shellConfig).not.toContain('ULTRAMODERN_CLOUDFLARE_MODULE_DISPATCH_NAMESPACE');
  expect(shellConfig).not.toContain('ssrByEntries');
  expect(shellConfig).not.toContain('verticalServiceBindings');
  // A build variable must not rename a bound Worker or binding away from the topology.
  expect(shellConfig).not.toMatch(/_WORKER_(?:NAME|BINDING)'/u);
});
