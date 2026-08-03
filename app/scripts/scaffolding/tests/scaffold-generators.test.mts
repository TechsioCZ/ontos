import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { TrustedPrincipalContextSchema } from '../../../packages/core-runtime/src/actions/principal-context.ts';
import type { TrustedPrincipalContext } from '../../../packages/core-runtime/src/actions/principal-context.ts';
import {
  defineEffectBff,
  Effect,
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  HttpEffect,
  HttpServerResponse,
  Layer,
  Schema,
} from '@modern-js/plugin-bff/effect-edge';
import {
  GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS,
  GATEWAY_ASSERTION_TTL_SECONDS,
} from '../../../packages/shared-contracts/src/gateway-context.ts';
import { SignJWT, exportJWK, generateKeyPair, generateSecret, importJWK } from 'jose';
import { issueGatewayContextAssertion } from '../../../apps/shell-super-app/api/auth/gateway-issuer.ts';
import type { GatewayIssuerConfigValue } from '../../../apps/shell-super-app/api/auth/gateway-issuer-config.ts';
import { getHelpText, runScaffold } from '../cli.mts';
import type { ScaffoldCommand } from '../cli.mts';

interface Fixture {
  readonly root: string;
}

type GeneratedPrincipalErrorTag =
  | 'ActionPrincipalConfigurationError'
  | 'ActionPrincipalExpiredError'
  | 'ActionPrincipalInvalidError'
  | 'ActionPrincipalMissingError'
  | 'ActionPrincipalScopeError'
  | 'ActionPrincipalUnavailableError';

interface FixtureVertical {
  readonly appId: string;
  readonly mfBoundaryId: string;
  readonly namespace: string;
  readonly slug: string;
}

const inventoryVertical: FixtureVertical = {
  appId: 'inventory-stock',
  mfBoundaryId: 'verticalInventoryStock',
  namespace: 'inventory',
  slug: 'inventory-stock',
};

const billingVertical: FixtureVertical = {
  appId: 'billing',
  mfBoundaryId: 'verticalBilling',
  namespace: 'billing',
  slug: 'billing',
};

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const appRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const esbuildPath = path.join(appRoot, 'node_modules', '.bin', 'esbuild');
const oxfmtPath = path.join(appRoot, 'node_modules', '.bin', 'oxfmt');
const tscPath = path.join(appRoot, 'node_modules', '.bin', 'tsc');

const makeGatewayKey = async (
  kid: string,
): Promise<{
  configuration: GatewayIssuerConfigValue;
  publicJwk: Record<string, unknown>;
}> => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const privateJwk = await exportJWK(pair.privateKey);
  const publicJwk = await exportJWK(pair.publicKey);
  return {
    configuration: {
      issuer: 'https://shell.example.test',
      privateJwk: {
        alg: 'EdDSA',
        crv: 'Ed25519',
        d: privateJwk.d ?? '',
        kid,
        kty: 'OKP',
        use: 'sig',
        x: privateJwk.x ?? '',
      },
    },
    publicJwk: { ...publicJwk, alg: 'EdDSA', kid, use: 'sig' },
  };
};

const writeFixtureFile = async (
  root: string,
  relativePath: string,
  content: string,
): Promise<void> => {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
};

const createVertical = async (root: string, vertical: FixtureVertical): Promise<void> => {
  await writeFixtureFile(
    root,
    `verticals/${vertical.slug}/package.json`,
    json({
      dependencies: { zeta: '1.0.0' },
      exports: {
        './locales/cs': `./locales/cs/${vertical.namespace}.json`,
        './locales/en': `./locales/en/${vertical.namespace}.json`,
      },
      modernjs: {
        apiRuntime: 'effect',
        appId: vertical.appId,
        preset: 'presetUltramodern',
        role: 'module-federation-remote',
        topology: '../../topology/reference-topology.json',
      },
      name: `@app/${vertical.slug}`,
      private: true,
      scripts: { existing: 'preserve-me' },
      version: '0.1.0',
    }),
  );
  await Promise.all(
    ['cs', 'en'].map((locale) =>
      writeFixtureFile(
        root,
        `verticals/${vertical.slug}/locales/${locale}/${vertical.namespace}.json`,
        json({
          [vertical.namespace]: {
            existing: `${locale}-preserved`,
          },
        }),
      ),
    ),
  );
  await writeFixtureFile(
    root,
    `verticals/${vertical.slug}/src/routes/ultramodern-route-head.tsx`,
    'export const UltramodernRouteHead = () => null;\n',
  );
};

const createFixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(path.join(tmpdir(), 'ontos-scaffolding-'));
  await writeFixtureFile(root, 'package.json', json({ name: 'fixture', private: true }));
  await writeFixtureFile(
    root,
    'packages/core-runtime/src/index.ts',
    `export const existingCoreSurface = true;\n\n// <generated-global-policy-exports>\n// </generated-global-policy-exports>\n`,
  );
  await writeFixtureFile(
    root,
    'apps/shell-super-app/src/sentinel.ts',
    'export const shell = true;\n',
  );
  await createVertical(root, inventoryVertical);
  await createVertical(root, billingVertical);
  await writeFixtureFile(
    root,
    'topology/reference-topology.json',
    json({
      schemaVersion: 1,
      verticals: [inventoryVertical, billingVertical].map((vertical) => ({
        domain: vertical.namespace,
        id: vertical.appId,
        kind: 'vertical',
        moduleFederation: {
          name: vertical.mfBoundaryId,
          role: 'remote',
        },
        package: `@app/${vertical.slug}`,
        path: `verticals/${vertical.slug}`,
      })),
    }),
  );
  return { root };
};

const withFixture = async (run: (fixture: Fixture) => Promise<void>): Promise<void> => {
  const fixture = await createFixture();
  try {
    await run(fixture);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
};

const snapshotTree = async (root: string): Promise<Readonly<Record<string, string>>> => {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries
        .toSorted((left, right) => left.name.localeCompare(right.name))
        .map(async (entry) => {
          const entryPath = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            await visit(entryPath);
          } else if (entry.isFile()) {
            snapshot[path.relative(root, entryPath)] = await readFile(entryPath, 'utf-8');
          }
        }),
    );
  };
  await visit(root);
  return snapshot;
};

const readFixtureFile = (root: string, relativePath: string): Promise<string> =>
  readFile(path.join(root, relativePath), 'utf-8');

const run = (
  fixture: Fixture,
  command: ScaffoldCommand,
  arguments_: readonly string[],
  routeRefresh?: (appId: string) => void,
) =>
  runScaffold(command, arguments_, {
    routeRefresh: ({ appId }) => routeRefresh?.(appId),
    workspaceRoot: fixture.root,
  });

