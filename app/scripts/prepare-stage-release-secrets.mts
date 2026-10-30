#!/usr/bin/env node
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, Context, Effect, FileSystem, Layer, Redacted, Result, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { OntosDeploymentAppIdSchema } from '../packages/core-runtime/src/modules/manifest.ts';
import { ApplicationReleaseIntentSchema } from './application-release-intent.mts';
import type { ApplicationReleaseIntent } from './application-release-intent.mts';
import { gatewayPublicJwksFor, workerReleaseSecretNames, workerSecretPlan } from './ops/cloudflare-stage-cutover.mts';
import type { StageOrigins, WorkerSecretSources } from './ops/cloudflare-stage-cutover.mts';
import { readStageEdgeConfig, stageEdgeUrls } from './ci/stage-edge.mts';
import type { StageEdgeConfig } from './ci/stage-edge.mts';
import { readEdgeUnits } from './ops/stage-edge-units.mts';
import type { EdgeUnit } from './ops/stage-edge-units.mts';

const PROJECTS = 'projects';
const SHELL = 'shell-super-app';
const BUNDLE_INVALID = 'bundle-invalid';
const BINDING_INVALID = 'binding-invalid';
const OUTPUT_INVALID = 'output-invalid';
const OUTPUT_WRITE_FAILED = 'output-write-failed';
const INVENTORY_INVALID = 'inventory-invalid';
const ORIGIN_INVALID = 'origin-invalid';
const PROJECTS_CONTRACT_CHANGED = 'projects-contract-changed';
const CONFIGURATION_INVALID = 'configuration-invalid';
const NativeSecretSchema = Schema.Record(Schema.String, Schema.String);
const BundleSchema = Schema.Record(Schema.String, NativeSecretSchema);
type SecretBundle = typeof BundleSchema.Type;
const ProjectsSecretSchema = Schema.Struct({
  ONTOS_GATEWAY_ISSUER: Schema.String,
  ONTOS_GATEWAY_PUBLIC_JWKS: Schema.String,
  SPICEDB_ENDPOINT: Schema.String,
  SPICEDB_PRESHARED_KEY: Schema.String,
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: Schema.Literal('stage'),
});
export const PROJECTS_RELEASE_SECRET_KEYS = Object.freeze(Object.keys(ProjectsSecretSchema.fields));
const PrivateKeySchema = Schema.Struct({
  alg: Schema.Literal('EdDSA'),
  crv: Schema.Literal('Ed25519'),
  d: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
  kid: Schema.NonEmptyString,
  kty: Schema.Literal('OKP'),
  use: Schema.Literal('sig'),
  x: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
});

export class StageReleaseSecretPreparationError extends Schema.TaggedError<StageReleaseSecretPreparationError>()(
  'StageReleaseSecretPreparationError',
  {
    appId: Schema.optionalKey(OntosDeploymentAppIdSchema),
    binding: Schema.optionalKey(Schema.String),
    reason: Schema.Literals([
      BUNDLE_INVALID,
      BINDING_INVALID,
      INVENTORY_INVALID,
      ORIGIN_INVALID,
      PROJECTS_CONTRACT_CHANGED,
      'projects-conflict',
      OUTPUT_INVALID,
      OUTPUT_WRITE_FAILED,
      CONFIGURATION_INVALID,
    ]),
  },
) {
  override get message(): string {
    return [
      `reason=${this.reason}`,
      ...(this.appId === undefined ? [] : [`appId=${this.appId}`]),
      ...(this.binding === undefined ? [] : [`binding=${this.binding}`]),
    ].join(' ');
  }
}

type FailureReason = StageReleaseSecretPreparationError['reason'];
const failure = (reason: FailureReason) => new StageReleaseSecretPreparationError({ reason });
const bindingFailure = (appId: EdgeUnit['id'], binding?: string) => {
  const parsed = Schema.decodeUnknownResult(OntosDeploymentAppIdSchema)(appId);
  if (Result.isFailure(parsed)) {
    return failure(INVENTORY_INVALID);
  }
  return binding === undefined
    ? new StageReleaseSecretPreparationError({ appId: parsed.success, reason: BINDING_INVALID })
    : new StageReleaseSecretPreparationError({ appId: parsed.success, binding, reason: BINDING_INVALID });
};

