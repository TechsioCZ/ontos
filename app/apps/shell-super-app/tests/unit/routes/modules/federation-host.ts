import { createInstance } from '@module-federation/modern-js-v3/runtime';
import type { ModuleFederationRuntimePlugin } from '@module-federation/modern-js-v3/runtime';
import { HttpRouter, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, FiberSet, Layer, MutableRef, Option, Queue } from 'effect';
import { constVoid } from 'effect/Function';

import type { ModuleEntrypointNamespace } from '../../../../src/routes/module-entrypoint-loader.ts';
import { browserNetwork } from '@app/shared-contracts/testing/http-double';

/** The native Federation host the Shell finds by name before it registers an approved remote. */
export const shellHostName = 'shellSuperApp';

/**
 * What the exposed module behind one `remoteName/exposePath` request evaluates to when the SDK
 * executes its factory.
 */
export type ExposeAnswer = (request: string) => Effect.Effect<ModuleEntrypointNamespace, Error>;

/** The remote as the Shell registered it with the native host. */
export interface RegisteredRemote {
  readonly entry: string;
  readonly name: string;
}

/** Runs an Effect in the scope of the test that installed the host, for a caller outside Effect. */
type TestScopeRunner = Effect.Success<ReturnType<typeof FiberSet.makeRuntimePromise<never>>>;

/** The test the remotes' origin currently serves, and what its host has seen. */
interface OriginTenant {
  readonly answer: ExposeAnswer;
  readonly refusedRemotes: readonly string[];
  readonly registered: RegisteredRemote[];
  readonly requested: Queue.Queue<string>;
  readonly requests: string[];
  readonly run: TestScopeRunner;
  readonly settled: Map<string, Deferred.Deferred<string>>;
}

/**
 * The federation manifest every approved remote's build publishes beside its entry. Its public path
 * is `auto`, so the SDK resolves each remote's entry next to that remote's own manifest URL.
 */
const publishedManifest = {
  exposes: [],
  id: 'approvedRemote',
  metaData: {
    buildInfo: { buildName: 'approvedRemote', buildVersion: 'release-a' },
    globalName: 'approvedRemote',
    name: 'approvedRemote',
    pluginVersion: '2.9.3',
    publicPath: 'auto',
    remoteEntry: { name: 'remoteEntry.js', path: '', type: 'global' },
    type: 'app',
    types: { api: '', name: '', path: '', zip: '' },
  },
  name: 'approvedRemote',
  remotes: [],
  shared: [],
};

/** The remotes' asset host, answering every manifest request the test DOM's network makes. */
const assetHost = HttpRouter.add('GET', '/*', HttpServerResponse.jsonUnsafe(publishedManifest));

/**
 * The remotes' asset origin. Like a CDN it publishes each remote's container once, and the native
 * SDK caches it per document across hosts; the exposed modules it evaluates belong to the test the
 * origin currently serves.
 */
const origin = MutableRef.make(Option.none<OriginTenant>());

const servingTenant = () =>
  Option.getOrThrowWith(MutableRef.get(origin), () => new Error('The test remote origin is not serving a test.'));

/** A remote's container as its published entry exposes it: `init`, then `get` per exposed module. */
const container = (remoteName: string) => ({
  get: (expose: string) => {
    const tenant = servingTenant();
    const request = `${remoteName}/${expose.slice(2)}`;
    tenant.requests.push(request);
    Queue.offerUnsafe(tenant.requested, request);
    return async () => await tenant.run(tenant.answer(request));
  },
  init: constVoid,
});

const settledSignal = (tenant: OriginTenant, request: string) => {
  const signal = tenant.settled.get(request) ?? Deferred.makeUnsafe<string>();
  tenant.settled.set(request, signal);
  return signal;
};

/** The runtime plugin through which the host reaches the remotes' origin and reports to the test. */
const remoteOriginPlugin = (tenant: OriginTenant): ModuleFederationRuntimePlugin => ({
  afterLoadRemote: ({ id }) => {
    Deferred.doneUnsafe(settledSignal(tenant, id), Effect.succeed(id));
  },
  loadEntry: ({ remoteInfo }) => container(remoteInfo.name),
  name: 'ontos-test-remote-origin',
  registerRemote: (registration) => {
    const { remote } = registration;
    if (tenant.refusedRemotes.includes(remote.name)) {
      throw new Error(`The test origin refuses to register ${remote.name}.`);
    }
    tenant.registered.push({ entry: 'entry' in remote ? remote.entry : '', name: remote.name });
    return registration;
  },
});

/**
 * A real native Federation host named as the Shell's. The SDK fetches each remote's manifest from
 * the asset host through the test DOM's network, and a runtime plugin hands it each remote's
 * container, whose exposed factories evaluate to what `answer` gives. Everything between the Shell
 * and that origin (registration, manifest snapshot, container init, expose lookup) runs in the SDK
 * itself. The host leaves the SDK's instance registry with the scope.
 */
export const makeFederationHost = (options: {
  readonly answer: ExposeAnswer;
  /** Remote names the runtime plugin rejects when the Shell registers them. */
  readonly refusedRemotes: readonly string[];
}) =>
  Effect.gen(function* makeFederationHostEffect() {
    const tenant: OriginTenant = {
      answer: options.answer,
      refusedRemotes: options.refusedRemotes,
      registered: [],
      requested: yield* Queue.unbounded<string>(),
      requests: [],
      run: yield* FiberSet.makeRuntimePromise(),
      settled: new Map(),
    };
    yield* Layer.build(browserNetwork(assetHost));
    const host = yield* Effect.acquireRelease(
      Effect.sync(() => {
        MutableRef.set(origin, Option.some(tenant));
        return createInstance({ name: shellHostName, plugins: [remoteOriginPlugin(tenant)], remotes: [] });
      }),
      (instance) =>
        Effect.sync(() => {
          MutableRef.set(origin, Option.none());
          const instances = globalThis.__FEDERATION__.__INSTANCES__;
          instances.splice(instances.indexOf(instance), 1);
        }),
    );
    return {
      host,
      /** Resolves with the next exposed module the SDK asks the origin for, in request order. */
      nextRequest: Queue.take(tenant.requested),
      registered: tenant.registered,
      requests: tenant.requests,
      /** Resolves once the SDK has settled a load of `request`, successfully or not. */
      settled: (request: string) => Deferred.await(settledSignal(tenant, request)),
    } as const;
  });