test('documents every command and treats --help as a write-free operation', async () => {
  await Promise.all(
    (
      [
        'action',
        'microvertical-action-boundary',
        'microvertical-page',
        'outbox-message',
        'policy',
      ] as const
    ).map(async (command) => {
      const result = await runScaffold(command, ['--', '--help'], {
        workspaceRoot: path.join(tmpdir(), 'does-not-need-to-exist'),
      });
      assert.deepEqual(result, { help: getHelpText(command), kind: 'help' });
      assert.match(result.help, new RegExp(`scaffold:${command}`, 'u'));
    }),
  );
});

test('rejects malformed command contracts and leaves the fixture unchanged', async () => {
  await withFixture(async (fixture) => {
    const before = await snapshotTree(fixture.root);
    const invalidCalls: readonly [ScaffoldCommand, readonly string[], RegExp][] = [
      ['action', ['--vertical', 'inventory-stock'], /missing required flag --action/u],
      [
        'action',
        ['--vertical', 'inventory-stock', '--action', 'create-order', '--unknown', 'x'],
        /unknown flag --unknown/u,
      ],
      [
        'action',
        ['--vertical', 'inventory-stock', '--action', 'create-order', '--action', 'again'],
        /only once/u,
      ],
      ['action', ['--vertical', '', '--action', 'create-order'], /non-empty value/u],
      ['action', ['--vertical', '../billing', '--action', 'create-order'], /lower-kebab-case/u],
      ['action', ['--vertical', '/tmp/billing', '--action', 'create-order'], /lower-kebab-case/u],
      [
        'action',
        ['--vertical', 'missing', '--action', 'create-order'],
        /package metadata is missing/u,
      ],
      [
        'microvertical-action-boundary',
        ['--vertical', 'inventory-stock', '--unknown', 'x'],
        /unknown flag --unknown/u,
      ],
      ['microvertical-action-boundary', ['--vertical', '../billing'], /lower-kebab-case/u],
      [
        'policy',
        ['--scope', 'global', '--policy', 'tenant-active', '--vertical', 'inventory-stock'],
        /forbidden/u,
      ],
      ['policy', ['--scope', 'microvertical', '--policy', 'tenant-active'], /required/u],
      ['policy', ['--scope', 'other', '--policy', 'tenant-active'], /global or microvertical/u],
      [
        'outbox-message',
        ['--vertical', 'inventory-stock', '--action', 'create-order', '--topic', 'Not.Safe'],
        /dot-separated/u,
      ],
    ];
    await Promise.all(
      invalidCalls.map(async ([command, arguments_, expected]) => {
        await assert.rejects(run(fixture, command, arguments_), expected);
        assert.deepEqual(await snapshotTree(fixture.root), before);
      }),
    );
  });
});

test('generates one immutable Action identity boundary and exact direct dependencies', async () => {
  await withFixture(async (fixture) => {
    const shellBefore = await readFixtureFile(fixture.root, 'apps/shell-super-app/src/sentinel.ts');
    const topologyBefore = await readFixtureFile(fixture.root, 'topology/reference-topology.json');
    const result = await run(fixture, 'microvertical-action-boundary', [
      '--vertical',
      'inventory-stock',
    ]);
    assert.equal(result.kind, 'generated');
    const server = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/api/auth/action-principal.ts',
    );
    const client = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/api/action-gateway.ts',
    );
    for (const source of [server, client]) {
      assert.match(source, /@ontos-action-boundary-owner inventory-stock/u);
      assert.match(source, /@ontos-action-boundary-audience inventory-stock/u);
      assert.match(source, /ACTION_GATEWAY_AUDIENCE = 'inventory-stock'/u);
    }
    assert.match(server, /algorithms: \['EdDSA'\]/u);
    assert.match(server, /@app\/core-runtime\/actions\/principal-context/u);
    assert.match(server, /TrustedPrincipalContextSchema/u);
    assert.match(server, /\^Bearer /u);
    assert.match(server, /Clock\.currentTimeMillis/u);
    assert.doesNotMatch(server, /Date\.now|Effect\.runPromise|decodeUnknownSync/u);
    assert.match(client, /acquire\(\{ audience: ACTION_GATEWAY_AUDIENCE \}/u);
    assert.doesNotMatch(client, /localStorage|sessionStorage/u);
    const packageJson = JSON.parse(
      await readFixtureFile(fixture.root, 'verticals/inventory-stock/package.json'),
    ) as { dependencies: Record<string, string>; scripts: Record<string, string> };
    assert.deepEqual(packageJson.dependencies, {
      '@app/core-runtime': 'workspace:*',
      '@app/shared-contracts': 'workspace:*',
      effect: '4.0.0-beta.97',
      jose: '6.2.5',
      zeta: '1.0.0',
    });
    assert.equal(packageJson.scripts['existing'], 'preserve-me');
    assert.equal(
      await readFixtureFile(fixture.root, 'apps/shell-super-app/src/sentinel.ts'),
      shellBefore,
    );
    assert.equal(
      await readFixtureFile(fixture.root, 'topology/reference-topology.json'),
      topologyBefore,
    );
  });
});

test('Action identity boundary preflight refuses unsafe writes', async () => {
  await withFixture(async (fixture) => {
    await run(fixture, 'microvertical-action-boundary', ['--vertical', 'inventory-stock']);
    const afterFirstRun = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'microvertical-action-boundary', ['--vertical', 'inventory-stock']),
      /refusing to overwrite existing business file/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), afterFirstRun);
  });
  await withFixture(async (fixture) => {
    const packagePath = path.join(fixture.root, 'verticals/inventory-stock/package.json');
    const packageJson = JSON.parse(await readFile(packagePath, 'utf-8')) as {
      dependencies: Record<string, string>;
    };
    packageJson.dependencies['jose'] = '^5.0.0';
    await writeFile(packagePath, json(packageJson), 'utf-8');
    const before = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'microvertical-action-boundary', ['--vertical', 'inventory-stock']),
      /incompatible jose dependency/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), before);
  });
});