export interface StageReleaseSecretInput {
  readonly bundle: Redacted.Redacted;
  /** topology/stage-edge.json: every host-bearing binding derives from it. */
  readonly edge: StageEdgeConfig;
  readonly intent: ApplicationReleaseIntent;
  readonly units: readonly EdgeUnit[];
}

/**
 * The host-bearing bindings, derived from topology/stage-edge.json. They replace whatever the stored bundle holds, so
 * the stored secret keeps only real secrets and a domain move needs no secret edit. Every unit's digest covers this
 * preparer and the topology, so a change here re-uploads the Workers that bind them.
 */
export const DERIVED_HOST_BINDINGS = Object.freeze([
  'AKROS_STOREFRONT_PUBLIC_URL',
  'BETTER_AUTH_TRUSTED_ORIGINS',
  'BETTER_AUTH_URL',
  'COMMERCE_CORE_IDENTITY_BASE_URL',
  'COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS',
  'COMMERCE_PORTAL_AUTH_URL',
  'ONTOS_EMAIL_FROM',
  'ONTOS_GATEWAY_ISSUER',
  'ONTOS_OAUTH_ISSUER',
  'ONTOS_PUBLIC_URL',
  'ONTOS_SHELL_GATEWAY_BASE_URL',
  'SPICEDB_ENDPOINT',
] as const);
export type HostBinding = (typeof DERIVED_HOST_BINDINGS)[number];
const isHostBinding = Schema.is(Schema.Literals(DERIVED_HOST_BINDINGS));

export const derivedHostBindings = (edge: StageEdgeConfig) => {
  const urls = stageEdgeUrls(edge);
  return {
    AKROS_STOREFRONT_PUBLIC_URL: urls.storefrontUrl,
    BETTER_AUTH_TRUSTED_ORIGINS: urls.shellUrl,
    BETTER_AUTH_URL: urls.shellUrl,
    COMMERCE_CORE_IDENTITY_BASE_URL: urls.shellApiBaseUrl,
    COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS: `${urls.shellUrl},${urls.storefrontUrl}`,
    COMMERCE_PORTAL_AUTH_URL: urls.storefrontUrl,
    ONTOS_EMAIL_FROM: edge.emailSender,
    ONTOS_GATEWAY_ISSUER: urls.shellUrl,
    ONTOS_OAUTH_ISSUER: urls.oauthIssuer,
    ONTOS_PUBLIC_URL: urls.shellUrl,
    ONTOS_SHELL_GATEWAY_BASE_URL: urls.shellApiBaseUrl,
    SPICEDB_ENDPOINT: edge.spicedbHostname,
  } satisfies Record<HostBinding, string>;
};
/** Every served owner binds these. */
const FOUNDATION_HOST_BINDINGS: readonly HostBinding[] = ['ONTOS_GATEWAY_ISSUER', 'SPICEDB_ENDPOINT'];
/** Owner runtime settings outside the native secret plan that these owners always receive. */
const OWNER_HOST_BINDINGS: ReadonlyMap<string, readonly HostBinding[]> = new Map([
  [
    'commerce-customer-context',
    [
      'COMMERCE_CORE_IDENTITY_BASE_URL',
      'COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS',
      'COMMERCE_PORTAL_AUTH_URL',
      'ONTOS_EMAIL_FROM',
    ],
  ],
  [SHELL, ['AKROS_STOREFRONT_PUBLIC_URL', 'ONTOS_EMAIL_FROM', 'ONTOS_OAUTH_ISSUER', 'ONTOS_PUBLIC_URL']],
]);

interface JsonObjectFrame {
  awaitingKey: boolean;
  readonly keys: Set<string>;
}

