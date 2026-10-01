import { readFileSync } from 'node:fs';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

// The development overlay's `ports` is the one local port map. Every other place that names a delivery
// unit's local port (its dev server default, the Shell's federation remotes, the browser-test web servers,
// the reference topology, the overlay's own URLs, and stage zerops.yaml) must agree with it.
const appRoot = new URL('../../', import.meta.url);
const readText = (path: string) => readFileSync(new URL(path, appRoot), 'utf-8');

const UnitUrlsSchema = Schema.Record(Schema.String, Schema.String);
const OverlaySchema = Schema.Struct({
  apis: UnitUrlsSchema,
  manifests: UnitUrlsSchema,
  ontosModuleManifests: UnitUrlsSchema,
  ports: Schema.Record(Schema.String, Schema.Number),
  serverExecution: Schema.Record(Schema.String, Schema.Json),
});
const VerticalSchema = Schema.Struct({
  id: Schema.String,
  moduleFederation: Schema.Struct({ name: Schema.String }),
  path: Schema.String,
});
const TopologySchema = Schema.Struct({
  shell: Schema.Struct({ id: Schema.String, path: Schema.String }),
  verticals: Schema.Array(Schema.Json),
});
const ZeropsYamlSchema = Schema.Struct({
  zerops: Schema.Array(
    Schema.Struct({
      run: Schema.Struct({ envVariables: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
      setup: Schema.String,
    }),
  ),
});

const overlay = Schema.decodeUnknownSync(Schema.fromJsonString(OverlaySchema))(
  readText('topology/local-overlays/development.json'),
);
const topology = Schema.decodeUnknownSync(Schema.fromJsonString(TopologySchema))(
  readText('topology/reference-topology.json'),
);
const verticals = topology.verticals.map((source) => ({
  ...Schema.decodeUnknownSync(VerticalSchema)(source),
  source,
}));
const unitIds = [topology.shell.id, ...verticals.map(({ id }) => id)];
const { ports } = overlay;

const portOf = (unitId: string): number => {
  const port = ports[unitId];
  if (port === undefined) {
    throw new Error(`topology/local-overlays/development.json ports has no entry for ${unitId}`);
  }
  return port;
};

/** Every `localhost` or `127.0.0.1` port a unit's entry names, each against the unit's own port. */
const localPortMismatches = (label: string, unitId: string, entry: Schema.Json): readonly string[] =>
  [...JSON.stringify(entry).matchAll(/\/\/(?:localhost|127\.0\.0\.1):(?<port>\d+)/gu)]
    .map((match) => Number(match.groups?.port))
    .filter((port) => port !== portOf(unitId))
    .map((port) => `${label}.${unitId} uses ${port}, expected ${portOf(unitId)}`);

it('gives every delivery unit its own local port', () => {
  expect(new Set(Object.keys(ports))).toEqual(new Set(unitIds));
  const owners = new Map<number, string[]>();
  for (const [unitId, port] of Object.entries(ports)) {
    owners.set(port, [...(owners.get(port) ?? []), unitId]);
  }
  expect([...owners.values()].filter((ids) => ids.length > 1)).toEqual([]);
});

it('names each unit only by its own port in the overlay and the reference topology', () => {
  const sections = {
    apis: overlay.apis,
    manifests: overlay.manifests,
    ontosModuleManifests: overlay.ontosModuleManifests,
    serverExecution: overlay.serverExecution,
  };
  const mismatches = [
    ...Object.entries(sections).flatMap(([section, entries]) =>
      Object.entries(entries).flatMap(([unitId, entry]) => localPortMismatches(`overlay.${section}`, unitId, entry)),
    ),
    // The Shell's topology entry also names its verticals' URLs, so only each vertical's own entry is checked.
    ...verticals.flatMap(({ id, source }) => localPortMismatches('topology.verticals', id, source)),
  ];
  expect(mismatches).toEqual([]);
});

it('starts each vertical dev server on its overlay port', () => {
  for (const vertical of verticals) {
    const defaults = [...readText(`${vertical.path}/modern.config.ts`).matchAll(/defaultPort: (?<port>\d+),/gu)].map(
      (match) => match.groups?.port,
    );
    expect(`${vertical.id} ${defaults.join(',')}`).toBe(`${vertical.id} ${portOf(vertical.id)}`);
  }
});

it('starts the Shell and its browser tests on the Shell overlay port', () => {
  const shellPort = portOf(topology.shell.id);
  expect(readText(`${topology.shell.path}/modern.config.ts`)).toMatch(
    new RegExp(`getBuildConfigEnvironment\\('SHELL_SUPER_APP_PORT'\\)[^;]*\\(\\) => ${shellPort},`, 'u'),
  );
  expect(readText(`${topology.shell.path}/playwright.config.ts`)).toContain(
    `playwrightConfig.SHELL_SUPER_APP_PORT ?? ${shellPort};`,
  );
});

it('federates and waits for each vertical on its overlay port', () => {
  const unitByFederationName = new Map(verticals.map(({ id, moduleFederation }) => [moduleFederation.name, id]));
  const remotes = [
    ...readText(`${topology.shell.path}/module-federation.config.ts`).matchAll(
      /mfName: '(?<name>[^']+)',\s+port: (?<port>\d+),/gu,
    ),
  ].map((match) => ({ name: match.groups?.name ?? '', port: match.groups?.port }));
  expect(remotes.length).toBeGreaterThan(0);
  for (const { name, port } of remotes) {
    const unitId = unitByFederationName.get(name) ?? 'an unknown vertical';
    expect(`${name} ${port}`).toBe(`${name} ${portOf(unitId)}`);
  }

  const readinessUrls = [
    ...readText(`${topology.shell.path}/playwright.config.ts`).matchAll(
      /url: 'http:\/\/127\.0\.0\.1:(?<port>\d+)\/(?<unit>[a-z-]+)-api\//gu,
    ),
  ].map((match) => ({ port: match.groups?.port, unitId: match.groups?.unit ?? '' }));
  expect(readinessUrls.length).toBeGreaterThan(0);
  for (const { port, unitId } of readinessUrls) {
    expect(`${unitId} ${port}`).toBe(`${unitId} ${portOf(unitId)}`);
  }
});