test('generated verifier executes real Shell assertions and overlapping Ed25519 rotation', async () => {
  await withFixture(async (fixture) => {
    await run(fixture, 'microvertical-action-boundary', ['--vertical', 'inventory-stock']);
    await mkdir(path.join(fixture.root, 'node_modules', '@app'), { recursive: true });
    await symlink(
      path.join(appRoot, 'packages/core-runtime'),
      path.join(fixture.root, 'node_modules/@app/core-runtime'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'packages/shared-contracts'),
      path.join(fixture.root, 'node_modules/@app/shared-contracts'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'packages/core-runtime/node_modules/effect'),
      path.join(fixture.root, 'node_modules/effect'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'apps/shell-super-app/node_modules/jose'),
      path.join(fixture.root, 'node_modules/jose'),
      'dir',
    );
    const edgeBundleDirectory = path.join(fixture.root, 'edge-bundle');
    await mkdir(edgeBundleDirectory, { recursive: true });
    const edgeMetafile = path.join(edgeBundleDirectory, 'meta.json');
    const edgeBundle = spawnSync(
      esbuildPath,
      [
        path.join(fixture.root, 'verticals/inventory-stock/api/auth/action-principal.ts'),
        '--bundle',
        '--format=esm',
        `--metafile=${edgeMetafile}`,
        `--outfile=${path.join(edgeBundleDirectory, 'action-principal.mjs')}`,
        '--platform=browser',
      ],
      { encoding: 'utf-8' },
    );
    assert.equal(edgeBundle.status, 0, edgeBundle.stderr);
    const edgeInputs = Object.keys(
      (JSON.parse(await readFile(edgeMetafile, 'utf-8')) as { inputs: Record<string, unknown> })
        .inputs,
    ).join('\n');
    assert.doesNotMatch(edgeInputs, /core-runtime\/src\/(?:auth|db)|node:(?:crypto|path)|\/pg\//u);
    const generated = (await import(
      pathToFileURL(
        path.join(fixture.root, 'verticals/inventory-stock/api/auth/action-principal.ts'),
      ).href
    )) as {
      verifyActionPrincipal: (
        authorization: string | undefined,
        options: {
          currentTimeSeconds: Effect.Effect<number>;
          environment: Readonly<Record<string, string>>;
        },
      ) => Effect.Effect<TrustedPrincipalContext, { readonly _tag: GeneratedPrincipalErrorTag }>;
    };
    const generatedClient = (await import(
      pathToFileURL(path.join(fixture.root, 'verticals/inventory-stock/src/api/action-gateway.ts'))
        .href
    )) as {
      makeActionGateway: (
        acquire: (payload: { audience: string }) => Effect.Effect<{ token: string }>,
      ) => {
        invoke: <Success>(
          attempt: (authorization: string) => Effect.Effect<Success>,
        ) => Effect.Effect<Success>;
      };
    };
    const current = await makeGatewayKey('current');
    const retiring = await makeGatewayKey('retiring');
    const principal = {
      authMethod: 'session' as const,
      principalId: '40000000-0000-4000-8000-000000000001',
      tenantId: '50000000-0000-4000-8000-000000000001',
    };
    const issue = (
      configuration: GatewayIssuerConfigValue,
      issuedAt: number,
      audience = 'inventory-stock',
    ) =>
      Effect.runPromise(
        issueGatewayContextAssertion(
          { audience, principal },
          {
            currentTimeSeconds: Effect.succeed(issuedAt),
            generateJti: Effect.succeed('60000000-0000-4000-8000-000000000001'),
            loadAudiences: Effect.succeed(new Set([audience])),
            loadConfig: Effect.succeed(configuration),
          },
        ),
      );
    const environment = {
      ONTOS_GATEWAY_ISSUER: 'https://shell.example.test',
      ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
        keys: [current.publicJwk, retiring.publicJwk],
      }),
    };
    const currentAssertion = await issue(current.configuration, 1_700_000_000);
    const retiringAssertion = await issue(retiring.configuration, 1_700_000_000);
    const verify = (token: string, override = environment, now = 1_700_000_001) =>
      Effect.runPromise(
        generated.verifyActionPrincipal(`Bearer ${token}`, {
          currentTimeSeconds: Effect.succeed(now),
          environment: override,
        }),
      );

    assert.deepEqual(await verify(currentAssertion.token), principal);
    assert.deepEqual(await verify(retiringAssertion.token), principal);
    await assert.rejects(
      verify(
        retiringAssertion.token,
        {
          ...environment,
          ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [current.publicJwk] }),
        },
        1_700_000_000 + GATEWAY_ASSERTION_TTL_SECONDS + GATEWAY_ASSERTION_CLOCK_SKEW_SECONDS + 1,
      ),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalInvalidError',
    );
    const wrongAudience = await issue(current.configuration, 1_700_000_000, 'billing');
    await assert.rejects(
      verify(wrongAudience.token),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalScopeError',
    );
    const wrongIssuer = await issue(
      { ...current.configuration, issuer: 'https://other.example.test' },
      1_700_000_000,
    );
    await assert.rejects(
      verify(wrongIssuer.token),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalScopeError',
    );
    const unknownKid = await issue(
      {
        ...current.configuration,
        privateJwk: { ...current.configuration.privateJwk, kid: 'unknown' },
      },
      1_700_000_000,
    );
    await assert.rejects(
      verify(unknownKid.token),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalInvalidError',
    );
    const expired = await issue(current.configuration, 1_699_999_000);
    await assert.rejects(
      verify(expired.token),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalExpiredError',
    );
    const future = await issue(current.configuration, 1_700_000_032);
    await assert.rejects(
      verify(future.token),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalInvalidError',
    );
    const signingKey = await importJWK(current.configuration.privateJwk, 'EdDSA');
    const mismatchedSubject = await new SignJWT({ principal, ver: 1 })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'current', typ: 'JWT' })
      .setIssuer('https://shell.example.test')
      .setAudience('inventory-stock')
      .setSubject('70000000-0000-4000-8000-000000000001')
      .setIssuedAt(1_700_000_000)
      .setExpirationTime(1_700_000_300)
      .setJti('60000000-0000-4000-8000-000000000001')
      .sign(signingKey);
    await assert.rejects(
      verify(mismatchedSubject),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalInvalidError',
    );
    const invalidContext = await new SignJWT({
      principal: { ...principal, principalId: 'not-a-uuid' },
      ver: 1,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'current', typ: 'JWT' })
      .setIssuer('https://shell.example.test')
      .setAudience('inventory-stock')
      .setSubject('not-a-uuid')
      .setIssuedAt(1_700_000_000)
      .setExpirationTime(1_700_000_300)
      .setJti('60000000-0000-4000-8000-000000000001')
      .sign(signingKey);
    await assert.rejects(
      verify(invalidContext),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalInvalidError',
    );
    const hmacToken = await new SignJWT({ principal, ver: 1 })
      .setProtectedHeader({ alg: 'HS256', kid: 'current', typ: 'JWT' })
      .setIssuer('https://shell.example.test')
      .setAudience('inventory-stock')
      .setSubject(principal.principalId)
      .setIssuedAt(1_700_000_000)
      .setExpirationTime(1_700_000_300)
      .setJti('60000000-0000-4000-8000-000000000001')
      .sign(await generateSecret('HS256'));
    await assert.rejects(
      verify(hmacToken),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalInvalidError',
    );
    const tokenParts = currentAssertion.token.split('.');
    const encodedPayload = tokenParts[1] ?? '';
    const tampered = `${tokenParts[0]}.${encodedPayload.startsWith('a') ? 'b' : 'a'}${encodedPayload.slice(1)}.${tokenParts[2]}`;
    await assert.rejects(
      verify(tampered),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalInvalidError',
    );
    await assert.rejects(
      Effect.runPromise(
        generated.verifyActionPrincipal(undefined, {
          currentTimeSeconds: Effect.succeed(1_700_000_001),
          environment,
        }),
      ),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalMissingError',
    );
    await assert.rejects(
      Effect.runPromise(
        generated.verifyActionPrincipal('bearer malformed', {
          currentTimeSeconds: Effect.succeed(1_700_000_001),
          environment,
        }),
      ),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalInvalidError',
    );
    await assert.rejects(
      Effect.runPromise(
        generated.verifyActionPrincipal(`Bearer ${currentAssertion.token}`, {
          currentTimeSeconds: Effect.succeed(1_700_000_001),
          environment: {},
        }),
      ),
      (error: { _tag?: string }) => error._tag === 'ActionPrincipalConfigurationError',
    );
    let acquisitions = 0;
    const authorizations: string[] = [];
    const idempotencyKey = 'caller-owned-idempotency-key';
    const actionGateway = generatedClient.makeActionGateway(({ audience }) => {
      acquisitions += 1;
      assert.equal(audience, 'inventory-stock');
      return Effect.succeed({ token: `attempt-${acquisitions}` });
    });
    const attempt = (authorization: string) => {
      authorizations.push(authorization);
      return Effect.succeed(idempotencyKey);
    };
    assert.equal(await Effect.runPromise(actionGateway.invoke(attempt)), idempotencyKey);
    assert.equal(await Effect.runPromise(actionGateway.invoke(attempt)), idempotencyKey);
    assert.deepEqual(authorizations, ['Bearer attempt-1', 'Bearer attempt-2']);

    const problemFields = {
      detail: Schema.String,
      status: Schema.Finite,
      title: Schema.String,
      type: Schema.String,
    };
    const asProblemDetails = HttpApiSchema.asJson({ contentType: 'application/problem+json' });
    const ActionAuthenticationProblemSchema = Schema.TaggedStruct(
      'ActionAuthenticationProblem',
      problemFields,
    ).pipe(asProblemDetails, HttpApiSchema.status(401));
    const ActionVerificationUnavailableProblemSchema = Schema.TaggedStruct(
      'ActionVerificationUnavailableProblem',
      { ...problemFields, retryable: Schema.Literal(true) },
    ).pipe(asProblemDetails, HttpApiSchema.status(503));
    type EndpointProblem =
      | Schema.Schema.Type<typeof ActionAuthenticationProblemSchema>
      | Schema.Schema.Type<typeof ActionVerificationUnavailableProblemSchema>;
    const actionApi = HttpApi.make('generatedActionIdentityFixture').add(
      HttpApiGroup.make('action').add(
        HttpApiEndpoint.post('invoke', '/actions/invoke', {
          error: [ActionAuthenticationProblemSchema, ActionVerificationUnavailableProblemSchema],
          success: TrustedPrincipalContextSchema,
        }),
      ),
    );
    const bearerChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.succeed(HttpServerResponse.setHeader(response, 'www-authenticate', 'Bearer')),
    );
    let actionReached = false;
    let endpointEnvironment: Readonly<Record<string, string>> = environment;
    const actionGroupLive = HttpApiBuilder.group(actionApi, 'action', (handlers) =>
      handlers.handle('invoke', ({ request }) =>
        generated
          .verifyActionPrincipal(request.headers['authorization'], {
            currentTimeSeconds: Effect.succeed(1_700_000_001),
            environment: endpointEnvironment,
          })
          .pipe(
            Effect.tap(() => Effect.sync(() => (actionReached = true))),
            Effect.catch((error) => {
              switch (error._tag) {
                case 'ActionPrincipalExpiredError':
                case 'ActionPrincipalInvalidError':
                case 'ActionPrincipalMissingError':
                case 'ActionPrincipalScopeError': {
                  return bearerChallenge.pipe(
                    Effect.andThen(
                      Effect.fail<EndpointProblem>({
                        _tag: 'ActionAuthenticationProblem' as const,
                        detail: 'A valid Bearer assertion is required.',
                        status: 401 as const,
                        title: 'Action authentication required',
                        type: 'https://ontos.dev/problems/action-authentication-required',
                      }),
                    ),
                  );
                }
                case 'ActionPrincipalConfigurationError':
                case 'ActionPrincipalUnavailableError': {
                  return Effect.fail<EndpointProblem>({
                    _tag: 'ActionVerificationUnavailableProblem' as const,
                    detail: 'Action identity verification is temporarily unavailable.',
                    retryable: true as const,
                    status: 503 as const,
                    title: 'Action verification unavailable',
                    type: 'https://ontos.dev/problems/action-verification-unavailable',
                  });
                }
                default: {
                  return Effect.die(new Error(`Unexpected generated error ${error._tag}`));
                }
              }
            }),
          ),
      ),
    );
    const actionRuntime = defineEffectBff({
      api: actionApi,
      layer: HttpApiBuilder.layer(actionApi).pipe(Layer.provide(actionGroupLive)),
    });
    const actionHandler = actionRuntime.createHandler();
    try {
      const missingResponse = await actionHandler.handler(
        new Request('https://inventory.example.test/actions/invoke', { method: 'POST' }),
      );
      assert.equal(missingResponse.status, 401);
      assert.equal(missingResponse.headers.get('www-authenticate'), 'Bearer');
      assert.match(
        missingResponse.headers.get('content-type') ?? '',
        /application\/problem\+json/u,
      );
      assert.equal(actionReached, false);

      endpointEnvironment = {};
      const unavailableResponse = await actionHandler.handler(
        new Request('https://inventory.example.test/actions/invoke', {
          headers: { authorization: `Bearer ${currentAssertion.token}` },
          method: 'POST',
        }),
      );
      assert.equal(unavailableResponse.status, 503);
      assert.equal(((await unavailableResponse.json()) as { retryable?: boolean }).retryable, true);
      assert.equal(actionReached, false);

      endpointEnvironment = environment;
      const successResponse = await actionHandler.handler(
        new Request('https://inventory.example.test/actions/invoke', {
          headers: { authorization: `Bearer ${currentAssertion.token}` },
          method: 'POST',
        }),
      );
      assert.equal(successResponse.status, 200);
      assert.deepEqual(await successResponse.json(), principal);
      assert.equal(actionReached, true);
    } finally {
      await actionHandler.dispose();
    }
  });
});