// JSON decoding below establishes syntax first. Inspect only strings and structural tokens to
// reject duplicate keys, including escaped aliases, without reserializing any existing bytes.
const rejectDuplicateKeys = (text: string) =>
  Effect.gen(function* rejectDuplicateJsonKeys() {
    const frames: (JsonObjectFrame | undefined)[] = [];
    for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]:,]/gu)) {
      const [token] = match;
      const frame = frames.at(-1);
      if (token === '{') {
        frames.push({ awaitingKey: true, keys: new Set() });
      } else if (token === '[') {
        frames.push(undefined);
      } else if (token === '}' || token === ']') {
        frames.pop();
      } else if (frame !== undefined && token === ',') {
        frame.awaitingKey = true;
      } else if (frame !== undefined && token === ':') {
        frame.awaitingKey = false;
      } else if (frame?.awaitingKey === true && token.startsWith('"')) {
        const key = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.String))(token).pipe(
          Effect.mapError(() => failure(BUNDLE_INVALID)),
        );
        if (frame.keys.has(key)) {
          return yield* failure(BUNDLE_INVALID);
        }
        frame.keys.add(key);
        frame.awaitingKey = false;
      }
    }
    return yield* Effect.void;
  });

const opaqueValue = (value: string) =>
  value.trim() !== '' &&
  !/^(?:redacted|[<[]redacted[>\]]|\*+)$/iu.test(value.trim()) &&
  !value.includes('${') &&
  !value.includes('\0');

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u;
const inZone = (hostname: string, zone: string) =>
  HOSTNAME.test(hostname) && (hostname === zone || hostname.endsWith(`.${zone}`));

/** The native origins, including the SpiceDB server name Workers VPC verifies, are the config's. */
const stageOrigins = (edge: StageEdgeConfig) =>
  Effect.gen(function* validateStageOrigins() {
    if (
      !HOSTNAME.test(edge.zone) ||
      !inZone(edge.shellHostname, edge.zone) ||
      !inZone(edge.storefrontHostname, edge.zone) ||
      !inZone(edge.spicedbHostname, edge.zone)
    ) {
      return yield* failure(ORIGIN_INVALID);
    }
    return {
      shellHostname: edge.shellHostname,
      spicedbHostname: edge.spicedbHostname,
      stageZone: edge.zone,
    } satisfies StageOrigins;
  });

const SigningInput = Context.Service<Redacted.Redacted>('@app/scripts/stage-release-secrets/SigningInput');
const SigningProof = Context.Service<boolean>('@app/scripts/stage-release-secrets/SigningProof');
const SigningProofLive = Layer.effect(
  SigningProof,
  Effect.gen(function* validateShellSigningKey() {
    const privateJwk = yield* SigningInput;
    const key = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PrivateKeySchema))(
      Redacted.value(privateJwk),
    ).pipe(Effect.mapError(() => bindingFailure(SHELL, 'ONTOS_GATEWAY_PRIVATE_JWK')));
    yield* rejectDuplicateKeys(Redacted.value(privateJwk)).pipe(
      Effect.mapError(() => bindingFailure(SHELL, 'ONTOS_GATEWAY_PRIVATE_JWK')),
    );
    // Prove that the supplied public component verifies the private key's signature. The native
    // derivation deliberately projects fields, so schema validation alone would not prove the pair.
    const pairMatches = yield* Effect.try({
      catch: () => bindingFailure(SHELL, 'ONTOS_GATEWAY_PRIVATE_JWK'),
      try: () => {
        const challenge = new TextEncoder().encode('ontos-stage-release-public-key-proof');
        const privateKey = createPrivateKey({ format: 'jwk', key });
        const publicKey = createPublicKey({ format: 'jwk', key: { crv: key.crv, kty: key.kty, x: key.x } });
        return verify(null, challenge, publicKey, sign(null, challenge, privateKey));
      },
    });
    if (!pairMatches) {
      return yield* bindingFailure(SHELL, 'ONTOS_GATEWAY_PRIVATE_JWK');
    }
    return true;
  }),
);
const publicJwks = (privateJwk: Redacted.Redacted) =>
  Effect.scoped(
    Effect.gen(function* deriveVerifiedPublicJwks() {
      yield* Layer.build(SigningProofLive.pipe(Layer.provide(Layer.succeed(SigningInput, privateJwk))));
      return yield* gatewayPublicJwksFor(privateJwk).pipe(
        Effect.catchCause(() => Effect.fail(bindingFailure(SHELL, 'ONTOS_GATEWAY_PRIVATE_JWK'))),
      );
    }),
  );

