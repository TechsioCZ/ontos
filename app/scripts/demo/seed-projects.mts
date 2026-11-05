#!/usr/bin/env node
/**
 * Additive tenant-wide Projekty for the demo tenant, created through the public Projects Actions as the tenant
 * administrator, so audit, outbox and the Search projection stay native. Projects are matched by prefix through the
 * owner's Search read; a re-run creates only the missing ones. A sub-project names its parent by prefix.
 *
 *   node scripts/demo/seed-projects.mts [--apply]
 *
 * Environment: ONTOS_DEMO_SEED_URL (default http://localhost:3020), ONTOS_DEMO_PASSWORD (default password1234).
 */
import { NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Exit, Layer, Option, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import {
  CreateProjectPayloadSchema,
  CreateProjectResultSchema,
} from '../../verticals/projects/shared/actions/create-project.ts';
import {
  ProjectOwnerCandidatesRequestSchema,
  ProjectOwnerCandidatesResponseSchema,
} from '../../verticals/projects/shared/apis/project-owner-candidates.ts';
import {
  ProjectsProviderRequestSchema,
  ProjectsProviderResponseSchema,
} from '../../verticals/projects/shared/apis/projects-search.ts';
import { personaPrincipalIds } from './company-content.mts';
import { demoLegalEntityId, demoTenantId } from './fixture-ids.mts';
import { connectSeedClient, DemoSeedError } from './seed-client.mts';
import type { SeedClient } from './seed-client.mts';

const audience = 'projects';
const writerEmail = 'obchod@demo.ontos';

interface ProjectSpec {
  readonly name: string;
  /** Login e-mail of the Project Owner (must be an eligible owner in the tenant). */
  readonly owner: string;
  readonly parent?: string;
  readonly prefix: string;
  readonly shortText: string;
}

/** Parents come before their sub-projects. */
const projectSpecs: readonly ProjectSpec[] = [
  {
    name: 'Rekonstrukce domu Vinohradská 12',
    owner: 'management@najempark.demo',
    prefix: 'REK',
    shortText: 'Výměna stoupaček, nové výtahy a zateplení; koordinace s nájemníky během oprav.',
  },
  {
    name: 'Zateplení fasády Vinohradská 12',
    owner: 'operations@najempark.demo',
    parent: 'REK',
    prefix: 'FAS',
    shortText: 'Kontaktní zateplení uliční a dvorní fasády, lešení od dubna.',
  },
  {
    name: 'Výměna výtahů Vinohradská 12',
    owner: 'provoz@najempark.demo',
    parent: 'REK',
    prefix: 'VYT',
    shortText: 'Dva nové výtahy Schindler, revize a předání do provozu.',
  },
  {
    name: 'Pronájem bytů Karlín',
    owner: 'management@najempark.demo',
    prefix: 'KAR',
    shortText: 'Obsazení 14 nových bytů v Karlíně do konce čtvrtletí.',
  },
  {
    name: 'Přestavba skladu Olomouc',
    owner: 'vedouci@hanak.demo',
    prefix: 'SKL',
    shortText: 'Nové regály, vychystávací zóna a skenery pro velkoobchodní sklad.',
  },
  {
    name: 'Rozšíření sortimentu nářadí',
    owner: 'spravce@hanak.demo',
    parent: 'SKL',
    prefix: 'NAR',
    shortText: 'Zalistování 120 položek ručního nářadí od dvou nových dodavatelů.',
  },
  {
    name: 'Spuštění e-shopu Kavárna Doma',
    owner: 'eshop@kavarna.demo',
    prefix: 'ESH',
    shortText: 'Online prodej výběrové kávy a příslušenství, platby kartou a doprava.',
  },
  {
    name: 'Produktové fotografie kávy',
    owner: 'eshop@kavarna.demo',
    parent: 'ESH',
    prefix: 'FOT',
    shortText: 'Focení 40 druhů kávy a balení pro e-shop.',
  },
];

/** Prefix → Project ID of the seeded prefixes that already exist, via the owner's Search read. */
const existingProjects = Effect.fn('SeedProjects.existingProjects')(function* existingProjects(client: SeedClient) {
  const found = new Map<string, string>();
  for (const spec of projectSpecs) {
    const hits = yield* client.call(
      audience,
      '/projects.core/search/projects',
      ProjectsProviderRequestSchema,
      { includeArchived: true, query: spec.prefix },
      ProjectsProviderResponseSchema,
    );
    const hit = hits.find((item) => item.prefix === spec.prefix);
    if (hit !== undefined) {
      found.set(spec.prefix, hit.ref.resourceId);
    }
  }
  return found;
});

const ownerPrincipalId = Effect.fn('SeedProjects.ownerPrincipalId')(function* ownerPrincipalId(
  client: SeedClient,
  spec: ProjectSpec,
) {
  const principalId = personaPrincipalIds.get(spec.owner);
  if (principalId === undefined) {
    return yield* new DemoSeedError({ reason: `Persona ${spec.owner} is unknown; run the people seed first.` });
  }
  const { candidates } = yield* client.call(
    audience,
    '/reads/project-owner-candidates',
    ProjectOwnerCandidatesRequestSchema,
    { prefix: spec.prefix, query: '' },
    ProjectOwnerCandidatesResponseSchema,
  );
  if (!candidates.some((candidate) => candidate.principalId === principalId)) {
    return yield* new DemoSeedError({ reason: `${spec.owner} is not an eligible Project Owner in the demo tenant.` });
  }
  return principalId;
});

const seedProjects = Effect.fn('SeedProjects.seed')(function* seedProjects(
  shellUrl: string,
  password: Redacted.Redacted,
  apply: boolean,
) {
  const client = yield* Effect.acquireRelease(
    connectSeedClient({ legalEntityId: demoLegalEntityId, shellUrl, tenantId: demoTenantId }, writerEmail, password),
    (connected) => Effect.ignore(connected.signOut),
  );
  const projectIds = yield* existingProjects(client);
  const pending = projectSpecs.filter((spec) => !projectIds.has(spec.prefix));
  // Owners are resolved before the first write, so a preflight run checks them too.
  const owners = yield* Effect.forEach(pending, (spec) => ownerPrincipalId(client, spec), { concurrency: 1 });
  for (const [index, spec] of (apply ? pending : []).entries()) {
    const parentProjectId = spec.parent === undefined ? undefined : projectIds.get(spec.parent);
    if (spec.parent !== undefined && parentProjectId === undefined) {
      return yield* new DemoSeedError({ reason: `Parent ${spec.parent} of ${spec.prefix} was not found.` });
    }
    const created = yield* client.call(
      audience,
      '/projects/actions/create-project',
      CreateProjectPayloadSchema,
      {
        name: spec.name,
        ownerPrincipalId: owners[index] ?? '',
        parentProjectId: Option.fromNullishOr(parentProjectId),
        prefix: spec.prefix,
        shortText: Option.some(spec.shortText),
      },
      CreateProjectResultSchema,
      true,
    );
    projectIds.set(created.prefix, created.projectId);
  }
  const verb = apply ? 'added' : 'missing';
  return yield* Console.log(`Projekty: ${verb} ${pending.length} [${pending.map((spec) => spec.prefix).join(', ')}]`);
});

const main = (apply: boolean) =>
  Effect.gen(function* run() {
    const shellUrl = yield* Config.String('ONTOS_DEMO_SEED_URL').pipe(Config.withDefault('http://localhost:3020'));
    const password = yield* Config.Redacted('ONTOS_DEMO_PASSWORD').pipe(
      Config.withDefault(Redacted.make('password1234')),
    );
    yield* Effect.scoped(seedProjects(shellUrl, password, apply));
    if (!apply) {
      yield* Console.log('No data changed. Run with --apply to add the missing projects.');
    }
  });

const command = Command.make(
  'seed-projects',
  { apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)) },
  ({ apply }) =>
    main(apply).pipe(
      Effect.tapError((failure) =>
        Console.error(
          Schema.is(DemoSeedError)(failure)
            ? failure.reason
            : `Seeder stopped (${failure._tag}); credentials and response bodies are not logged.`,
        ),
      ),
    ),
);

if (import.meta.main) {
  const runtime = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  );
  const result = await Effect.runPromiseExit(Effect.scoped(Layer.build(runtime)));
  process.exitCode = Exit.isFailure(result) ? 1 : 0;
}