test('generates one self-contained typed fail-closed Action and preserves package metadata', async () => {
  await withFixture(async (fixture) => {
    await run(fixture, 'action', ['--vertical', 'inventory-stock', '--action', 'create-order2']);
    const action = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/actions/create-order2.action.ts',
    );
    assert.equal(
      action,
      `// @generated by OntOS Codesmith Action v1
// @ontos-action-owner inventory-stock
// @ontos-action-slug create-order2
import { Effect, Schema } from 'effect';
import { defineAction } from '@app/core-runtime';

export const CreateOrder2Payload = Schema.Struct({});
export type CreateOrder2Payload = Schema.Schema.Type<typeof CreateOrder2Payload>;

export const CreateOrder2Result = Schema.Struct({});
export type CreateOrder2Result = Schema.Schema.Type<typeof CreateOrder2Result>;

export class CreateOrder2NotImplemented extends Schema.TaggedErrorClass<CreateOrder2NotImplemented>()(
  'CreateOrder2NotImplemented',
  {
    code: Schema.Literal('action_not_implemented'),
    reason: Schema.String,
  },
) {}

const handleCreateOrder2 = () =>
  Effect.fail(
    new CreateOrder2NotImplemented({
      code: 'action_not_implemented',
      reason: 'The Create Order2 Action is not implemented',
    }),
  );

export const createOrder2Action = defineAction(
  {
    accessEvidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'inventory-stock.create-order2.access.v1',
    },
    actionKey: 'inventory-stock.create-order2',
    auditProfile: 'standard',
    domainErrorSchema: CreateOrder2NotImplemented,
    domainEvents: {},
    idempotency: 'required',
    owningModuleKey: 'inventory-stock',
    payloadSchema: CreateOrder2Payload,
    policies: [],
    resultSchema: CreateOrder2Result,
    schemaVersion: '1',
  },
  handleCreateOrder2,
);

// <generated-outbox-message-exports>
// </generated-outbox-message-exports>
`,
    );
    const packageJson = JSON.parse(
      await readFixtureFile(fixture.root, 'verticals/inventory-stock/package.json'),
    ) as {
      readonly dependencies: Readonly<Record<string, string>>;
      readonly scripts: Readonly<Record<string, string>>;
    };
    assert.deepEqual(packageJson.dependencies, {
      '@app/core-runtime': 'workspace:*',
      zeta: '1.0.0',
    });
    assert.equal(packageJson.scripts['existing'], 'preserve-me');
    const beforeRerun = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'action', ['--vertical', 'inventory-stock', '--action', 'create-order2']),
      /refusing to overwrite/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeRerun);
  });
});