it('runs each unit and its outbox worker on the unit overlay port in stage zerops.yaml', () => {
  const { zerops } = Schema.decodeUnknownSync(ZeropsYamlSchema)(parse(readText('zerops.yaml')));
  const unitBySetup = new Map(
    unitIds.flatMap((unitId) => [
      [unitId.replaceAll('-', ''), unitId],
      [unitId, unitId],
      [`${unitId}-worker`, unitId],
    ]),
  );
  const setups = zerops.flatMap(({ run, setup }) => {
    const unitId = unitBySetup.get(setup);
    const port = run.envVariables?.PORT;
    return unitId === undefined || port === undefined ? [] : [{ port, setup, unitId }];
  });
  expect(setups.length).toBeGreaterThanOrEqual(unitIds.length);
  for (const { port, setup, unitId } of setups) {
    expect(`${setup} ${port}`).toBe(`${setup} ${portOf(unitId)}`);
  }
});

it('serves each vertical development module contract the Shell discovers', () => {
  const PackageScriptsSchema = Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) });
  const discovered = new Set(Object.keys(overlay.ontosModuleManifests));
  const missing = verticals.flatMap(({ id, path }) => {
    const { dev } = Schema.decodeUnknownSync(Schema.fromJsonString(PackageScriptsSchema))(
      readText(`${path}/package.json`),
    ).scripts;
    if (dev === undefined || !discovered.has(id)) {
      return [];
    }
    const config = readText(`${path}/modern.config.ts`);
    return [
      ...(dev.startsWith(`node ../../scripts/prepare-dev-module-contract.mts ${id} && `)
        ? []
        : [`${id} dev script does not prepare its module contract`]),
      ...(/createModernConfig\(|createDevelopmentContractMiddleware\(|'\/\.well-known\/ontos-module-manifest\.json'/u.test(
        config,
      )
        ? []
        : [`${id} dev server does not serve /.well-known/ontos-module-manifest.json`]),
    ];
  });
  expect(missing).toEqual([]);
});
