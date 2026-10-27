#!/usr/bin/env node
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, Context, Effect, FileSystem, Layer, Redacted, Result, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { OntosDeploymentAppIdSchema } from '../packages/core-runtime/src/modules/manifest.ts';
import { ApplicationReleaseIntentSchema } from './application-release-intent.mts';
import type { ApplicationReleaseIntent } from './application-release-intent.mts';
import { gatewayPublicJwksFor, spicedbGatewayHostname, workerSecretPlan } from './ops/cloudflare-stage-cutover.mts';
import type { StageOrigins, WorkerSecretSources } from './ops/cloudflare-stage-cutover.mts';
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
      'configuration-invalid',
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
  readonly intent: ApplicationReleaseIntent;
  readonly shellUrl: string;
  readonly stageZone: string;
  readonly units: readonly EdgeUnit[];
}

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

const stageOrigins = (shellUrl: string, stageZone: string) =>
  Effect.gen(function* validateStageOrigins() {
    const url = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(shellUrl).pipe(
      Effect.mapError(() => failure(ORIGIN_INVALID)),
    );
    const hostname = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u;
    if (
      url.protocol !== 'https:' ||
      url.origin !== shellUrl ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      !hostname.test(stageZone) ||
      !hostname.test(url.hostname) ||
      !(url.hostname === stageZone || url.hostname.endsWith(`.${stageZone}`))
    ) {
      return yield* failure(ORIGIN_INVALID);
    }
    return { shellHostname: url.hostname, stageZone } satisfies StageOrigins;
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

const sourcesFromShell = (shell: typeof NativeSecretSchema.Type, origins: StageOrigins, shellUrl: string) =>
  Effect.gen(function* canonicalSharedSources() {
    for (const [binding, expected] of [
      ['ONTOS_GATEWAY_ISSUER', shellUrl],
      ['SPICEDB_ENDPOINT', spicedbGatewayHostname(origins)],
      ['ULTRAMODERN_DEPLOYMENT_ENVIRONMENT', 'stage'],
    ]) {
      if (shell[binding] !== expected) {
        return yield* bindingFailure(SHELL, binding);
      }
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
      for (const binding of Object.keys(required)) {
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
    const origins = yield* stageOrigins(input.shellUrl, input.stageZone);
    const units = yield* servedUnits(input);
    const shell = bundle[SHELL];
    if (!Object.hasOwn(bundle, SHELL) || shell === undefined) {
      return yield* bindingFailure(SHELL);
    }
    const sources = yield* sourcesFromShell(shell, origins, input.shellUrl);
    const plan = workerSecretPlan(units, origins, sources);
    yield* validateExistingOwners(bundle, units, plan);
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
    if (Object.hasOwn(bundle, PROJECTS)) {
      const existing = bundle[PROJECTS];
      if (
        existing === undefined ||
        Object.keys(existing).length !== PROJECTS_RELEASE_SECRET_KEYS.length ||
        Object.entries(projects).some(([key, value]) => existing[key] !== value)
      ) {
        return yield* failure('projects-conflict');
      }
      return { bundle: input.bundle, repairedProjects: false };
    }
    // Insert only the new property into the original JSON. Existing owner objects, escapes,
    // whitespace and string values remain byte-for-byte unchanged.
    const close = text.lastIndexOf('}');
    const addition = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Struct({ projects: ProjectsSecretSchema })),
    )({
      projects,
    }).pipe(Effect.mapError(() => failure(PROJECTS_CONTRACT_CHANGED)));
    return {
      bundle: Redacted.make(`${text.slice(0, close)},${addition.slice(1, -1)}${text.slice(close)}`),
      repairedProjects: true,
    };
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
      shellUrl: Config.String('STAGE_SHELL_URL'),
      stageZone: Config.String('STAGE_ZONE'),
    }).pipe(Effect.mapError(() => failure('configuration-invalid')));
    const fs = yield* FileSystem.FileSystem;
    const intent = yield* fs.readFileString('topology/application-release-intent.json').pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ApplicationReleaseIntentSchema))),
      Effect.catchCause(() => Effect.fail(failure(INVENTORY_INVALID))),
    );
    const units = yield* readEdgeUnits.pipe(Effect.catchCause(() => Effect.fail(failure(INVENTORY_INVALID))));
    const prepared = yield* prepareStageReleaseSecrets({ ...config, intent, units });
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