test('preflights the Action dependency patch before creating a file', async () => {
  await withFixture(async (fixture) => {
    const packagePath = path.join(fixture.root, 'verticals/inventory-stock/package.json');
    const packageJson = JSON.parse(await readFile(packagePath, 'utf-8')) as Record<string, unknown>;
    packageJson['dependencies'] = { '@app/core-runtime': '^1.0.0', zeta: '1.0.0' };
    await writeFile(packagePath, json(packageJson), 'utf-8');
    const before = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'action', ['--vertical', 'inventory-stock', '--action', 'create-order']),
      /incompatible/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), before);
  });
});

test('rejects Action generation when a vertical app identity is duplicated', async () => {
  await withFixture(async (fixture) => {
    const billingPackagePath = path.join(fixture.root, 'verticals/billing/package.json');
    const billingPackage = JSON.parse(await readFile(billingPackagePath, 'utf-8')) as {
      modernjs: Record<string, unknown>;
    };
    billingPackage.modernjs['appId'] = inventoryVertical.appId;
    await writeFile(billingPackagePath, json(billingPackage), 'utf-8');
    const before = await snapshotTree(fixture.root);

    await assert.rejects(
      run(fixture, 'action', ['--vertical', 'inventory-stock', '--action', 'create-order']),
      /duplicate generated appId inventory-stock/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), before);
  });
});

test('rejects Action generation when the target identity is absent from topology', async () => {
  await withFixture(async (fixture) => {
    const packagePath = path.join(fixture.root, 'verticals/inventory-stock/package.json');
    const packageJson = JSON.parse(await readFile(packagePath, 'utf-8')) as {
      modernjs: Record<string, unknown>;
    };
    packageJson.modernjs['appId'] = 'inventory-shadow';
    await writeFile(packagePath, json(packageJson), 'utf-8');
    const before = await snapshotTree(fixture.root);

    await assert.rejects(
      run(fixture, 'action', ['--vertical', 'inventory-stock', '--action', 'create-order']),
      /must have exactly one matching generated topology entry/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), before);
  });
});

test('preserves owner JSON document style while patching the Core dependency', async () => {
  await withFixture(async (fixture) => {
    const packagePath = path.join(fixture.root, 'verticals/inventory-stock/package.json');
    const packageJson = JSON.parse(await readFile(packagePath, 'utf-8')) as Record<string, unknown>;
    const styledPackage = JSON.stringify(packageJson, null, 4)
      .replace(
        '    "scripts": {\n        "existing": "preserve-me"\n    }',
        '    "scripts": {"existing":"preserve-me"}',
      )
      .replaceAll('\n', '\r\n');
    await writeFile(packagePath, styledPackage, 'utf-8');

    await run(fixture, 'action', ['--vertical', 'inventory-stock', '--action', 'create-order']);

    const patched = await readFile(packagePath, 'utf-8');
    assert.match(patched, /\r\n {4}"dependencies": \{\r\n/u);
    assert.match(patched, /\r\n {4}"scripts": \{"existing":"preserve-me"\}/u);
    assert.doesNotMatch(patched, /(?<!\r)\n/u);
    assert.equal(patched.endsWith('\r\n'), false);
  });
});

test('generates Action-owned Outbox Messages and sorts only the owned export slot', async () => {
  await withFixture(async (fixture) => {
    await run(fixture, 'action', ['--vertical', 'inventory-stock', '--action', 'create-order']);
    const actionPath = path.join(
      fixture.root,
      'verticals/inventory-stock/src/actions/create-order.action.ts',
    );
    const generatedAction = await readFile(actionPath, 'utf-8');
    await writeFile(
      actionPath,
      `${generatedAction}\nexport const developerOwned = true;\n`,
      'utf-8',
    );
    await run(fixture, 'outbox-message', [
      '--vertical',
      'inventory-stock',
      '--action',
      'create-order',
      '--topic',
      'orders.shipped',
    ]);
    await run(fixture, 'outbox-message', [
      '--vertical',
      'inventory-stock',
      '--action',
      'create-order',
      '--topic',
      'orders.created',
    ]);
    const message = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/actions/create-order.orders-created.outbox-message.ts',
    );
    assert.equal(
      message,
      `import { Schema } from 'effect';
import type { OutboxMessage } from '@app/core-runtime';

export const CreateOrderOrdersCreatedOutboxPayload = Schema.Struct({
  data: Schema.Json,
});
export type CreateOrderOrdersCreatedOutboxPayload = Schema.Schema.Type<
  typeof CreateOrderOrdersCreatedOutboxPayload
>;

export const CreateOrderOrdersCreatedOutboxTopic = 'orders.created' as const;
export const CreateOrderOrdersCreatedOutboxProducerModuleKey = 'inventory-stock' as const;

export const createCreateOrderOrdersCreatedOutboxMessage = (
  payload: CreateOrderOrdersCreatedOutboxPayload,
): OutboxMessage => ({
  payloadJson: payload,
  producerModuleKey: CreateOrderOrdersCreatedOutboxProducerModuleKey,
  topic: CreateOrderOrdersCreatedOutboxTopic,
});
`,
    );
    const action = await readFile(actionPath, 'utf-8');
    const createdExport =
      "export { CreateOrderOrdersCreatedOutboxPayload } from './create-order.orders-created.outbox-message.ts';";
    const shippedExport =
      "export { CreateOrderOrdersShippedOutboxPayload } from './create-order.orders-shipped.outbox-message.ts';";
    assert.ok(action.indexOf(createdExport) < action.indexOf(shippedExport));
    assert.match(action, /export const developerOwned = true;/u);
    assert.doesNotMatch(
      message,
      /addDomainEvent|addOutboxMessage|subjectResource|transport|worker/u,
    );

    await run(fixture, 'outbox-message', [
      '--vertical',
      'inventory-stock',
      '--action',
      'create-order',
      '--topic',
      'events.foo-1-bar',
    ]);
    const beforeIdentifierCollision = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'outbox-message', [
        '--vertical',
        'inventory-stock',
        '--action',
        'create-order',
        '--topic',
        'events.foo1-bar',
      ]),
      /Outbox identifier CreateOrderEventsFoo1BarOutbox already exists/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeIdentifierCollision);
  });
});