const servedUnits = (input: StageReleaseSecretInput) =>
  Effect.gen(function* validateServedInventory() {
    const intent = yield* Schema.decodeUnknownEffect(ApplicationReleaseIntentSchema)(input.intent).pipe(
      Effect.mapError(() => failure(INVENTORY_INVALID)),
    );
    const ids = [SHELL, ...intent.modules.map(({ appId }) => appId)];
    const expected = new Set(ids);
    const units = input.units.filter(({ id }) => expected.has(id));
    if (
      expected.size !== ids.length ||
      !expected.has(PROJECTS) ||
      units.length !== ids.length ||
      new Set(units.map(({ id }) => id)).size !== ids.length ||
      new Set(units.map(({ workerName }) => workerName)).size !== ids.length ||
      units.find(({ id }) => id === PROJECTS)?.kind !== 'vertical' ||
      units.find(({ id }) => id === SHELL)?.kind !== 'shell'
    ) {
      return yield* failure(INVENTORY_INVALID);
    }
    return units;
  });

const sourcesFromShell = (shell: typeof NativeSecretSchema.Type) =>
  Effect.gen(function* canonicalSharedSources() {
    if (shell.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT !== 'stage') {
      return yield* bindingFailure(SHELL, 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
    }
    if (!opaqueValue(shell.SPICEDB_PRESHARED_KEY ?? '')) {
      return yield* bindingFailure(SHELL, 'SPICEDB_PRESHARED_KEY');
    }
    const jwks = yield* publicJwks(Redacted.make(shell.ONTOS_GATEWAY_PRIVATE_JWK ?? ''));
    // These owner-specific inputs are used only to project the other units' required names.
    // They must never enter Projects. Its exact five-key native contract is checked below.
    const namesOnly = Redacted.make('owner-name-projection-only');
    return {
      betterAuthSecret: namesOnly,
      commerceCustomerContextGatewayApiKey: namesOnly,
      commerceMarketCatalogGatewayApiKey: namesOnly,
      crmPartyIntakeApiKey: namesOnly,
      gatewayPrivateJwk: namesOnly,
      gatewayPublicJwks: jwks,
      pricingGatewayApiKey: namesOnly,
      spicedbPresharedKey: Redacted.make(shell.SPICEDB_PRESHARED_KEY),
    } satisfies WorkerSecretSources;
  });

/**
 * The bundle with every host-bearing binding derived: an owner's stored one is always replaced, a served owner gets
 * the foundation and its owner bindings, and a gateway client the native plan requires gets its derived base URL.
 */
const deriveHostBindings = (
  bundle: SecretBundle,
  units: readonly EdgeUnit[],
  plan: ReturnType<typeof workerSecretPlan>,
  edge: StageEdgeConfig,
) => {
  const derived = derivedHostBindings(edge);
  const served = new Map(units.map((unit) => [unit.id, unit]));
  return Object.fromEntries(
    Object.entries(bundle).map(([id, stored]) => {
      const owner: Record<string, string> = Object.fromEntries(
        Object.entries(stored).map(([key, value]) => [key, isHostBinding(key) ? derived[key] : value]),
      );
      const unit = served.get(id);
      if (unit === undefined || id === PROJECTS) {
        return [id, owner];
      }
      for (const binding of [...FOUNDATION_HOST_BINDINGS, ...(OWNER_HOST_BINDINGS.get(id) ?? [])]) {
        owner[binding] = derived[binding];
      }
      const required = workerReleaseSecretNames(unit, plan.get(unit.workerName) ?? {}, owner);
      for (const binding of required.filter(isHostBinding)) {
        owner[binding] = derived[binding];
      }
      return [id, owner];
    }),
  ) satisfies SecretBundle;
};

const validateExistingOwners = (
  bundle: SecretBundle,
  units: readonly EdgeUnit[],
  plan: ReturnType<typeof workerSecretPlan>,
) =>
  Effect.gen(function* validateExistingOwnerInventory() {
    for (const unit of units) {
      if (unit.id === PROJECTS) {
        continue;
      }
      const owner = bundle[unit.id];
      if (!Object.hasOwn(bundle, unit.id) || owner === undefined) {
        return yield* bindingFailure(unit.id);
      }
      const required = plan.get(unit.workerName);
      if (required === undefined) {
        return yield* failure(INVENTORY_INVALID);
      }
      for (const binding of workerReleaseSecretNames(unit, required, owner)) {
        if (!Object.hasOwn(owner, binding) || !opaqueValue(owner[binding] ?? '')) {
          return yield* bindingFailure(unit.id, binding);
        }
      }
      if (Object.values(owner).some((value) => value.trim() === '')) {
        return yield* bindingFailure(unit.id);
      }
    }
    return yield* Effect.void;
  });

/** Pure preparation. No filesystem, configuration, network, mutation or credential rotation. */
export const prepareStageReleaseSecrets = Effect.fn('StageReleaseSecrets.prepare')(
  function* prepareStageReleaseSecretsEffect(input: StageReleaseSecretInput) {
    const text = Redacted.value(input.bundle);
    const bundle = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(BundleSchema))(text).pipe(
      Effect.mapError(() => failure(BUNDLE_INVALID)),
    );
    yield* rejectDuplicateKeys(text);
    const origins = yield* stageOrigins(input.edge);
    const units = yield* servedUnits(input);
    const storedShell = bundle[SHELL];
    if (!Object.hasOwn(bundle, SHELL) || storedShell === undefined) {
      return yield* bindingFailure(SHELL);
    }
    const sources = yield* sourcesFromShell(storedShell);
    const plan = workerSecretPlan(units, origins, sources);
    const prepared = deriveHostBindings(bundle, units, plan, input.edge);
    const shell = prepared[SHELL] ?? storedShell;
    yield* validateExistingOwners(prepared, units, plan);
    const projectsUnit = units.find(({ id }) => id === PROJECTS);
    const desired = projectsUnit === undefined ? undefined : plan.get(projectsUnit.workerName);
    if (
      desired === undefined ||
      Object.keys(desired).length !== PROJECTS_RELEASE_SECRET_KEYS.length ||
      PROJECTS_RELEASE_SECRET_KEYS.some((key) => !Object.hasOwn(desired, key))
    ) {
      return yield* failure(PROJECTS_CONTRACT_CHANGED);
    }
    const projects = yield* Schema.decodeUnknownEffect(ProjectsSecretSchema, { onExcessProperty: 'error' })(
      Object.fromEntries(Object.entries(desired).map(([key, value]) => [key, Redacted.value(value)])),
    ).pipe(Effect.mapError(() => failure(PROJECTS_CONTRACT_CHANGED)));
    const canonicalProjects = {
      ONTOS_GATEWAY_ISSUER: shell.ONTOS_GATEWAY_ISSUER,
      ONTOS_GATEWAY_PUBLIC_JWKS: Redacted.value(sources.gatewayPublicJwks),
      SPICEDB_ENDPOINT: shell.SPICEDB_ENDPOINT,
      SPICEDB_PRESHARED_KEY: Redacted.value(sources.spicedbPresharedKey),
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: shell.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT,
    };
    if (Object.entries(canonicalProjects).some(([key, value]) => Redacted.value(desired[key]) !== value)) {
      return yield* failure(PROJECTS_CONTRACT_CHANGED);
    }
    // A stored Projects entry must hold the derived secrets and nothing else. Its host bindings are derived like
    // every owner's, so it may omit them; the prepared entry always carries all five.
    const existing = bundle[PROJECTS];
    if (
      Object.hasOwn(bundle, PROJECTS) &&
      (existing === undefined ||
        Object.keys(existing).some((key) => !PROJECTS_RELEASE_SECRET_KEYS.includes(key)) ||
        Object.entries(projects).some(
          ([key, value]) => !isHostBinding(key) && (!Object.hasOwn(existing, key) || existing[key] !== value),
        ))
    ) {
      return yield* failure('projects-conflict');
    }
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(BundleSchema))({
      ...prepared,
      [PROJECTS]: projects,
    }).pipe(Effect.mapError(() => failure(PROJECTS_CONTRACT_CHANGED)));
    return { bundle: Redacted.make(encoded), repairedProjects: !Object.hasOwn(bundle, PROJECTS) };
  },
);

