import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  generateZeropsProviderDeployment,
  generateZeropsProviderImports,
  generateZeropsProviderMigrations,
  generateZeropsMigratorInventory,
  readZeropsProviderTopology,
  readZeropsToolchain,
} from '../generate-zerops-provider-deployment.mts';

const root = path.resolve(import.meta.dirname, '../..');
const invalidMigrationOwner = 'Invalid or duplicate topology migration owner';
const toolchain = { node: '26.7.0', pnpm: '12.4.2' };
const ledgerSource = "zerops:\n  - setup: 'ledger'\n\n  - setup: 'shellsuperapp'\n";
const ledgerPath = 'verticals/ledger';
const projectsPath = 'verticals/projects';
const ledger = {
  id: 'ledger',
  package: '@app/ledger',
  path: ledgerPath,
  port: 4140,
};

it.effect('reproduces the checked-in provider setups from topology and preserves other services', () =>
  Effect.gen(function* testProviderReproducer() {
    const fs = yield* FileSystem.FileSystem;
    const source = yield* fs.readFileString(path.join(root, 'zerops.yaml'));
    const topology = yield* readZeropsProviderTopology(root);
    const checkedInToolchain = yield* readZeropsToolchain(
      yield* fs.readFileString(path.join(root, '.mise.toml')),
      yield* fs.readFileString(path.join(root, 'package.json')),
    );
    expect(yield* generateZeropsProviderDeployment(source, topology, checkedInToolchain)).toBe(source);
    const imports = yield* fs.readFileString(path.join(root, 'zerops-import.yaml'));
    expect(yield* generateZeropsProviderImports(imports, topology)).toBe(imports);
    for (const vertical of topology.verticals) {
      expect(source).toContain(`  - setup: '${vertical.id}'\n`);
      expect(source).toContain(
        `--app '${vertical.id}' --package '${vertical.package}' --package-dir '${vertical.path}'`,
      );
    }
    expect(source).toContain("  - setup: 'migrator'\n");
    expect(source).toContain("  - setup: 'shellsuperapp'\n");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('generates missing public provider imports and preserves private services idempotently', () =>
  Effect.gen(function* importsAreComplete() {
    const source =
      'services:\n  - hostname: db18\n    type: postgresql:single@18\n  - hostname: ledgerworker\n    type: nodejs@24\n';
    const generated = yield* generateZeropsProviderImports(source, { verticals: [ledger] });
    expect(generated).toContain(source);
    expect(generated).toContain('  - hostname: ledger\n    type: nodejs@24\n    enableSubdomainAccess: true');
    expect(yield* generateZeropsProviderImports(generated, { verticals: [ledger] })).toBe(generated);
    for (const invalidSource of [
      'services:\n  - hostname: ledger\n    type: nodejs@24\n',
      'services:\n  - hostname: db18\n    type: postgresql:single@18\n  - hostname: db18\n    type: postgresql:single@18\n',
    ]) {
      expect(
        (yield* Effect.flip(generateZeropsProviderImports(invalidSource, { verticals: [ledger] }))).reason,
      ).toMatch(/Zerops provider import drift|Duplicate Zerops service import hostname/u);
    }
  }),
);

it.effect('rejects duplicate provider identity and port instead of emitting ambiguous YAML', () =>
  Effect.gen(function* invalidDuplicates() {
    const vertical = ledger;
    const source = ledgerSource;
    expect(
      (yield* Effect.flip(generateZeropsProviderDeployment(source, { verticals: [vertical, vertical] }, toolchain)))
        .reason,
    ).toBe('Duplicate topology provider: ledger');
    expect(
      (yield* Effect.flip(
        generateZeropsProviderDeployment(
          source,
          {
            verticals: [vertical, { ...vertical, id: 'invoice', package: '@app/invoice', path: 'verticals/invoice' }],
          },
          toolchain,
        ),
      )).reason,
    ).toBe('Duplicate topology provider port: 4140');
  }),
);

it.effect('rejects malformed identity, source boundaries, and provider drift', () =>
  Effect.gen(function* invalidProvider() {
    const vertical = ledger;
    const source = ledgerSource;
    expect(
      (yield* Effect.flip(
        generateZeropsProviderDeployment(source, { verticals: [{ ...vertical, path: 'verticals/other' }] }, toolchain),
      )).reason,
    ).toBe('Invalid topology provider identity: ledger');
    expect(
      (yield* Effect.flip(generateZeropsProviderDeployment('zerops:\n', { verticals: [vertical] }, toolchain))).reason,
    ).toBe('Missing legacy provider section or Shell boundary');
    const generated = yield* generateZeropsProviderDeployment(source, { verticals: [vertical] }, toolchain);
    expect(yield* generateZeropsProviderDeployment(generated, { verticals: [vertical] }, toolchain)).toBe(generated);
    expect(
      yield* generateZeropsProviderDeployment(
        generated.replace("PORT: '4140'", "PORT: '4141'"),
        {
          verticals: [vertical],
        },
        toolchain,
      ),
    ).toBe(generated);
  }),
);

it.effect('keeps provider startup independent of composition availability', () =>
  Effect.gen(function* independentCompositionStartup() {
    const customerContext = {
      id: 'commerce-customer-context',
      package: '@app/commerce-customer-context',
      path: 'verticals/commerce-customer-context',
      port: 4101,
    };
    const partyRegistry = {
      id: 'party-registry',
      package: '@app/party-registry',
      path: 'verticals/party-registry',
      port: 4102,
    };
    const source = "zerops:\n  - setup: 'commerce-customer-context'\n\n  - setup: 'shellsuperapp'\n";
    const generated = yield* generateZeropsProviderDeployment(
      source,
      {
        verticals: [customerContext, partyRegistry],
      },
      toolchain,
    );
    const customerContextStart = generated.indexOf("  - setup: 'commerce-customer-context'");
    const partyRegistryStart = generated.indexOf("  - setup: 'party-registry'");
    const customerContextBlock = generated.slice(customerContextStart, partyRegistryStart);
    const partyRegistryBlock = generated.slice(
      partyRegistryStart,
      generated.indexOf('  # </generated', partyRegistryStart),
    );

    expect(customerContextBlock).toContain("start: sh -c 'cd app/.zerops/runtime/commerce-customer-context");
    expect(partyRegistryBlock).toContain("start: sh -c 'cd app/.zerops/runtime/party-registry");
    expect(generated).not.toContain('ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON');
    expect(generated).not.toContain('test -n');
  }),
);

it.effect('pins the build toolchain from .mise.toml and packageManager and ships Node with the runtime', () =>
  Effect.gen(function* toolchainPins() {
    const vertical = ledger;
    const pinned = yield* readZeropsToolchain(
      '[tools]\nnode = "27.1.0"\n',
      JSON.stringify({ packageManager: 'pnpm@12.5.0+sha512.abc' }),
    );
    expect(pinned).toEqual({ node: '27.1.0', pnpm: '12.5.0' });
    const generated = yield* generateZeropsProviderDeployment(ledgerSource, { verticals: [vertical] }, pinned);
    expect(generated).toContain('install-zerops-node.sh 27.1.0 12.5.0');
    expect(generated).toContain(
      `cp -a "$HOME/.local/node-27.1.0/bin" "$HOME/.local/node-27.1.0/lib" 'app/.zerops/runtime/ledger/node/'`,
    );
    expect(generated).toContain('PATH="$PWD/node/bin:$PATH" exec npm run serve');
    expect(generated).not.toContain('initCommands');
    expect(generated).not.toMatch(/virtual-store|VIRTUAL_STORE|--force/u);
    expect(
      (yield* Effect.flip(readZeropsToolchain('[tools]\nnode = "lts"\n', '{"packageManager":"pnpm@12.5.0"}'))).reason,
    ).toBe('.mise.toml must pin node = "<major>.<minor>.<patch>" under [tools]');
    expect(
      (yield* Effect.flip(readZeropsToolchain('node = "27.1.0"\n', '{"packageManager":"npm@11.0.0"}'))).reason,
    ).toBe('package.json#packageManager must pin pnpm@<major>.<minor>.<patch>');
  }),
);

const migratorFixture =
  "    yield* migrate('verticals/ledger', 'drizzle.config.ts');\n    yield* runAppScript('scripts/postgres/bootstrap-runtime-role.mts');\n    yield* runAppScript('scripts/verify-application-db-schema.mts');\n";
it.effect('adds new topology migrations once before grants and schema verification', () =>
  Effect.gen(function* migrationOwnerGeneration() {
    const owners = [ledgerPath, projectsPath];
    const generated = yield* generateZeropsProviderMigrations(migratorFixture, owners);
    expect(generated.indexOf("migrate('verticals/projects'")).toBeLessThan(
      generated.indexOf("runAppScript('scripts/postgres/bootstrap-runtime-role"),
    );
    expect(generated.match(/migrate\('verticals\/ledger'/gu)).toHaveLength(1);
    expect(yield* generateZeropsProviderMigrations(generated, owners)).toBe(generated);
  }),
);
it.effect('retains existing migration order and rejects invalid or duplicate owners', () =>
  Effect.gen(function* invalidMigrationOwners() {
    expect(yield* generateZeropsProviderMigrations(migratorFixture, [ledgerPath])).toBe(migratorFixture);
    const invalidOwner = yield* generateZeropsProviderMigrations(migratorFixture, ['../escape']).pipe(Effect.flip);
    expect(invalidOwner.reason).toBe(invalidMigrationOwner);
    const duplicateOwner = yield* generateZeropsProviderMigrations(migratorFixture, [projectsPath, projectsPath]).pipe(
      Effect.flip,
    );
    expect(duplicateOwner.reason).toBe(invalidMigrationOwner);
  }),
);

it.effect('ships missing migration owners without changing other deployment files', () =>
  Effect.gen(function* migratorArtifactCoverage() {
    const source =
      "zerops:\n  - setup: 'migrator'\n    build:\n      deployFiles:\n        - 'app/packages'\n        - 'app/verticals/ledger'\n    deploy:\n      temporaryShutdown: false\n";
    const generated = yield* generateZeropsMigratorInventory(source, [ledgerPath, projectsPath]);
    expect(generated).toContain(
      "        - 'app/packages'\n        - 'app/verticals/ledger'\n        - 'app/verticals/projects'\n    deploy:",
    );
    expect(yield* generateZeropsMigratorInventory(generated, [ledgerPath, projectsPath])).toBe(generated);
    expect((yield* Effect.flip(generateZeropsMigratorInventory(source, ['../outside']))).reason).toBe(
      invalidMigrationOwner,
    );
    expect((yield* Effect.flip(generateZeropsMigratorInventory('zerops:\n', [projectsPath]))).reason).toBe(
      'Missing migrator deployFiles inventory',
    );
  }),
);

const databaseUrls = (section: string) => section.match(/^ {8}[A-Z_]*DATABASE_URL: .*$/gmu) ?? [];

it.effect('binds Party Registry to its dedicated request identity and every other provider to the shared role', () =>
  Effect.gen(function* providerDatabaseIdentities() {
    const party = {
      id: 'party-registry',
      package: '@app/party-registry',
      path: 'verticals/party-registry',
      port: 4102,
    };
    const generated = yield* generateZeropsProviderDeployment(
      "zerops:\n  - setup: 'party-registry'\n\n  - setup: 'shellsuperapp'\n",
      { verticals: [party, ledger] },
      toolchain,
    );
    const [partySection = '', ledgerSection = ''] = generated
      .split(/(?=^ {2}- setup: )/mu)
      .filter(
        (section) => section.startsWith("  - setup: 'party-registry'") || section.startsWith("  - setup: 'ledger'"),
      );
    expect(databaseUrls(partySection)).toStrictEqual([
      `        PARTY_REGISTRY_DATABASE_URL: postgresql://party_registry_runtime:\${migrator_PARTY_REGISTRY_DB_PASSWORD}@\${db18_hostname}:\${db18_port}/\${db18_dbName}`,
    ]);
    expect(databaseUrls(ledgerSection)).toStrictEqual([
      `        DATABASE_URL: postgresql://ontos_runtime:\${db18_password}@\${db18_hostname}:\${db18_port}/\${db18_dbName}`,
    ]);
    // Zerops environment keys stay sorted, so the dedicated URL sits between NODE_ENV and PORT.
    expect(partySection).toMatch(/NODE_ENV: production\n {8}PARTY_REGISTRY_DATABASE_URL: [^\n]+\n {8}PORT: '4102'/u);
  }),
);