test('rejects missing, handwritten, duplicate, and normalized-collision Outbox targets without partial writes', async () => {
  await withFixture(async (fixture) => {
    const beforeMissing = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'outbox-message', [
        '--vertical',
        'inventory-stock',
        '--action',
        'missing-action',
        '--topic',
        'orders.created',
      ]),
      /requires the generated Action/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeMissing);

    await writeFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/actions/handwritten.action.ts',
      `// <generated-outbox-message-exports>\n// </generated-outbox-message-exports>\n`,
    );
    const beforeHandwritten = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'outbox-message', [
        '--vertical',
        'inventory-stock',
        '--action',
        'handwritten',
        '--topic',
        'orders.created',
      ]),
      /only the matching generated Action/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeHandwritten);

    await run(fixture, 'action', ['--vertical', 'inventory-stock', '--action', 'create-order']);
    await run(fixture, 'outbox-message', [
      '--vertical',
      'inventory-stock',
      '--action',
      'create-order',
      '--topic',
      'orders.created-v2',
    ]);
    const beforeCollision = await snapshotTree(fixture.root);
    await Promise.all(
      ['orders.created-v2', 'orders-created.v2'].map(async (topic) => {
        await assert.rejects(
          run(fixture, 'outbox-message', [
            '--vertical',
            'inventory-stock',
            '--action',
            'create-order',
            '--topic',
            topic,
          ]),
          /already exists/u,
        );
        assert.deepEqual(await snapshotTree(fixture.root), beforeCollision);
      }),
    );
  });
});

test('generates fail-closed global and owner-local Policies with narrow exports', async () => {
  await withFixture(async (fixture) => {
    await run(fixture, 'policy', ['--scope', 'global', '--policy', 'tenant-active']);
    await run(fixture, 'policy', ['--scope', 'global', '--policy', 'account-open']);
    await run(fixture, 'policy', [
      '--scope',
      'microvertical',
      '--policy',
      'stock-available',
      '--vertical',
      'inventory-stock',
    ]);

    assert.equal(
      await readFixtureFile(
        fixture.root,
        'packages/core-runtime/src/policies/tenant-active.policy.ts',
      ),
      `import { Effect } from 'effect';
import { defineGlobalPolicy, denyPolicy } from '../actions/policy.ts';

export const tenantActivePolicy = defineGlobalPolicy<unknown>({
  evaluate: () =>
    Effect.fail(
      denyPolicy('policy_not_implemented', 'The Tenant Active Policy is not implemented'),
    ),
  policyKey: 'global.tenant-active.v1',
});
`,
    );
    assert.equal(
      await readFixtureFile(
        fixture.root,
        'verticals/inventory-stock/src/policies/stock-available.policy.ts',
      ),
      `import { Effect } from 'effect';
import { defineMicroverticalPolicy, denyPolicy } from '@app/core-runtime';

export const stockAvailablePolicy = defineMicroverticalPolicy<unknown, 'inventory-stock'>({
  evaluate: () =>
    Effect.fail(
      denyPolicy('policy_not_implemented', 'The Stock Available Policy is not implemented'),
    ),
  owningModuleKey: 'inventory-stock',
  policyKey: 'inventory-stock.stock-available.v1',
});
`,
    );
    const coreIndex = await readFixtureFile(fixture.root, 'packages/core-runtime/src/index.ts');
    assert.equal(
      coreIndex,
      `export const existingCoreSurface = true;

// <generated-global-policy-exports>
export { accountOpenPolicy } from './policies/account-open.policy.ts';
export { tenantActivePolicy } from './policies/tenant-active.policy.ts';
// </generated-global-policy-exports>
`,
    );
    assert.doesNotMatch(coreIndex, /stockAvailablePolicy/u);
    assert.equal(
      (
        JSON.parse(
          await readFixtureFile(fixture.root, 'verticals/inventory-stock/package.json'),
        ) as { readonly dependencies: Readonly<Record<string, string>> }
      ).dependencies['@app/core-runtime'],
      'workspace:*',
    );
    const beforeDuplicate = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'policy', ['--scope', 'global', '--policy', 'tenant-active']),
      /refusing to overwrite/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeDuplicate);

    await run(fixture, 'policy', ['--scope', 'global', '--policy', 'foo-1-bar']);
    const beforeIdentifierCollision = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'policy', ['--scope', 'global', '--policy', 'foo1-bar']),
      /Policy identifier foo1BarPolicy already exists/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeIdentifierCollision);
  });
});

