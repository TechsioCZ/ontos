/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { Effect, FileSystem, Layer, Match, Option, Path, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';
import type { HttpClientRequest } from 'effect/unstable/http';
import { parse as parseYaml } from 'yaml';

import { OpsCommandError } from '../ops/ops-command-error.mts';
import { OpsShell, renderCommand } from '../ops/ops-shell.mts';
import type { OpsCommand, OpsShellService } from '../ops/ops-shell.mts';
import { SPICEDB_GRPC_TLS, SPICEDB_HTTP_TLS, pemBlocks } from '../ops/spicedb-tls.mts';
import type { ZeropsService } from '../ops/stage-operations.mts';
import { ZeropsApiError } from '../zerops-public-api-error.mts';
import { ZeropsPublicApi } from '../zerops-public-api.mts';
import type { ZeropsServiceStackIdentity } from '../zerops-public-api.mts';

/**
 * In-memory stand-ins for everything the stage operations touch: Zerops and GitHub behind the
 * `OpsShell` seam, the Cloudflare account behind the Effect `HttpClient` seam, the Zerops REST API
 * behind `ZeropsPublicApi`, and repository files behind `FileSystem`. Each records what the scripts
 * asked for, so tests assert exact mutations. `openssl` runs for real, so certificates are real.
 */
export const APP_DIRECTORY = new URL('../../', import.meta.url).pathname.replace(/\/$/u, '');

const JsonText = Schema.fromJsonString(Schema.Json);
type Json = typeof Schema.Json.Type;
const encodeJson = (value: Json) => Schema.encodeSync(JsonText)(value);

// ---------------------------------------------------------------------------------------------
// Repository files

export interface FakeFiles {
  readonly layer: Layer.Layer<FileSystem.FileSystem | Path.Path>;
  readonly writes: Map<string, string>;
}

/** Reads real repository files unless `overrides` (keyed by app-relative path) replaces them; writes stay in memory. */
export const fakeFiles = (overrides: Readonly<Record<string, string>> = {}): FakeFiles => {
  const writes = new Map<string, string>();
  const relative = (path: string) => path.slice(APP_DIRECTORY.length + 1);
  const read = (path: string) => writes.get(path) ?? overrides[relative(path)] ?? readFileSync(path, 'utf-8');
  const fileSystem = FileSystem.layerNoop({
    exists: (path) => Effect.sync(() => writes.has(path) || relative(path) in overrides || existsSync(path)),
    readFileString: (path) => Effect.sync(() => read(path)),
    // Real, removed on scope close: the scripts hand these directories to real processes such as openssl.
    makeTempDirectoryScoped: (options) =>
      Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(nodePath.join(tmpdir(), options?.prefix ?? 'fake-files-'))),
        (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
      ),
    writeFileString: (path, data) =>
      Effect.sync(() => {
        writes.set(path, data);
      }),
  });
  return { layer: Layer.merge(fileSystem, Path.layer), writes };
};

// ---------------------------------------------------------------------------------------------
// Zerops and GitHub through the shell

/** The revision the fake `git rev-parse HEAD` reports. */
export const FAKE_REVISION = '0123456789abcdef';

export interface FakeZeropsProject {
  readonly id: string;
  readonly name: string;
  readonly orgId: string;
}

export interface FakeStage {
  /** Deployment branch policies created, by environment. */
  readonly branchPolicies: { environment: string; name: string }[];
  readonly commands: OpsCommand[];
  readonly deployments: { id: number; sha: string; state: string }[];
  /** Repository paths `git status --porcelain` reports as changed. */
  readonly dirtyPaths: Set<string>;
  readonly environments: Set<string>;
  /** Hostnames a service import accepts but Zerops does not list (a partial or delayed creation). */
  readonly hiddenOnImport: Set<string>;
  /** Every stdin the scripts piped, by rendered command. */
  readonly inputs: { command: string; stdin: string }[];
  readonly layer: Layer.Layer<OpsShellService>;
  readonly projects: FakeZeropsProject[];
  readonly projectUserKeys: string[];
  /** Project-scope variable values, including `<hostname>_<KEY>` references. */
  readonly projectValues: Map<string, string>;
  /** Secret names per GitHub environment. */
  readonly secrets: Map<string, Set<string>>;
  /** Project-scope keys of sensitive service secrets, which `zcli project env` prints as `REDACTED`. */
  readonly sensitiveKeys: Set<string>;
  services: ZeropsService[];
  readonly serviceUserKeys: Map<string, string[]>;
  readonly variables: Map<string, Map<string, string>>;
}