/** The workflow owns the unique parent directory and removes it in its failure trap / final step. */
export const writePreparedStageReleaseSecrets = Effect.fn('StageReleaseSecrets.write')(
  function* writePreparedStageReleaseSecretsEffect(
    outputFile: string,
    runnerTemp: string,
    prepared: Redacted.Redacted,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(runnerTemp).pipe(Effect.mapError(() => failure(OUTPUT_INVALID)));
    const parent = yield* fs.realPath(path.dirname(outputFile)).pipe(Effect.mapError(() => failure(OUTPUT_INVALID)));
    if (
      path.dirname(parent) !== root ||
      !path.basename(parent).startsWith('stage-release-secrets.') ||
      path.basename(outputFile) !== 'bundle.json'
    ) {
      return yield* failure(OUTPUT_INVALID);
    }
    let created = false;
    return yield* Effect.scoped(
      Effect.gen(function* writeExclusivePrivateBundle() {
        const file = yield* fs.open(outputFile, { flag: 'wx', mode: 0o600, noFollow: true });
        created = true;
        yield* file.writeAll(new TextEncoder().encode(Redacted.value(prepared)));
      }),
    ).pipe(
      Effect.mapError(() => failure(OUTPUT_WRITE_FAILED)),
      Effect.onError(() =>
        created
          ? fs
              .remove(outputFile)
              .pipe(
                Effect.catchCause(() =>
                  Console.error('Runner secret file cleanup failed; workflow cleanup is required'),
                ),
              )
          : Effect.void,
      ),
    );
  },
);