test('generates an accessible translated private page, patches every locale, and refreshes its route owner', async () => {
  await withFixture(async (fixture) => {
    const shellBefore = await readFixtureFile(fixture.root, 'apps/shell-super-app/src/sentinel.ts');
    const englishLocalePath = path.join(
      fixture.root,
      'verticals/inventory-stock/locales/en/inventory.json',
    );
    await writeFile(
      englishLocalePath,
      '{\r\n    "inventory": {"existing":"en-preserved"}\r\n}',
      'utf-8',
    );
    const refreshes: string[] = [];
    await run(
      fixture,
      'microvertical-page',
      ['--vertical', 'inventory-stock', '--page', 'purchase-orders'],
      (appId) => refreshes.push(appId),
    );
    assert.deepEqual(refreshes, ['inventory-stock']);
    const page = await readFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/routes/[lang]/purchase-orders/page.tsx',
    );
    assert.equal(
      page,
      `import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { UltramodernRouteHead } from '../../ultramodern-route-head';

export default function PurchaseOrdersPage() {
  const { t } = useModernI18n();
  const headingId = 'purchase-orders-heading';

  return (
    <>
      <UltramodernRouteHead />
      <main className="inventory:min-h-screen inventory:bg-(--color-page-bg) inventory:px-4 inventory:py-8 inventory:text-(--color-page-fg) inventory:sm:px-8 inventory:lg:px-12">
        <div className="inventory:mx-auto inventory:flex inventory:max-w-5xl inventory:flex-col inventory:gap-8">
          <header className="inventory:space-y-3">
            <h1
              className="inventory:text-3xl inventory:font-bold inventory:sm:text-4xl"
              id={headingId}
            >
              {t('inventory.pages.purchaseOrders.title')}
            </h1>
            <p className="inventory:max-w-2xl inventory:text-base inventory:sm:text-lg">
              {t('inventory.pages.purchaseOrders.description')}
            </p>
          </header>
          <section
            aria-labelledby={headingId}
            className="inventory:bg-(--color-surface) inventory:p-6 inventory:sm:p-8"
          >
            <p>{t('inventory.pages.purchaseOrders.empty')}</p>
          </section>
        </div>
      </main>
    </>
  );
}
`,
    );
    assert.equal(
      await readFixtureFile(
        fixture.root,
        'verticals/inventory-stock/src/routes/[lang]/purchase-orders/route.meta.ts',
      ),
      `const routeMeta = {
  canonicalPath: '/purchase-orders',
  descriptionKey: 'inventory.pages.purchaseOrders.description',
  id: 'inventory-stock-purchase-orders',
  indexable: false,
  localisedPaths: {
    cs: '/purchase-orders',
    en: '/purchase-orders',
  },
  mfBoundaryId: 'verticalInventoryStock',
  namespace: 'inventory',
  ownerAppId: 'inventory-stock',
  public: false,
  publicSurface: 'private-app-screen',
  titleKey: 'inventory.pages.purchaseOrders.title',
} as const;

export default routeMeta;
export { routeMeta };
`,
    );
    const englishContent = await readFile(englishLocalePath, 'utf-8');
    const english = JSON.parse(englishContent) as {
      readonly inventory: {
        readonly existing: string;
        readonly pages: Readonly<Record<string, unknown>>;
      };
    };
    const czech = JSON.parse(
      await readFixtureFile(fixture.root, 'verticals/inventory-stock/locales/cs/inventory.json'),
    ) as typeof english;
    assert.equal(english.inventory.existing, 'en-preserved');
    assert.match(englishContent, /"inventory": \{"existing":"en-preserved", "pages":/u);
    assert.doesNotMatch(englishContent, /(?<!\r)\n/u);
    assert.equal(englishContent.endsWith('\r\n'), false);
    assert.deepEqual(english.inventory.pages['purchaseOrders'], {
      description: 'This page is ready for implementation.',
      empty: 'No content has been added yet.',
      title: 'New Page',
    });
    assert.deepEqual(czech.inventory.pages['purchaseOrders'], {
      description: 'Tato stránka je připravena k implementaci.',
      empty: 'Zatím zde není žádný obsah.',
      title: 'Nová stránka',
    });
    assert.equal(
      await readFixtureFile(fixture.root, 'apps/shell-super-app/src/sentinel.ts'),
      shellBefore,
    );
    assert.doesNotMatch(page, /fetch\(|useState|useEffect|<style|\.css'/u);
  });
});

test('rejects page generation when an owning locale has no truthful starter translation', async () => {
  await withFixture(async (fixture) => {
    const packagePath = path.join(fixture.root, 'verticals/inventory-stock/package.json');
    const packageJson = JSON.parse(await readFile(packagePath, 'utf-8')) as {
      exports: Record<string, string>;
    };
    packageJson.exports['./locales/de'] = './locales/de/inventory.json';
    await writeFile(packagePath, json(packageJson), 'utf-8');
    await writeFixtureFile(
      fixture.root,
      'verticals/inventory-stock/locales/de/inventory.json',
      json({ inventory: { existing: 'de-preserved' } }),
    );
    const before = await snapshotTree(fixture.root);

    await assert.rejects(
      run(fixture, 'microvertical-page', [
        '--vertical',
        'inventory-stock',
        '--page',
        'purchase-orders',
      ]),
      /no starter translation for locale de/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), before);
  });
});

test('page prerequisite and nested-route failures are preflighted, while refresh failure is safely rerunnable', async () => {
  await withFixture(async (fixture) => {
    await rm(
      path.join(fixture.root, 'verticals/inventory-stock/src/routes/ultramodern-route-head.tsx'),
    );
    const beforeMissingHead = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'microvertical-page', ['--vertical', 'inventory-stock', '--page', 'orders']),
      /UltramodernRouteHead is missing/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeMissingHead);
  });

  await withFixture(async (fixture) => {
    await writeFixtureFile(
      fixture.root,
      'verticals/inventory-stock/src/routes/[lang]/orders/nested.ts',
      'export {};\n',
    );
    const beforeCollision = await snapshotTree(fixture.root);
    await assert.rejects(
      run(fixture, 'microvertical-page', ['--vertical', 'inventory-stock', '--page', 'orders']),
      /collides with nested content/u,
    );
    assert.deepEqual(await snapshotTree(fixture.root), beforeCollision);
  });

  await withFixture(async (fixture) => {
    await assert.rejects(
      runScaffold('microvertical-page', ['--vertical', 'inventory-stock', '--page', 'orders'], {
        routeRefresh: () => {
          throw new Error('route refresh fixture failure');
        },
        workspaceRoot: fixture.root,
      }),
      /route refresh fixture failure/u,
    );
    await stat(
      path.join(fixture.root, 'verticals/inventory-stock/src/routes/[lang]/orders/page.tsx'),
    );
    const afterRefreshFailure = await snapshotTree(fixture.root);
    const refreshes: string[] = [];
    await run(
      fixture,
      'microvertical-page',
      ['--vertical', 'inventory-stock', '--page', 'orders'],
      (appId) => refreshes.push(appId),
    );
    assert.deepEqual(refreshes, ['inventory-stock']);
    assert.deepEqual(await snapshotTree(fixture.root), afterRefreshFailure);
  });
});