export interface FakeStageInitial {
  readonly deployments?: readonly { id: number; sha: string; state: string }[];
  readonly environments?: readonly string[];
  readonly projects?: readonly FakeZeropsProject[];
  readonly projectUserKeys?: readonly string[];
  readonly projectValues?: Readonly<Record<string, string>>;
  readonly secrets?: Readonly<Record<string, readonly string[]>>;
  readonly sensitiveKeys?: readonly string[];
  readonly services?: readonly ZeropsService[];
  readonly serviceUserKeys?: Readonly<Record<string, readonly string[]>>;
  readonly variables?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const option = (args: readonly string[], name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const table = (services: readonly ZeropsService[]) =>
  [
    '┌────┬──────┬────────┐',
    '│ ID │ NAME │ STATUS │',
    '├────┼──────┼────────┤',
    ...services.map(({ hostname, id, status }) => `│ ${id} │ ${hostname} │ ${status} │`),
    '└────┴──────┴────────┘',
  ].join('\n');

const projectTable = (projects: readonly FakeZeropsProject[]) =>
  [
    '│ ID │ NAME │ ORG NAME │ ORG ID │ STATUS │ MODE │',
    ...projects.map(({ id, name, orgId }) => `│ ${id} │ ${name} │ Example Org │ ${orgId} │ ACTIVE │ SERIOUS │`),
  ].join('\n');

const unexpected = (command: OpsCommand) =>
  Effect.fail(new OpsCommandError({ command: renderCommand(command), message: 'unexpected command' }));

const ImportSchema = Schema.Struct({ services: Schema.Array(Schema.Struct({ hostname: Schema.String })) });
const VALUE_TEMPLATE = /^\{\{if eq \.Key "(?<key>[^"]+)"\}\}/u;

const zcliProjectAnswer = (stage: FakeStage, command: OpsCommand) => {
  const { args } = command;
  if (args[1] === 'env') {
    const valueKey = VALUE_TEMPLATE.exec(option(args, '--template') ?? '')?.groups?.key;
    if (valueKey !== undefined) {
      // zcli prints one (usually empty) line per variable.
      const value = stage.sensitiveKeys.has(valueKey) ? 'REDACTED' : (stage.projectValues.get(valueKey) ?? '');
      return Effect.succeed(`\n\n${value}\n\n`);
    }
    const service = option(args, '--service');
    const keys = service === undefined ? stage.projectUserKeys : (stage.serviceUserKeys.get(service) ?? []);
    return Effect.succeed(`${keys.join('\n')}\n`);
  }
  if (args[1] === 'list') {
    return Effect.succeed(projectTable(stage.projects));
  }
  if (args[1] !== 'create') {
    return unexpected(command);
  }
  const id = `project-${String(stage.projects.length + 1)}`;
  stage.projects.push({ id, name: option(args, '--name') ?? '', orgId: option(args, '--org-id') ?? '' });
  return Effect.succeed(`${id}\n`);
};

const zcliAnswer = (stage: FakeStage, command: OpsCommand, nextId: () => string) => {
  const { args } = command;
  const [group, action] = args;
  if (group === 'service' && action === 'list') {
    return Effect.succeed(table(stage.services));
  }
  if (group === 'project' && action !== 'service-import') {
    return zcliProjectAnswer(stage, command);
  }
  if (group === 'project' && action === 'service-import') {
    const stdin = command.stdin === undefined ? '' : Redacted.value(command.stdin);
    for (const { hostname } of Schema.decodeUnknownSync(ImportSchema)(parseYaml(stdin)).services) {
      if (stage.hiddenOnImport.has(hostname)) {
        continue;
      }
      stage.services.push({ hostname, id: nextId(), status: 'READY_TO_DEPLOY' });
    }
    return Effect.succeed('');
  }
  if (group === 'service' && action === 'delete') {
    const serviceId = option(args, '--service-id');
    stage.services = stage.services.filter(({ id }) => id !== serviceId);
    return Effect.succeed('');
  }
  if (group === 'push') {
    const serviceId = option(args, '--service-id');
    stage.services = stage.services.map((service) =>
      service.id === serviceId ? { ...service, status: 'ACTIVE' } : service,
    );
    return Effect.succeed('');
  }
  return unexpected(command);
};

const environmentVariables = (stage: FakeStage, environment: string) => {
  const existing = stage.variables.get(environment);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, string>();
  stage.variables.set(environment, created);
  return created;
};

const githubApiAnswer = (stage: FakeStage, command: OpsCommand) => {
  const path = command.args.find((argument) => argument.startsWith('repos/')) ?? '';
  if (command.args.includes('POST') && path.endsWith('/deployment-branch-policies')) {
    const name = command.args.find((argument) => argument.startsWith('name=')) ?? '';
    stage.branchPolicies.push({ environment: path.split('/').at(-2) ?? '', name: name.slice('name='.length) });
    return Effect.succeed('{}');
  }
  if (command.args.includes('PUT')) {
    stage.environments.add(path.split('/').at(-1) ?? '');
    return Effect.succeed('{}');
  }
  if (path.endsWith('/environments')) {
    return Effect.succeed(`${[...stage.environments].join('\n')}\n`);
  }
  if (path.includes('/deployments?')) {
    return Effect.succeed(encodeJson(stage.deployments.slice(0, 1).map(({ id, sha }) => ({ id, sha }))));
  }
  if (path.includes('/statuses?')) {
    return Effect.succeed(encodeJson(stage.deployments.slice(0, 1).map(({ state }) => ({ state }))));
  }
  return unexpected(command);
};

const ghAnswer = (stage: FakeStage, command: OpsCommand) => {
  const { args } = command;
  const [group, action, name] = args;
  const environment = option(args, '--env') ?? '';
  if (group === 'variable' && action === 'list') {
    return Effect.succeed(
      encodeJson([...environmentVariables(stage, environment)].map(([variable, value]) => ({ name: variable, value }))),
    );
  }
  if (group === 'variable' && action === 'set' && name !== undefined) {
    environmentVariables(stage, environment).set(name, option(args, '--body') ?? '');
    return Effect.succeed('');
  }
  if (group === 'secret' && action === 'list') {
    return Effect.succeed(encodeJson([...(stage.secrets.get(environment) ?? [])].map((secret) => ({ name: secret }))));
  }
  if (group === 'secret' && action === 'set' && name !== undefined) {
    stage.secrets.set(environment, new Set([...(stage.secrets.get(environment) ?? []), name]));
    return Effect.succeed('');
  }
  if ((group === 'secret' && action === 'set') || (group === 'workflow' && action === 'run')) {
    return Effect.succeed('');
  }
  return group === 'api' ? githubApiAnswer(stage, command) : unexpected(command);
};

const gitAnswer = (stage: FakeStage, { args }: OpsCommand) =>
  args[0] === 'status'
    ? Effect.succeed(
        args
          .filter((path) => stage.dirtyPaths.has(path))
          .map((path) => ` M ${path}\n`)
          .join(''),
      )
    : Effect.succeed(`${FAKE_REVISION}\n`);

// ---------------------------------------------------------------------------------------------
// Real OpenSSL, and a stand-in for the Cloudflare Origin CA

/** The system OpenSSL (LibreSSL on macOS) accepts every invocation the scripts make. */
const OPENSSL = '/usr/bin/openssl';

/** Runs the system `openssl`; key material stays in memory, never in arguments. */
export const openssl = (args: readonly string[], input?: string) =>
  execFileSync(OPENSSL, args, { encoding: 'utf-8', input, stdio: ['pipe', 'pipe', 'ignore'] });

const EC_KEY = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
const ORIGIN_VALIDITY_DAYS = 5475;
const CERTIFICATE = 'CERTIFICATE';
const PRIVATE_KEY = 'PRIVATE KEY';

const sanEntry = (name: string) => (/^[\d.]+$/u.test(name) ? `IP:${name}` : `DNS:${name}`);

let signed = 0;

/** Runs `work` with a fresh private directory and removes it afterwards, so no test key outlives its call. */
const withScratchDirectory = <A,>(work: (directory: string) => A): A => {
  const directory = mkdtempSync(nodePath.join(tmpdir(), 'fake-openssl-'));
  try {
    return work(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

/**
 * Runs `openssl` with its new key and its output in files, and returns both. Linux OpenSSL cannot
 * open `/dev/stdout` when it is a socket, as a Node child's standard output is.
 */
const opensslWithKey = (args: readonly string[]) =>
  withScratchDirectory((directory) => {
    const keyPath = nodePath.join(directory, 'key.pem');
    const outputPath = nodePath.join(directory, 'output.pem');
    openssl([...args, '-keyout', keyPath, '-out', outputPath]);
    return { key: readFileSync(keyPath, 'utf-8'), output: readFileSync(outputPath, 'utf-8') };
  });

let originCa: { readonly certificate: string; readonly key: string } | undefined;

/** A throwaway CA standing in for the Cloudflare Origin CA, kept in memory for the test process. */
const fakeOriginCa = () => {
  originCa ??= (() => {
    const { key, output } = opensslWithKey([
      'req',
      '-x509',
      ...EC_KEY,
      '-days',
      String(ORIGIN_VALIDITY_DAYS),
      '-subj',
      '/O=Fake Origin CA/CN=Fake Origin CA',
    ]);
    return { certificate: output, key };
  })();
  return originCa;
};

/** Signs `csr` for `hostnames` the way the Origin CA does: the hostnames become the certificate's SANs. */
export const signWithFakeOriginCa = (csr: string, hostnames: readonly string[], days = ORIGIN_VALIDITY_DAYS) => {
  const authority = fakeOriginCa();
  signed += 1;
  return withScratchDirectory((directory) => {
    const file = (name: string, content: string) => {
      const path = nodePath.join(directory, name);
      writeFileSync(path, content);
      return path;
    };
    return openssl([
      'x509',
      '-req',
      '-in',
      file('request.csr', csr),
      '-CA',
      file('ca.pem', authority.certificate),
      '-CAkey',
      file('ca.key', authority.key),
      '-set_serial',
      String(signed),
      '-days',
      String(days),
      '-extfile',
      file('san.cnf', `subjectAltName=${hostnames.map(sanEntry).join(',')}\n`),
    ]);
  });
};

const pemBlock = (text: string, label: string) => {
  const block = pemBlocks(text).get(label);
  if (block === undefined) {
    throw new Error(`openssl printed no ${label}`);
  }
  return block;
};

export interface SpicedbTlsSecretOptions {
  readonly gatewayDays?: number;
  readonly gatewayHostname: string;
  readonly grpcNames?: readonly string[];
}

/** Valid SpiceDB TLS secrets by their Zerops `spicedb_<KEY>` project names, as `spicedb-tls` stores them. */
export const spicedbTlsSecrets = (options: SpicedbTlsSecretOptions) => {
  const names = options.grpcNames ?? ['spicedb', 'localhost', '127.0.0.1'];
  const grpc = opensslWithKey([
    'req',
    '-x509',
    ...EC_KEY,
    '-days',
    '3650',
    '-subj',
    '/CN=spicedb',
    '-addext',
    `subjectAltName=${names.map(sanEntry).join(',')}`,
  ]);
  const request = opensslWithKey(['req', '-new', ...EC_KEY, '-subj', `/CN=${options.gatewayHostname}`]);
  const gatewayCertificate = signWithFakeOriginCa(
    pemBlock(request.output, `${CERTIFICATE} REQUEST`),
    [options.gatewayHostname],
    options.gatewayDays,
  );
  return {
    [`spicedb_${SPICEDB_GRPC_TLS.certificateKey}`]: pemBlock(grpc.output, CERTIFICATE),
    [`spicedb_${SPICEDB_GRPC_TLS.privateKeyKey}`]: pemBlock(grpc.key, PRIVATE_KEY),
    [`spicedb_${SPICEDB_HTTP_TLS.certificateKey}`]: gatewayCertificate,
    [`spicedb_${SPICEDB_HTTP_TLS.privateKeyKey}`]: pemBlock(request.key, PRIVATE_KEY),
  };
};

const respond = (stage: FakeStage, command: OpsCommand, nextId: () => string) => {
  stage.commands.push(command);
  if (command.stdin !== undefined) {
    stage.inputs.push({ command: renderCommand(command), stdin: Redacted.value(command.stdin) });
  }
  return Match.value(command.command).pipe(
    Match.when('zcli', () => zcliAnswer(stage, command, nextId)),
    Match.when('gh', () => ghAnswer(stage, command)),
    Match.when('git', () => gitAnswer(stage, command)),
    Match.when('pnpm', () => Effect.succeed('')),
    Match.when('openssl', () => Effect.sync(() => openssl(command.args))),
    Match.orElse(() => unexpected(command)),
  );
};

export const fakeStage = (initial: FakeStageInitial): FakeStage => {
  let counter = 0;
  const nextId = () => {
    counter += 1;
    return `imported-${String(counter)}`;
  };
  const state: Omit<FakeStage, 'layer'> = {
    branchPolicies: [],
    commands: [],
    deployments: [...(initial.deployments ?? [])],
    dirtyPaths: new Set(),
    environments: new Set(initial.environments ?? ['stage']),
    hiddenOnImport: new Set(),
    inputs: [],
    projects: [...(initial.projects ?? [])],
    projectUserKeys: [...(initial.projectUserKeys ?? [])],
    projectValues: new Map(Object.entries(initial.projectValues ?? {})),
    secrets: new Map(
      Object.entries(initial.secrets ?? {}).map(([environment, names]) => [environment, new Set(names)]),
    ),
    sensitiveKeys: new Set(initial.sensitiveKeys),
    services: [...(initial.services ?? [])],
    serviceUserKeys: new Map(Object.entries(initial.serviceUserKeys ?? {}).map(([key, keys]) => [key, [...keys]])),
    variables: new Map(
      Object.entries(initial.variables ?? {}).map(([environment, values]) => [
        environment,
        new Map(Object.entries(values)),
      ]),
    ),
  };
  // The layer answers against this same object, so tests observe every change the scripts make.
  const stage: FakeStage = Object.assign(state, {
    layer: Layer.succeed(OpsShell, {
      run: (command: OpsCommand) => Effect.suspend(() => respond(stage, command, nextId)),
    }),
  });
  return stage;
};

const MUTATING_ZCLI = /^zcli (?:project (?:create|service-import)|service delete|push)/u;
const MUTATING_GH = /^gh (?:variable set|secret set|workflow run|api -X)/u;

/** Commands that change Zerops, GitHub or a Worker (as opposed to reads). */
export const mutatingCommands = (commands: readonly OpsCommand[]) =>
  commands.filter((command) => {
    const rendered = renderCommand(command);
    return MUTATING_ZCLI.test(rendered) || MUTATING_GH.test(rendered) || rendered.includes('wrangler secret');
  });

// ---------------------------------------------------------------------------------------------
// Zerops REST API

export interface FakeServiceSecret {
  readonly content: string;
  readonly key: string;
  readonly serviceId: string;
}

export interface FakeZeropsApi {
  readonly layer: Layer.Layer<ZeropsPublicApi>;
  readonly serviceSecrets: FakeServiceSecret[];
}

const notFaked = (operation: string) => () => Effect.die(new Error(`the fake Zerops API has no ${operation}`));

/** A service secret becomes visible to `zcli project env` as `<hostname>_<KEY>`, as on Zerops. */
export const fakeZeropsApi = (
  stage: FakeStage,
  serviceIdentities: ReadonlyMap<
    string,
    Pick<ZeropsServiceStackIdentity, 'base' | 'isSystem' | 'subdomainAccess'>
  > = new Map(),
): FakeZeropsApi => {
  const serviceSecrets: FakeServiceSecret[] = [];
  const layer = Layer.succeed(
    ZeropsPublicApi,
    ZeropsPublicApi.of({
      createServiceSecret: (serviceId, key, content) =>
        Effect.sync(() => {
          serviceSecrets.push({ content, key, serviceId });
          const hostname = stage.services.find(({ id }) => id === serviceId)?.hostname ?? serviceId;
          stage.projectUserKeys.push(`${hostname}_${key}`);
          stage.projectValues.set(`${hostname}_${key}`, content);
          stage.sensitiveKeys.add(`${hostname}_${key}`);
        }),
      deleteService: (serviceId) =>
        Effect.gen(function* deleteFakeService() {
          if (!stage.services.some(({ id }) => id === serviceId)) {
            yield* new ZeropsApiError({ message: `fake Zerops service ${serviceId} does not exist` });
          }
          stage.services = stage.services.filter(({ id }) => id !== serviceId);
        }),
      enableSubdomainAccess: notFaked('enableSubdomainAccess'),
      findServiceStack: notFaked('findServiceStack'),
      findServiceStackIdentity: (serviceId) =>
        Effect.suspend(() => {
          const service = stage.services.find(({ id }) => id === serviceId);
          if (service === undefined) {
            return Effect.succeed(Option.none());
          }
          const identity = serviceIdentities.get(serviceId);
          if (identity === undefined) {
            return Effect.fail(
              new ZeropsApiError({ message: `fake Zerops service ${serviceId} has no native identity` }),
            );
          }
          return Effect.succeed(Option.some({ ...identity, name: service.hostname, status: service.status }));
        }),
      projectEnvFile: notFaked('projectEnvFile'),
      projectEnvs: notFaked('projectEnvs'),
      serviceSecrets: (serviceId) =>
        Effect.sync(() => {
          const prefix = `${stage.services.find(({ id }) => id === serviceId)?.hostname ?? serviceId}_`;
          return new Map(
            [...stage.projectValues]
              .filter(([key]) => key.startsWith(prefix))
              .map(([key, value]) => [key.slice(prefix.length), Redacted.make(value)] as const),
          );
        }),
      serviceStack: notFaked('serviceStack'),
      stopService: notFaked('stopService'),
      upsertProjectEnv: notFaked('upsertProjectEnv'),
    }),
  );
  return { layer, serviceSecrets };
};

// ---------------------------------------------------------------------------------------------
// Cloudflare account through the HttpClient

const TunnelSchema = Schema.Struct({ id: Schema.String, name: Schema.String, status: Schema.String });
export type FakeTunnel = typeof TunnelSchema.Type;

const VpcServiceBodySchema = Schema.Struct({
  app_protocol: Schema.optionalKey(Schema.String),
  host: Schema.Struct({ hostname: Schema.String, resolver_network: Schema.Struct({ tunnel_id: Schema.String }) }),
  http_port: Schema.optionalKey(Schema.Number),
  https_port: Schema.optionalKey(Schema.Number),
  name: Schema.String,
  tcp_port: Schema.optionalKey(Schema.Number),
  tls_settings: Schema.optionalKey(Schema.Struct({ cert_verification_mode: Schema.String })),
  type: Schema.String,
});
const VpcServiceSchema = Schema.Struct({ ...VpcServiceBodySchema.fields, service_id: Schema.String });
export type FakeVpcService = typeof VpcServiceSchema.Type;

const HyperdriveBodySchema = Schema.Struct({
  caching: Schema.Struct({ disabled: Schema.Boolean }),
  name: Schema.String,
  origin: Schema.Struct({
    database: Schema.String,
    scheme: Schema.String,
    service_id: Schema.String,
    user: Schema.String,
  }),
  origin_connection_limit: Schema.Number,
});
const HyperdriveSchema = Schema.Struct({ ...HyperdriveBodySchema.fields, id: Schema.String });

const OriginCertificateBodySchema = Schema.Struct({
  csr: Schema.String,
  hostnames: Schema.Array(Schema.String),
  request_type: Schema.Literal('origin-ecc'),
  requested_validity: Schema.Number,
});
export type FakeHyperdrive = typeof HyperdriveSchema.Type;

export interface FakeCloudflareRequest {
  readonly body: Option.Option<Json>;
  readonly method: string;
  readonly url: URL;
}

/** A cost-guard object the fake stores as the API returns it. */
export type FakeRecord = Readonly<Record<string, Json>>;

export interface FakeRuleset {
  readonly id: string;
  readonly kind: string;
  readonly phase: string;
  rules: FakeRecord[];
}

export interface FakeZone {
  readonly id: string;
  readonly name: string;
}

/** One Worker script's usage in the window the GraphQL Analytics API is asked about. */
export interface FakeUsage {
  readonly cpuTimeUs: number;
  readonly requests: number;
  readonly scriptName: string;
}

const KvNamespaceBodySchema = Schema.Struct({ title: Schema.String });
const KvNamespaceSchema = Schema.Struct({ id: Schema.String, title: Schema.String });
export type FakeKvNamespace = typeof KvNamespaceSchema.Type;

export interface FakeCloudflareAccount {
  readonly accessApps: FakeRecord[];
  /** Whether Zero Trust is on; while it is off every Access route answers `access.api.error.not_enabled`. */
  accessEnabled: boolean;
  readonly accessPolicies: FakeRecord[];
  readonly alertPolicies: FakeRecord[];
  readonly hyperdrives: FakeHyperdrive[];
  /** Key names per KV namespace id. */
  readonly kvKeys: Map<string, string[]>;
  readonly kvNamespaces: FakeKvNamespace[];
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
  readonly requests: FakeCloudflareRequest[];
  readonly rulesets: FakeRuleset[];
  readonly scripts: string[];
  /** Secret names per Worker script. */
  readonly secrets: Map<string, string[]>;
  readonly serviceTokens: FakeRecord[];
  readonly tunnels: FakeTunnel[];
  /** What the GraphQL Analytics API reports for any window, one row per script. */
  usage: readonly FakeUsage[];
  readonly vpcServices: FakeVpcService[];
  readonly zones: FakeZone[];
}

export interface FakeCloudflareInitial {
  readonly accessApps?: readonly FakeRecord[];
  readonly accessEnabled?: boolean;
  readonly accessPolicies?: readonly FakeRecord[];
  readonly alertPolicies?: readonly FakeRecord[];
  readonly hyperdrives?: readonly FakeHyperdrive[];
  readonly kvKeys?: Readonly<Record<string, readonly string[]>>;
  readonly kvNamespaces?: readonly FakeKvNamespace[];
  readonly rulesets?: readonly FakeRuleset[];
  readonly scripts?: readonly string[];
  readonly secrets?: Readonly<Record<string, readonly string[]>>;
  readonly serviceTokens?: readonly FakeRecord[];
  readonly tunnels?: readonly FakeTunnel[];
  readonly tunnelStatus?: string;
  readonly usage?: readonly FakeUsage[];
  readonly vpcServices?: readonly FakeVpcService[];
  /** Defaults to the test stage zone `stage.example.com` as `zone-1`. */
  readonly zones?: readonly FakeZone[];
}

const requestBody = (request: HttpClientRequest.HttpClientRequest): Option.Option<Json> =>
  Match.value(request.body).pipe(
    Match.tag('Uint8Array', ({ body }) =>
      Option.some(Schema.decodeUnknownSync(JsonText)(new TextDecoder().decode(body))),
    ),
    Match.orElse(() => Option.none()),
  );

const envelope = (result: Json) => Response.json({ errors: [], messages: [], result, success: true });

const decodeBody = <A, I>(schema: Schema.Codec<A, I>, body: Option.Option<Json>) =>
  Schema.decodeUnknownSync(schema)(Option.getOrNull(body));

const firstPage = (url: URL, items: Json) => envelope(Number(url.searchParams.get('page')) > 1 ? [] : items);

const tunnelAnswer = (
  account: Omit<FakeCloudflareAccount, 'layer'>,
  initial: FakeCloudflareInitial,
  method: string,
  url: URL,
  path: string,
) => {
  if (path === '/cfd_tunnel') {
    if (method === 'POST') {
      const tunnel = { id: 'tunnel-1', name: 'ontos-stage', status: initial.tunnelStatus ?? 'healthy' };
      account.tunnels.push(tunnel);
      return envelope(tunnel);
    }
    return envelope(account.tunnels.filter(({ name }) => name === url.searchParams.get('name')));
  }
  if (path.endsWith('/token')) {
    return envelope('tunnel-connector-token');
  }
  const tunnel = account.tunnels.find(({ id }) => path === `/cfd_tunnel/${id}`);
  return tunnel === undefined ? undefined : envelope(tunnel);
};

const RecordSchema = Schema.Record(Schema.String, Schema.Json);
const RulesSchema = Schema.Struct({ rules: Schema.Array(RecordSchema) });

type FakeState = Omit<FakeCloudflareAccount, 'layer'>;

/** Stores a POSTed object with a fresh `id`, or replaces the one a PUT names. */
const collection = (
  items: FakeRecord[],
  prefix: string,
  method: string,
  id: string | undefined,
  body: Option.Option<Json>,
  created: (record: FakeRecord, id: string) => FakeRecord = (record, newId) => ({ ...record, id: newId }),
) => {
  if (method === 'GET' && id === undefined) {
    return items;
  }
  const record = decodeBody(RecordSchema, body);
  if (method === 'POST') {
    const stored = created(record, `${prefix}-${String(items.length + 1)}`);
    items.push(stored);
    return stored;
  }
  const index = items.findIndex((item) => item.id === id);
  const replaced = { ...record, id: id ?? '' };
  if (index !== -1) {
    items[index] = replaced;
  }
  return index === -1 ? undefined : replaced;
};

const serviceTokenAnswer = (account: FakeState, method: string, path: string) => {
  const rotated = /^\/access\/service_tokens\/(?<id>[^/]+)\/rotate$/u.exec(path)?.groups?.id;
  if (rotated !== undefined) {
    const token = account.serviceTokens.find(({ id }) => id === rotated);
    return token === undefined ? undefined : { ...token, client_secret: 'rotated-service-token-secret' };
  }
  if (method === 'GET') {
    return account.serviceTokens;
  }
  const token = {
    client_id: 'access-client-id',
    id: `token-${String(account.serviceTokens.length + 1)}`,
    name: 'ontos-stage-ci',
  };
  account.serviceTokens.push(token);
  return { ...token, client_secret: 'service-token-secret' };
};

const accountGuardAnswer = (account: FakeState, method: string, path: string, body: Option.Option<Json>) => {
  const match = /^\/(?<resource>access\/policies|access\/apps|alerting\/v3\/policies)(?:\/(?<id>[^/]+))?$/u.exec(path);
  const resource = match?.groups?.resource;
  const id = match?.groups?.id;
  if (resource === 'access/policies') {
    return collection(account.accessPolicies, 'policy', method, id, body);
  }
  if (resource === 'access/apps') {
    return collection(account.accessApps, 'app', method, id, body);
  }
  if (resource === 'alerting/v3/policies') {
    const stored = collection(account.alertPolicies, 'alert', method, id, body);
    return Array.isArray(stored) || stored === undefined ? stored : { id: stored.id ?? '' };
  }
  return path.startsWith('/access/service_tokens') ? serviceTokenAnswer(account, method, path) : undefined;
};

const rulesetView = ({ id, rules }: FakeRuleset) => ({ id, rules });

const withRuleIds = (ruleset: FakeRuleset, rules: readonly FakeRecord[]) =>
  rules.map((rule, index) => ({ ...rule, id: `${ruleset.id}-rule-${String(ruleset.rules.length + index + 1)}` }));

const zoneAnswer = (account: FakeState, method: string, url: URL, body: Option.Option<Json>): Json | undefined => {
  const path = url.pathname.replace(/^\/client\/v4\/zones/u, '');
  if (path === '') {
    return account.zones
      .filter(({ name }) => name === url.searchParams.get('name'))
      .map(({ id, name }) => ({ id, name }));
  }
  const parts = /^\/[^/]+\/rulesets(?:\/(?<rest>.*))?$/u.exec(path)?.groups;
  const rest = parts?.rest;
  if (parts === undefined) {
    return undefined;
  }
  if (rest === undefined) {
    return account.rulesets.map(({ id, kind, phase }) => ({ id, kind, phase }));
  }
  const phase = /^phases\/(?<phase>[^/]+)\/entrypoint$/u.exec(rest)?.groups?.phase;
  if (phase !== undefined) {
    const ruleset: FakeRuleset = { id: `ruleset-${phase}`, kind: 'zone', phase, rules: [] };
    ruleset.rules = withRuleIds(ruleset, decodeBody(RulesSchema, body).rules);
    account.rulesets.push(ruleset);
    return rulesetView(ruleset);
  }
  const [rulesetId, , ruleId] = rest.split('/');
  const ruleset = account.rulesets.find(({ id }) => id === rulesetId);
  if (ruleset === undefined) {
    return undefined;
  }
  if (method === 'POST') {
    ruleset.rules.push(...withRuleIds(ruleset, [decodeBody(RecordSchema, body)]));
  }
  if (method === 'PATCH') {
    ruleset.rules = ruleset.rules.map((rule) =>
      rule.id === ruleId ? { ...decodeBody(RecordSchema, body), id: ruleId ?? '' } : rule,
    );
  }
  return rulesetView(ruleset);
};

const graphqlAnswer = (account: FakeState) =>
  Response.json({
    data: {
      viewer: {
        accounts: [
          {
            workersInvocationsAdaptive: account.usage.map(({ cpuTimeUs, requests, scriptName }) => ({
              dimensions: { scriptName },
              sum: { cpuTimeUs, requests },
            })),
          },
        ],
      },
    },
    errors: null,
  });

const noRoute = () =>
  Response.json(
    { errors: [{ code: 7003, message: 'No route for that URI' }], result: null, success: false },
    { status: 404 },
  );

const accessNotEnabled = () =>
  Response.json(
    { errors: [{ code: 9999, message: 'access.api.error.not_enabled' }], result: null, success: false },
    { status: 403 },
  );

/** Routes outside `/accounts/<id>`: Origin CA certificates, GraphQL analytics and zones. */
const nonAccountAnswer = (
  account: FakeState,
  method: string,
  url: URL,
  body: Option.Option<Json>,
): Response | undefined => {
  if (url.pathname === '/client/v4/certificates' && method === 'POST') {
    const { csr, hostnames, requested_validity } = decodeBody(OriginCertificateBodySchema, body);
    const certificate = signWithFakeOriginCa(csr, hostnames, requested_validity);
    return envelope({ certificate, expires_on: '2041-01-01 00:00:00 +0000 UTC', hostnames, id: 'origin-cert-1' });
  }
  if (url.pathname === '/client/v4/graphql') {
    return graphqlAnswer(account);
  }
  if (!url.pathname.startsWith('/client/v4/zones')) {
    return undefined;
  }
  const zoneResult = zoneAnswer(account, method, url, body);
  return zoneResult === undefined ? noRoute() : envelope(zoneResult);
};

/** The KV namespace list and create routes, and a namespace's key list (names only, by prefix). */
const kvAnswer = (account: FakeState, method: string, url: URL, path: string, body: Option.Option<Json>): Response => {
  if (path === '/storage/kv/namespaces') {
    if (method === 'POST') {
      const created = {
        ...decodeBody(KvNamespaceBodySchema, body),
        id: `kv-${String(account.kvNamespaces.length + 1)}`,
      };
      account.kvNamespaces.push(created);
      return envelope(created);
    }
    return firstPage(url, account.kvNamespaces);
  }
  const namespace = /^\/storage\/kv\/namespaces\/(?<namespace>[^/]+)\/keys$/u.exec(path)?.groups?.namespace;
  if (namespace === undefined) {
    return noRoute();
  }
  const prefix = url.searchParams.get('prefix') ?? '';
  const names = (account.kvKeys.get(namespace) ?? []).filter((name) => name.startsWith(prefix));
  return envelope(names.map((name) => ({ name })));
};

export const fakeCloudflareAccount = (initial: FakeCloudflareInitial): FakeCloudflareAccount => {
  const account: FakeState = {
    accessApps: [...(initial.accessApps ?? [])],
    accessEnabled: initial.accessEnabled ?? true,
    accessPolicies: [...(initial.accessPolicies ?? [])],
    alertPolicies: [...(initial.alertPolicies ?? [])],
    hyperdrives: [...(initial.hyperdrives ?? [])],
    kvKeys: new Map(Object.entries(initial.kvKeys ?? {}).map(([namespace, names]) => [namespace, [...names]])),
    kvNamespaces: [...(initial.kvNamespaces ?? [])],
    requests: [],
    rulesets: (initial.rulesets ?? []).map((ruleset) => ({ ...ruleset, rules: [...ruleset.rules] })),
    scripts: [...(initial.scripts ?? [])],
    secrets: new Map(Object.entries(initial.secrets ?? {}).map(([script, names]) => [script, [...names]])),
    serviceTokens: [...(initial.serviceTokens ?? [])],
    tunnels: [...(initial.tunnels ?? [])],
    usage: [...(initial.usage ?? [])],
    vpcServices: [...(initial.vpcServices ?? [])],
    zones: [...(initial.zones ?? [{ id: 'zone-1', name: 'stage.example.com' }])],
  };
  const answer = (method: string, url: URL, body: Option.Option<Json>): Response => {
    const outsideAccount = nonAccountAnswer(account, method, url, body);
    if (outsideAccount !== undefined) {
      return outsideAccount;
    }
    const path = url.pathname.replace(/^\/client\/v4\/accounts\/[^/]+/u, '');
    if (!account.accessEnabled && path.startsWith('/access/')) {
      return accessNotEnabled();
    }
    const guardResult = accountGuardAnswer(account, method, path, body);
    if (guardResult !== undefined) {
      return Array.isArray(guardResult) ? firstPage(url, guardResult) : envelope(guardResult);
    }
    if (path.startsWith('/cfd_tunnel')) {
      return tunnelAnswer(account, initial, method, url, path) ?? noRoute();
    }
    if (path === '/connectivity/directory/services') {
      if (method === 'POST') {
        const created = {
          ...decodeBody(VpcServiceBodySchema, body),
          service_id: `vpc-${String(account.vpcServices.length + 1)}`,
        };
        account.vpcServices.push(created);
        return envelope(created);
      }
      return firstPage(url, account.vpcServices);
    }
    if (path === '/hyperdrive/configs') {
      if (method === 'POST') {
        const created = { ...decodeBody(HyperdriveBodySchema, body), id: 'hyperdrive-1' };
        account.hyperdrives.push(created);
        return envelope(created);
      }
      return firstPage(url, account.hyperdrives);
    }
    if (path.startsWith('/storage/kv/namespaces')) {
      return kvAnswer(account, method, url, path, body);
    }
    const secretScript = /^\/workers\/scripts\/(?<script>[^/]+)\/secrets$/u.exec(path)?.groups?.script;
    if (secretScript !== undefined) {
      const names = account.secrets.get(decodeURIComponent(secretScript));
      return names === undefined ? noRoute() : envelope(names.map((name) => ({ name, type: 'secret_text' })));
    }
    return path === '/workers/scripts' ? envelope(account.scripts.map((id) => ({ id }))) : noRoute();
  };
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      const body = requestBody(request);
      account.requests.push({ body, method: request.method, url });
      return Effect.succeed(HttpClientResponse.fromWeb(request, answer(request.method, url, body)));
    }),
  );
  // The layer answers against this same object, so tests observe every change and can set `usage`.
  return Object.assign(account, { layer });
};