const prepareFile = (outputFile: string) =>
  Effect.gen(function* prepareRunnerSecretFile() {
    const config = yield* Config.all({
      bundle: Config.Redacted('ALL_RELEASE_SECRETS'),
      runnerTemp: Config.String('RUNNER_TEMP'),
    }).pipe(Effect.mapError(() => failure(CONFIGURATION_INVALID)));
    const edge = yield* Effect.try({ catch: () => failure(CONFIGURATION_INVALID), try: () => readStageEdgeConfig() });
    const fs = yield* FileSystem.FileSystem;
    const intent = yield* fs.readFileString('topology/application-release-intent.json').pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ApplicationReleaseIntentSchema))),
      Effect.catchCause(() => Effect.fail(failure(INVENTORY_INVALID))),
    );
    const units = yield* readEdgeUnits.pipe(Effect.catchCause(() => Effect.fail(failure(INVENTORY_INVALID))));
    const prepared = yield* prepareStageReleaseSecrets({ bundle: config.bundle, edge, intent, units });
    yield* writePreparedStageReleaseSecrets(outputFile, config.runnerTemp, prepared.bundle);
    yield* Console.log(
      prepared.repairedProjects
        ? 'Prepared missing projects native bindings'
        : 'Preserved existing projects native bindings',
    );
  });

if (import.meta.main) {
  const cli = Command.make(
    'prepare-stage-release-secrets',
    { outputFile: Flag.String('output-file') },
    ({ outputFile }) => prepareFile(outputFile),
  );
  NodeRuntime.runMain(
    Layer.build(
      Layer.effectDiscard(Command.run({ version: '1.0.0' })(cli)).pipe(Layer.provide(NodeServices.layer)),
    ).pipe(Effect.scoped),
  );
}
