import { existsSync, readFileSync } from 'node:fs';

import { Effect, FileSystem, Layer, Match, Option, Path, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';
import type { HttpClientRequest } from 'effect/unstable/http';
import { parse as parseYaml } from 'yaml';

import { OpsCommandError } from '../ops/ops-command-error.mts';
import { OpsShell, renderCommand } from '../ops/ops-shell.mts';
import type { OpsCommand, OpsShellService } from '../ops/ops-shell.mts';
import type { ZeropsService } from '../ops/stage-operations.mts';

/**
 * In-memory stand-ins for everything the stage operations touch: Zerops and GitHub behind the
 * `OpsShell` seam, the Cloudflare account behind the Effect `HttpClient` seam, and repository files
 * behind `FileSystem`. Each records what the scripts asked for, so tests assert exact mutations.
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
    writeFileString: (path, data) =>
      Effect.sync(() => {
        writes.set(path, data);
      }),
  });
  return { layer: Layer.merge(fileSystem, Path.layer), writes };
};

const DATA_LAYER_IMPORT_ENTRIES = [
  '  - hostname: cloudflared',
  '    type: alpine@3.23',
  '    minContainers: 2',
  '  - hostname: outboxworkerhost',
  '    type: nodejs@24',
  '',
].join('\n');

/** zerops-import.yaml with the data-layer entries whose setups other PRs add. */
export const importWithDataLayer =
  readFileSync(`${APP_DIRECTORY}/zerops-import.yaml`, 'utf-8') + DATA_LAYER_IMPORT_ENTRIES;

// ---------------------------------------------------------------------------------------------
// Zerops and GitHub through the shell

/** The revision the fake `git rev-parse HEAD` reports. */
export const FAKE_REVISION = '0123456789abcdef';

export interface FakeStage {
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
  readonly projectUserKeys: string[];
  /** Project-scope variable values, including `<hostname>_<KEY>` references. */
  readonly projectValues: Map<string, string>;
  services: ZeropsService[];
  readonly serviceUserKeys: Map<string, string[]>;
  readonly variables: Map<string, Map<string, string>>;
}

export interface FakeStageInitial {
  readonly deployments?: readonly { id: number; sha: string; state: string }[];
  readonly environments?: readonly string[];
  readonly projectUserKeys?: readonly string[];
  readonly projectValues?: Readonly<Record<string, string>>;
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

const unexpected = (command: OpsCommand) =>
  Effect.fail(new OpsCommandError({ command: renderCommand(command), message: 'unexpected command' }));

const ImportSchema = Schema.Struct({ services: Schema.Array(Schema.Struct({ hostname: Schema.String })) });
const VALUE_TEMPLATE = /^\{\{if eq \.Key "(?<key>[^"]+)"\}\}/u;

const zcliAnswer = (stage: FakeStage, command: OpsCommand, nextId: () => string) => {
  const { args } = command;
  const [group, action] = args;
  if (group === 'service' && action === 'list') {
    return Effect.succeed(table(stage.services));
  }
  if (group === 'project' && action === 'env') {
    const valueKey = VALUE_TEMPLATE.exec(option(args, '--template') ?? '')?.groups?.key;
    if (valueKey !== undefined) {
      // zcli prints one (usually empty) line per variable.
      return Effect.succeed(`\n\n${stage.projectValues.get(valueKey) ?? ''}\n\n`);
    }
    const service = option(args, '--service');
    const keys = service === undefined ? stage.projectUserKeys : (stage.serviceUserKeys.get(service) ?? []);
    return Effect.succeed(`${keys.join('\n')}\n`);
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
    commands: [],
    deployments: [...(initial.deployments ?? [])],
    dirtyPaths: new Set(),
    environments: new Set(initial.environments ?? ['stage']),
    hiddenOnImport: new Set(),
    inputs: [],
    projectUserKeys: [...(initial.projectUserKeys ?? [])],
    projectValues: new Map(Object.entries(initial.projectValues ?? {})),
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

const MUTATING_ZCLI = /^zcli (?:project service-import|service delete|push)/u;
const MUTATING_GH = /^gh (?:variable set|secret set|workflow run|api -X)/u;

/** Commands that change Zerops, GitHub or a Worker (as opposed to reads). */
export const mutatingCommands = (commands: readonly OpsCommand[]) =>
  commands.filter((command) => {
    const rendered = renderCommand(command);
    return MUTATING_ZCLI.test(rendered) || MUTATING_GH.test(rendered) || rendered.includes('wrangler secret');
  });

// ---------------------------------------------------------------------------------------------
// Cloudflare account through the HttpClient

const TunnelSchema = Schema.Struct({ id: Schema.String, name: Schema.String, status: Schema.String });
export type FakeTunnel = typeof TunnelSchema.Type;

const VpcServiceBodySchema = Schema.Struct({
  app_protocol: Schema.optionalKey(Schema.String),
  host: Schema.Struct({ hostname: Schema.String, resolver_network: Schema.Struct({ tunnel_id: Schema.String }) }),
  http_port: Schema.optionalKey(Schema.Number),
  name: Schema.String,
  tcp_port: Schema.optionalKey(Schema.Number),
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
export type FakeHyperdrive = typeof HyperdriveSchema.Type;

export interface FakeCloudflareRequest {
  readonly body: Option.Option<Json>;
  readonly method: string;
  readonly url: URL;
}

export interface FakeCloudflareAccount {
  readonly hyperdrives: FakeHyperdrive[];
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
  readonly requests: FakeCloudflareRequest[];
  readonly scripts: string[];
  /** Secret names per Worker script. */
  readonly secrets: Map<string, string[]>;
  readonly tunnels: FakeTunnel[];
  readonly vpcServices: FakeVpcService[];
}

export interface FakeCloudflareInitial {
  readonly hyperdrives?: readonly FakeHyperdrive[];
  readonly scripts?: readonly string[];
  readonly secrets?: Readonly<Record<string, readonly string[]>>;
  readonly tunnels?: readonly FakeTunnel[];
  readonly tunnelStatus?: string;
  readonly vpcServices?: readonly FakeVpcService[];
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

const noRoute = () =>
  Response.json(
    { errors: [{ code: 7003, message: 'No route for that URI' }], result: null, success: false },
    { status: 404 },
  );

export const fakeCloudflareAccount = (initial: FakeCloudflareInitial): FakeCloudflareAccount => {
  const account: Omit<FakeCloudflareAccount, 'layer'> = {
    hyperdrives: [...(initial.hyperdrives ?? [])],
    requests: [],
    scripts: [...(initial.scripts ?? [])],
    secrets: new Map(Object.entries(initial.secrets ?? {}).map(([script, names]) => [script, [...names]])),
    tunnels: [...(initial.tunnels ?? [])],
    vpcServices: [...(initial.vpcServices ?? [])],
  };
  const answer = (method: string, url: URL, body: Option.Option<Json>): Response => {
    const path = url.pathname.replace(/^\/client\/v4\/accounts\/[^/]+/u, '');
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
  return { ...account, layer };
};