const runCombinedScenario = async (fixture: Fixture): Promise<Readonly<Record<string, string>>> => {
  await run(fixture, 'microvertical-action-boundary', ['--vertical', 'inventory-stock']);
  await run(fixture, 'action', ['--vertical', 'inventory-stock', '--action', 'create-order']);
  await run(fixture, 'outbox-message', [
    '--vertical',
    'inventory-stock',
    '--action',
    'create-order',
    '--topic',
    'orders.created',
  ]);
  await run(fixture, 'policy', ['--scope', 'global', '--policy', 'tenant-active']);
  await run(fixture, 'policy', [
    '--scope',
    'microvertical',
    '--policy',
    'stock-available',
    '--vertical',
    'inventory-stock',
  ]);
  await run(
    fixture,
    'microvertical-page',
    ['--vertical', 'inventory-stock', '--page', 'orders'],
    (appId) => assert.equal(appId, 'inventory-stock'),
  );
  return snapshotTree(fixture.root);
};

test('all generators compose deterministically without crossing owner boundaries', async () => {
  const first = await createFixture();
  const second = await createFixture();
  try {
    const billingBefore = Object.fromEntries(
      Object.entries(await snapshotTree(first.root)).filter(([file]) =>
        file.startsWith('verticals/billing/'),
      ),
    );
    const shellBefore = await readFixtureFile(first.root, 'apps/shell-super-app/src/sentinel.ts');
    const topologyBefore = await readFixtureFile(first.root, 'topology/reference-topology.json');
    const firstTree = await runCombinedScenario(first);
    const secondTree = await runCombinedScenario(second);
    assert.deepEqual(firstTree, secondTree);
    const billingAfter = Object.fromEntries(
      Object.entries(firstTree).filter(([file]) => file.startsWith('verticals/billing/')),
    );
    assert.deepEqual(billingAfter, billingBefore);
    assert.equal(
      await readFixtureFile(first.root, 'apps/shell-super-app/src/sentinel.ts'),
      shellBefore,
    );
    assert.equal(
      await readFixtureFile(first.root, 'topology/reference-topology.json'),
      topologyBefore,
    );
    const combinedSource = Object.values(firstTree).join('\n');
    assert.doesNotMatch(combinedSource, /from ['"]\.\.\/\.\.\/billing|fetch\(/u);
  } finally {
    await rm(first.root, { force: true, recursive: true });
    await rm(second.root, { force: true, recursive: true });
  }
});

test('every generated TypeScript file is already formatter-stable', async () => {
  await withFixture(async (fixture) => {
    await runCombinedScenario(fixture);
    const generatedFiles = [
      'packages/core-runtime/src/policies/tenant-active.policy.ts',
      'verticals/inventory-stock/src/actions/create-order.action.ts',
      'verticals/inventory-stock/src/actions/create-order.orders-created.outbox-message.ts',
      'verticals/inventory-stock/src/policies/stock-available.policy.ts',
      'verticals/inventory-stock/src/routes/[lang]/orders/page.tsx',
      'verticals/inventory-stock/src/routes/[lang]/orders/route.meta.ts',
      'verticals/inventory-stock/api/auth/action-principal.ts',
      'verticals/inventory-stock/src/api/action-gateway.ts',
    ];

    await Promise.all(
      generatedFiles.map(async (relativePath) => {
        const source = await readFixtureFile(fixture.root, relativePath);
        const formatted = spawnSync(oxfmtPath, [`--stdin-filepath=${relativePath}`], {
          cwd: appRoot,
          encoding: 'utf-8',
          input: source,
        });
        assert.equal(formatted.status, 0, formatted.stderr);
        assert.equal(formatted.stdout, source, `${relativePath} must be formatter-stable`);
      }),
    );
  });
});

test('all generated files typecheck against the real workspace contracts', async () => {
  await withFixture(async (fixture) => {
    await runCombinedScenario(fixture);
    await mkdir(path.join(fixture.root, 'node_modules', '@modern-js'), { recursive: true });
    await mkdir(path.join(fixture.root, 'node_modules', '@types'), { recursive: true });
    await symlink(
      path.join(appRoot, 'packages/core-runtime/node_modules/effect'),
      path.join(fixture.root, 'node_modules/effect'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'apps/shell-super-app/node_modules/jose'),
      path.join(fixture.root, 'node_modules/jose'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'packages/core-runtime/node_modules/drizzle-orm'),
      path.join(fixture.root, 'node_modules/drizzle-orm'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'apps/shell-super-app/node_modules/@modern-js/plugin-i18n'),
      path.join(fixture.root, 'node_modules/@modern-js/plugin-i18n'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'apps/shell-super-app/node_modules/@types/react'),
      path.join(fixture.root, 'node_modules/@types/react'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'packages/core-runtime/src/actions'),
      path.join(fixture.root, 'packages/core-runtime/src/actions'),
      'dir',
    );
    await symlink(
      path.join(appRoot, 'packages/core-runtime/src/db'),
      path.join(fixture.root, 'packages/core-runtime/src/db'),
      'dir',
    );
    const fixtureTsconfig = path.join(fixture.root, 'tsconfig.generated.json');
    await writeFile(
      fixtureTsconfig,
      json({
        compilerOptions: {
          allowImportingTsExtensions: true,
          jsx: 'preserve',
          module: 'preserve',
          moduleResolution: 'Bundler',
          noEmit: true,
          paths: {
            '@app/core-runtime': [path.join(appRoot, 'packages/core-runtime/src/index.ts')],
            '@app/core-runtime/actions/principal-context': [
              path.join(appRoot, 'packages/core-runtime/src/actions/principal-context.ts'),
            ],
            '@app/shared-contracts': [path.join(appRoot, 'packages/shared-contracts/src/index.ts')],
          },
          skipLibCheck: true,
          strict: true,
          target: 'ESNext',
          types: ['react'],
        },
        include: [
          'packages/core-runtime/src/policies/**/*.ts',
          'verticals/inventory-stock/src/actions/**/*.ts',
          'verticals/inventory-stock/src/policies/**/*.ts',
          'verticals/inventory-stock/src/routes/**/*.ts',
          'verticals/inventory-stock/src/routes/**/*.tsx',
          'verticals/inventory-stock/api/**/*.ts',
          'verticals/inventory-stock/src/api/**/*.ts',
        ],
      }),
      'utf-8',
    );

    const result = spawnSync(tscPath, ['-p', fixtureTsconfig], {
      cwd: fixture.root,
      encoding: 'utf-8',
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });
});
