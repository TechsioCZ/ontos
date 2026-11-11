import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Config, ConfigProvider, Effect, Option, Queue, Redacted, Ref, Schema, Stream } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { claimHostedModuleCredentials } from '../../packages/core-runtime/src/auth/hosted-module-credential-store.ts';
import { moduleCredentialConfigProvider } from '../../packages/core-runtime/src/auth/owner-module-credential.ts';
import {
  captureChannel,
  healModuleCredentialsOnce,
  makeSupervisedChild,
  planModuleCredentialHealing,
} from '../zerops/app-host.mts';
import type { HandoverChannel } from '../zerops/app-host.mts';
import {
  applyModuleCredentialHandovers,
  encodeModuleCredentialHandover,
  noProvisionedCredentials,
  ProvisioningOutputJsonSchema,
} from '../zerops/module-credentials.mts';
import type { ProvisioningOutput } from '../zerops/module-credentials.mts';

const ORDER = 'commerce-order';
const PARTY = 'party-registry';
const ORDER_PROVIDER_KEY = 'commerce-order-provider-key';
const ORDER_KEY = 'commerce-order-module-key';
const HANDOVER_LOOKALIKE = '{"schemaVersion":1,"credentials":{}}';
const decoder = new TextDecoder();

/** What one owner of this process reads as its module credential, per call. */
const readOwnerCredential = (appId: string) =>
  Config.option(Config.String('ONTOS_GATEWAY_MODULE_API_KEY'))
    .parse(moduleCredentialConfigProvider(ConfigProvider.fromUnknown({}), appId))
    .pipe(Effect.map(Option.getOrUndefined));

const output = (credentials: Readonly<Record<string, string>>, failedAppIds: readonly string[] = []) =>
  Schema.decodeUnknownSync(ProvisioningOutputJsonSchema)(
    JSON.stringify({
      credentials,
      failedAppIds,
      providerKeyIds: Object.keys(credentials).map((appId) => `${appId}-provider-key`),
      schemaVersion: 1,
    }),
  );

