import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Schema, Stream } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

const root = path.resolve(import.meta.dirname, '../..');
const installerPath = path.join(root, 'scripts/install-zerops-node.sh');
const spiceDbImagePattern = /authzed\/spicedb:v\d+\.\d+\.\d+@sha256:[a-f0-9]{64}/gu;
const RenovateSchema = Schema.fromJsonString(
  Schema.Struct({
    customManagers: Schema.Array(
      Schema.Struct({
        datasourceTemplate: Schema.String,
        depNameTemplate: Schema.optional(Schema.String),
        managerFilePatterns: Schema.Array(Schema.String),
        matchStrings: Schema.Array(Schema.String),
      }),
    ),
    ignoreUnstable: Schema.Boolean,
    minimumReleaseAge: Schema.String,
    packageRules: Schema.Array(
      Schema.Struct({
        dependencyDashboardApproval: Schema.optional(Schema.Boolean),
        matchUpdateTypes: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  }),
);

type RenovateConfiguration = typeof RenovateSchema.Type;
type RenovateManager = RenovateConfiguration['customManagers'][number];

const extractVersions = (source: string, manager: RenovateManager, dependency: string) =>
  manager.matchStrings.flatMap((pattern) =>
    [...source.matchAll(new RegExp(pattern, 'gu'))]
      .filter((match) => (match.groups?.depName ?? manager.depNameTemplate) === dependency)
      .map((match) => match.groups?.currentValue),
  );

const extractExternalPin = Effect.fn('extractExternalPin')(function* extractPin(
  config: RenovateConfiguration,
  file: string,
  datasource: string,
  dependency: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* fs.readFileString(path.join(root, '..', file));
  return config.customManagers
    .filter((manager) => manager.datasourceTemplate === datasource)
    .filter((manager) =>
      manager.managerFilePatterns.some((pattern) => new RegExp(pattern.slice(1, -1), 'u').test(file)),
    )
    .flatMap((manager) => extractVersions(source, manager, dependency));
});

it.effect('uses the same exact SpiceDB image for development, migration and serving', () =>
  Effect.gen(function* imageParity() {
    const fs = yield* FileSystem.FileSystem;
    const images = yield* Effect.all(
      ['docker-compose.yml', 'zerops.yaml', 'scripts/run-zerops-spicedb.sh'].map((file) =>
        fs.readFileString(path.join(root, file)).pipe(Effect.map((source) => source.match(spiceDbImagePattern) ?? [])),
      ),
    );
    expect(images.map((matches) => matches.length)).toEqual([1, 1, 2]);
    expect(new Set(images.flat()).size).toBe(1);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('uses the same immutable PostgreSQL image for development, CI and datastore tooling', () =>
  Effect.gen(function* postgresImageParity() {
    const fs = yield* FileSystem.FileSystem;
    const images = yield* Effect.all(
      [
        'docker-compose.yml',
        'zerops.yaml',
        'scripts/run-zerops-spicedb.sh',
        '../.github/workflows/ultramodern-workspace-gates.yml',
      ].map((file) =>
        fs
          .readFileString(path.join(root, file))
          .pipe(Effect.map((source) => source.match(/postgres:\d+\.\d+-alpine@sha256:[a-f0-9]{64}/gu) ?? [])),
      ),
    );
    expect(images.map((matches) => matches.length)).toEqual([1, 1, 1, 1]);
    expect(new Set(images.flat()).size).toBe(1);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('discovers external pins without removing release-age or major-update approval safeguards', () =>
  Effect.gen(function* renovationPolicy() {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* fs
      .readFileString(path.join(root, '../.github/renovate.json'))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(RenovateSchema)));
    expect(yield* fs.exists(path.join(root, '.github/renovate.json'))).toBe(false);
    expect(config.ignoreUnstable).toBe(true);
    expect(config.minimumReleaseAge).toBe('1 day');
    expect(
      config.packageRules.find((rule) => rule.matchUpdateTypes?.includes('major') === true)
        ?.dependencyDashboardApproval,
    ).toBe(true);
    const extracted = yield* Effect.all(
      [
        ['app/scripts/run-zerops-spicedb.sh', 'docker', 'authzed/spicedb'],
        ['.github/actions/zerops-vpn/action.yml', 'npm', '@zerops/zcli'],
        ['app/scripts/locki-feature.sh', 'pypi', 'locki'],
        ['app/zerops.yaml', 'github-releases', 'cloudflare/cloudflared'],
      ].map(([file = '', datasource = '', dependency = '']) =>
        extractExternalPin(config, file, datasource, dependency),
      ),
    );
    expect(
      extracted.every((versions) => versions.length > 0 && versions.every((version) => version !== undefined)),
    ).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('rejects an unpinned Node version before downloading anything', () =>
  Effect.gen(function* rejectsUnknownNode() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(ChildProcess.make('/bin/sh', [installerPath, '0.0.0', '12.16.1']));
    const [code, stderr] = yield* Effect.all(
      [child.exitCode, child.stderr.pipe(Stream.decodeText(), Stream.mkString)],
      { concurrency: 'unbounded' },
    );
    expect(code).toBe(1);
    expect(stderr).toContain('No pinned checksum for Node 0.0.0');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('rejects a corrupt official Node archive and removes its temporary directory', () =>
  Effect.gen(function* rejectsCorruptArchive() {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fixture = yield* fs.makeTempDirectoryScoped();
    const bin = path.join(fixture, 'bin');
    const temporary = path.join(fixture, 'temporary');
    const home = path.join(fixture, 'home');
    for (const directory of [bin, temporary, home]) {
      yield* fs.makeDirectory(directory);
    }
    yield* fs.writeFileString(
      path.join(bin, 'curl'),
      '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\nprintf corrupt > "$2"\n',
    );
    yield* fs.chmod(path.join(bin, 'curl'), 0o700);
    const mise = yield* fs.readFileString(path.join(root, '.mise.toml'));
    const node = /^node = "(?<version>\d+\.\d+\.\d+)"$/mu.exec(mise)?.groups?.version ?? '';
    const installer = yield* fs.readFileString(installerPath);
    expect(installer).toContain(`${node}) node_checksum=`);
    const child = yield* spawner.spawn(
      ChildProcess.make('/bin/sh', [installerPath, node, '12.16.1'], {
        env: { HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`, TMPDIR: temporary },
      }),
    );
    const [code, stderr] = yield* Effect.all(
      [child.exitCode, child.stderr.pipe(Stream.decodeText(), Stream.mkString)],
      { concurrency: 'unbounded' },
    );
    expect(code).not.toBe(0);
    expect(stderr).toContain('checksum');
    expect(yield* fs.readDirectory(temporary)).toEqual([]);
    expect(yield* fs.readDirectory(home)).toEqual([]);
    expect(installer).toContain('https://nodejs.org/dist/');
    expect(installer).not.toContain('unofficial-builds');
    expect(installer).toContain("--proto '=https' --tlsv1.2");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