describe('the provisioning channel', () => {
  it.live('reads a child pass from its file descriptor 3 while stray logs go to its standard output', () =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(path.join(tmpdir(), 'module-credential-channel-'))),
      (directory) =>
        Effect.gen(function* strayLogs() {
          const child = path.join(directory, 'pass.mjs');
          const pass = JSON.stringify({
            credentials: { [ORDER]: ORDER_KEY },
            failedAppIds: [],
            providerKeyIds: ['order-provider-key'],
            schemaVersion: 1,
          });
          writeFileSync(
            child,
            [
              "import { Socket } from 'node:net';",
              // A log line that looks like a handover, and one that is not JSON at all: neither reaches the channel.
              `console.log(${JSON.stringify(HANDOVER_LOOKALIKE)});`,
              "console.log('[module-credentials] issued for commerce-order');",
              `new Socket({ fd: 3, readable: false, writable: true }).end(${JSON.stringify(pass)});`,
            ].join('\n'),
          );
          const received = yield* captureChannel('stray-log-probe', [child], {});
          const decoded = yield* Schema.decodeEffect(ProvisioningOutputJsonSchema)(received.trim());
          expect(Object.keys(decoded.credentials)).toEqual([ORDER]);
          expect(decoded.providerKeyIds).toEqual(['order-provider-key']);
        }),
      (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live('fails a child that exits without success, whatever it wrote', () =>
    Effect.gen(function* failedChild() {
      const exit = yield* Effect.exit(captureChannel('failing-probe', ['--eval', 'process.exit(3)'], {}));
      expect(exit._tag).toBe('Failure');
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe('a process receiving handovers on its channel', () => {
  it.effect('fills each served owner once, refuses malformed lines and strangers, and keeps reading', () =>
    Effect.gen(function* receiveLines() {
      const receiver = yield* claimHostedModuleCredentials([ORDER, PARTY]);
      const first = yield* encodeModuleCredentialHandover({ [ORDER]: Redacted.make(ORDER_KEY) }, [ORDER]);
      const later = yield* encodeModuleCredentialHandover(
        {
          [ORDER]: Redacted.make('replacement-order-module-key'),
          [PARTY]: Redacted.make('party-registry-module-key'),
          pricing: Redacted.make('pricing-module-key-00000'),
        },
        [ORDER, PARTY, 'pricing'],
      );
      yield* applyModuleCredentialHandovers(
        receiver,
        Stream.make(first, new TextEncoder().encode('not a handover\n'), later),
      );
      expect(yield* readOwnerCredential(ORDER)).toBe(ORDER_KEY);
      expect(yield* readOwnerCredential(PARTY)).toBe('party-registry-module-key');
      expect(yield* readOwnerCredential('pricing')).toBeUndefined();
    }),
  );
});

describe('supervised children', () => {
  it.effect('hands later messages to the live generation and restarts with a fresh channel on request', () =>
    Effect.scoped(
      Effect.gen(function* supervision() {
        const channels = yield* Ref.make<readonly HandoverChannel[]>([]);
        const child = yield* makeSupervisedChild(
          'probe',
          (channel) => Ref.update(channels, (all) => [...all, channel]).pipe(Effect.as(Effect.never)),
          new TextEncoder().encode('boot\n'),
        );
        yield* Effect.forkScoped(child.exit);
        yield* Effect.yieldNow;
        const [first] = yield* Ref.get(channels);
        expect(first === undefined ? undefined : decoder.decode(yield* Queue.take(first))).toBe('boot\n');
        yield* child.handOver(new TextEncoder().encode('late\n'));
        expect(first === undefined ? undefined : decoder.decode(yield* Queue.take(first))).toBe('late\n');
        yield* child.restartWith(new TextEncoder().encode('fresh\n'));
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        const generations = yield* Ref.get(channels);
        expect(generations).toHaveLength(2);
        const [, second] = generations;
        expect(second === undefined ? undefined : decoder.decode(yield* Queue.take(second))).toBe('fresh\n');
      }),
    ),
  );
});

describe('module credential healing', () => {
  const held = output({ [ORDER]: 'commerce-order-module-key-1' }, [PARTY]);

  it('reissues when a held key was revoked, fills callers without a key, and otherwise does nothing', () => {
    expect(planModuleCredentialHealing(held, new Set())).toEqual({ kind: 'reissue' });
    expect(planModuleCredentialHealing(held, new Set([ORDER_PROVIDER_KEY]))).toEqual({
      appIds: [PARTY],
      kind: 'fill',
    });
    expect(
      planModuleCredentialHealing(output({ [ORDER]: 'commerce-order-module-key-1' }), new Set([ORDER_PROVIDER_KEY])),
    ).toEqual({ kind: 'none' });
    expect(planModuleCredentialHealing(noProvisionedCredentials([ORDER]), new Set())).toEqual({
      appIds: [ORDER],
      kind: 'fill',
    });
  });

  const healing = (active: Effect.Effect<ReadonlySet<string>, string>, issued: ProvisioningOutput) =>
    Effect.gen(function* healOnce() {
      const state = yield* Ref.make(held);
      const issues: (readonly string[])[] = [];
      const messages: string[] = [];
      const holder = {
        handOver: (message: Uint8Array) => Effect.sync(() => messages.push(`handOver ${decoder.decode(message)}`)),
        restartWith: (message: Uint8Array) =>
          Effect.sync(() => messages.push(`restartWith ${decoder.decode(message)}`)),
      };
      const healthy = yield* healModuleCredentialsOnce({
        activeProviderKeyIds: active,
        callers: [ORDER, PARTY],
        held: state,
        holders: Effect.succeed([holder, holder]),
        issue: (appIds) => Effect.sync(() => issues.push(appIds)).pipe(Effect.as(issued)),
        serving: Effect.succeed(true),
      });
      return { healthy, held: yield* Ref.get(state), issues, messages };
    });

  it.effect('restarts every holder with fresh keys when its own keys were revoked', () =>
    Effect.gen(function* revoked() {
      const fresh = output({ [ORDER]: 'commerce-order-module-key-2', [PARTY]: 'party-registry-module-key-2' });
      const result = yield* healing(Effect.succeed(new Set()), fresh);
      expect(result.issues).toEqual([[ORDER, PARTY]]);
      expect(result.held).toEqual(fresh);
      expect(result.messages).toHaveLength(2);
      expect(result.messages.every((message) => message.startsWith('restartWith '))).toBe(true);
      expect(result.healthy).toBe(true);
    }),
  );

  it.effect('hands a late key to the holders of a caller left without one, without a restart', () =>
    Effect.gen(function* fill() {
      const filled = output({ [PARTY]: 'party-registry-module-key-1' });
      const result = yield* healing(Effect.succeed(new Set([ORDER_PROVIDER_KEY])), filled);
      expect(result.issues).toEqual([[PARTY]]);
      expect(Object.keys(result.held.credentials).toSorted()).toEqual([ORDER, PARTY]);
      expect(result.held.failedAppIds).toEqual([]);
      expect(result.messages.every((message) => message.startsWith('handOver '))).toBe(true);
      expect(result.messages[0]?.includes(ORDER)).toBe(false);
    }),
  );

  it.effect('treats an unreadable enrolment as no evidence and changes nothing', () =>
    Effect.gen(function* unreadable() {
      const result = yield* healing(Effect.fail('unreadable'), output({}));
      expect(result.issues).toEqual([]);
      expect(result.messages).toEqual([]);
      expect(result.held).toEqual(held);
    }),
  );

  it.effect('keeps backing off while a pass still leaves a caller without a key', () =>
    Effect.gen(function* stillFailing() {
      const result = yield* healing(Effect.succeed(new Set([ORDER_PROVIDER_KEY])), noProvisionedCredentials([PARTY]));
      expect(result.healthy).toBe(false);
      expect(result.messages).toEqual([]);
    }),
  );
});
