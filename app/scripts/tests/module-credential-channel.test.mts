import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Config, ConfigProvider, Effect, Fiber, Option, Queue, Redacted, Ref, Schema, Stream } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { claimHostedModuleCredentials } from '../../packages/core-runtime/src/auth/hosted-module-credential-store.ts';
import { moduleCredentialConfigProvider } from '../../packages/core-runtime/src/auth/owner-module-credential.ts';
import {
  captureChannel,
  healModuleCredentialsOnce,
  makeCredentialHolder,
  planModuleCredentialHealing,
  recordHostBoot,
  retireAfterHandoverWith,
} from '../zerops/app-host.mts';
import type { HandoverChannel } from '../zerops/app-host.mts';
import {
  applyModuleCredentialHandovers,
  encodeModuleCredentialHandover,
  noProvisionedCredentials,
  providerKeyIdsOf,
  ProvisioningOutputJsonSchema,
} from '../zerops/module-credentials.mts';
import type { ProvisioningOutput } from '../zerops/module-credentials.mts';

const ORDER = 'commerce-order';
const PARTY = 'party-registry';
const ORDER_PROVIDER_KEY = 'commerce-order-provider-key';
const ORDER_KEY = 'commerce-order-module-key';
const ORDER_KEY_ONE = 'commerce-order-module-key-1';
const ORDER_KEY_TWO = 'commerce-order-module-key-2';
const PARTY_KEY_ONE = 'party-registry-module-key-1';
const PARTY_KEY_TWO = 'party-registry-module-key-2';
const GENERATION_TWO = '-2';
const HANDOVER_LOOKALIKE = '{"schemaVersion":1,"credentials":{}}';
const decoder = new TextDecoder();

/** What one owner of this process reads as its module credential, per call. */
const readOwnerCredential = (appId: string) =>
  Config.option(Config.String('ONTOS_GATEWAY_MODULE_API_KEY'))
    .parse(moduleCredentialConfigProvider(ConfigProvider.fromUnknown({}), appId))
    .pipe(Effect.map(Option.getOrUndefined));

/** Keys issued at the test clock's start live a day, as the platform issues them. */
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const output = (
  credentials: Readonly<Record<string, string>>,
  failedAppIds: readonly string[] = [],
  generation = '',
  expiresAt = DAY,
) =>
  Schema.decodeUnknownSync(ProvisioningOutputJsonSchema)(
    JSON.stringify({
      credentials,
      failedAppIds,
      keys: Object.fromEntries(
        Object.keys(credentials).map((appId) => [
          appId,
          { expiresAt: new Date(expiresAt).toISOString(), providerKeyId: `${appId}-provider-key${generation}` },
        ]),
      ),
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
            keys: { [ORDER]: { expiresAt: '2026-11-12T10:00:00.000Z', providerKeyId: 'order-provider-key' } },
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
          expect(providerKeyIdsOf(decoded)).toEqual(['order-provider-key']);
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
  it.effect(
    'gives each served owner the key of the latest handover, refuses malformed lines and strangers, and keeps reading',
    () =>
      Effect.gen(function* receiveLines() {
        const receiver = yield* claimHostedModuleCredentials([ORDER, PARTY]);
        const first = yield* encodeModuleCredentialHandover({ [ORDER]: Redacted.make(ORDER_KEY) }, [ORDER]);
        const rotated = yield* encodeModuleCredentialHandover(
          {
            [ORDER]: Redacted.make('rotated-order-module-key'),
            [PARTY]: Redacted.make('party-registry-module-key'),
            pricing: Redacted.make('pricing-module-key-00000'),
          },
          [ORDER, PARTY, 'pricing'],
        );
        yield* applyModuleCredentialHandovers(receiver, Stream.make(first));
        expect(yield* readOwnerCredential(ORDER)).toBe(ORDER_KEY);
        yield* applyModuleCredentialHandovers(
          receiver,
          Stream.make(new TextEncoder().encode('not a handover\n'), rotated),
        );
        // A rotation replaces the key the owner held, in the running process: no restart.
        expect(yield* readOwnerCredential(ORDER)).toBe('rotated-order-module-key');
        expect(yield* readOwnerCredential(PARTY)).toBe('party-registry-module-key');
        expect(yield* readOwnerCredential('pricing')).toBeUndefined();
      }),
  );
});

describe('credential holders', () => {
  it.effect('hand the first and every later message to the one running process, which is never restarted', () =>
    Effect.scoped(
      Effect.gen(function* holding() {
        const channels = yield* Ref.make<readonly HandoverChannel[]>([]);
        const holder = yield* makeCredentialHolder(
          (channel: HandoverChannel) => Ref.update(channels, (all) => [...all, channel]).pipe(Effect.as(Effect.never)),
          new TextEncoder().encode('boot\n'),
        );
        yield* Effect.forkScoped(holder.exit);
        yield* Effect.yieldNow;
        yield* holder.handOver(new TextEncoder().encode('rotated\n'));
        const started = yield* Ref.get(channels);
        expect(started).toHaveLength(1);
        const [channel] = started;
        expect(
          channel === undefined
            ? []
            : [decoder.decode(yield* Queue.take(channel)), decoder.decode(yield* Queue.take(channel))],
        ).toEqual(['boot\n', 'rotated\n']);
      }),
    ),
  );
});

describe('module credential healing', () => {
  const held = output({ [ORDER]: ORDER_KEY_ONE }, [PARTY]);

  it('renews when a held key was revoked or its keys near their end, fills callers without a key, and otherwise does nothing', () => {
    expect(planModuleCredentialHealing(held, new Set(), 0)).toEqual({ kind: 'renew', reason: 'revoked' });
    expect(planModuleCredentialHealing(held, new Set([ORDER_PROVIDER_KEY]), 0)).toEqual({
      appIds: [PARTY],
      kind: 'fill',
    });
    const whole = output({ [ORDER]: ORDER_KEY_ONE });
    expect(planModuleCredentialHealing(whole, new Set([ORDER_PROVIDER_KEY]), 15 * HOUR)).toEqual({ kind: 'none' });
    // Eight hours before a 24-hour key ends it is rotated, whatever else the host holds.
    expect(planModuleCredentialHealing(whole, new Set([ORDER_PROVIDER_KEY]), 16 * HOUR)).toEqual({
      kind: 'renew',
      reason: 'expiring',
    });
    expect(planModuleCredentialHealing(noProvisionedCredentials([ORDER]), new Set(), 0)).toEqual({
      appIds: [ORDER],
      kind: 'fill',
    });
  });

  const healing = (
    active: Effect.Effect<ReadonlySet<string>, string>,
    issued: ProvisioningOutput,
    start: ProvisioningOutput = held,
    nowMillis = 0,
  ) =>
    Effect.gen(function* healOnce() {
      yield* TestClock.setTime(nowMillis);
      const state = yield* Ref.make(start);
      const issues: (readonly string[])[] = [];
      const messages: string[] = [];
      const retirements: (readonly string[])[] = [];
      const holder = {
        handOver: (message: Uint8Array) => Effect.sync(() => messages.push(decoder.decode(message))),
      };
      const healthy = yield* healModuleCredentialsOnce({
        activeProviderKeyIds: active,
        callers: [ORDER, PARTY],
        held: state,
        holders: Effect.succeed([holder, holder]),
        issue: (appIds) => Effect.sync(() => issues.push(appIds)).pipe(Effect.as(issued)),
        retireOwn: (keep) => Effect.sync(() => retirements.push(keep)),
        serving: Effect.succeed(true),
      });
      return { healthy, held: yield* Ref.get(state), issues, messages, retirements };
    });

  it.effect('hands fresh keys to every holder when its own keys were revoked, then retires what they replaced', () =>
    Effect.gen(function* revoked() {
      const fresh = output({ [ORDER]: ORDER_KEY_TWO, [PARTY]: PARTY_KEY_TWO }, [], GENERATION_TWO);
      const result = yield* healing(Effect.succeed(new Set()), fresh);
      expect(result.issues).toEqual([[ORDER, PARTY]]);
      expect(result.held).toEqual(fresh);
      // Each holder gets one handover line with both fresh keys; nothing restarts.
      expect(result.messages).toHaveLength(2);
      expect(result.messages.every((message) => message.includes(PARTY_KEY_TWO))).toBe(true);
      // Exactly the key it replaced; the caller that held none replaced nothing.
      expect(result.retirements).toEqual([[ORDER_PROVIDER_KEY]]);
      expect(result.healthy).toBe(true);
    }),
  );

  it.effect('rotates keys before they end: hands the rotated keys over in place and retires the old ones', () =>
    Effect.gen(function* rotation() {
      const current = output({ [ORDER]: ORDER_KEY_ONE, [PARTY]: PARTY_KEY_ONE });
      const live = new Set(providerKeyIdsOf(current));
      const rotated = output({ [ORDER]: ORDER_KEY_TWO, [PARTY]: PARTY_KEY_TWO }, [], GENERATION_TWO, 40 * HOUR);
      const early = yield* healing(Effect.succeed(live), rotated, current, 10 * HOUR);
      expect(early.issues).toEqual([]);
      const late = yield* healing(Effect.succeed(live), rotated, current, 17 * HOUR);
      expect(late.issues).toEqual([[ORDER, PARTY]]);
      expect(late.held).toEqual(rotated);
      expect(late.messages.every((message) => message.includes(ORDER_KEY_TWO))).toBe(true);
      expect(late.retirements).toEqual([providerKeyIdsOf(current)]);
      expect(late.healthy).toBe(true);
    }),
  );

  it.effect('keeps a key it could not rotate in use until it ends, and retires only what was replaced', () =>
    Effect.gen(function* partialRotation() {
      const current = output({ [ORDER]: ORDER_KEY_ONE, [PARTY]: PARTY_KEY_ONE });
      const live = new Set(providerKeyIdsOf(current));
      const partial = output({ [PARTY]: PARTY_KEY_TWO }, [ORDER], GENERATION_TWO, 40 * HOUR);
      const result = yield* healing(Effect.succeed(live), partial, current, 17 * HOUR);
      expect(result.held.failedAppIds).toEqual([]);
      expect(result.held.keys[ORDER]?.providerKeyId).toBe(ORDER_PROVIDER_KEY);
      expect(result.messages.every((message) => !message.includes(ORDER))).toBe(true);
      // Only the key that was replaced: the order key it could not rotate stays in use and is not retired.
      expect(result.retirements).toEqual([[`${PARTY}-provider-key`]]);
      expect(result.healthy).toBe(false);
      const nothing = yield* healing(
        Effect.succeed(live),
        noProvisionedCredentials([ORDER, PARTY]),
        current,
        17 * HOUR,
      );
      expect(nothing.held).toEqual(current);
      expect(nothing.messages).toEqual([]);
      expect(nothing.retirements).toEqual([]);
    }),
  );

  it.effect('hands a late key to the holders of a caller left without one, and retires nothing', () =>
    Effect.gen(function* fill() {
      const filled = output({ [PARTY]: PARTY_KEY_ONE });
      const result = yield* healing(Effect.succeed(new Set([ORDER_PROVIDER_KEY])), filled);
      expect(result.issues).toEqual([[PARTY]]);
      expect(Object.keys(result.held.credentials).toSorted()).toEqual([ORDER, PARTY]);
      expect(result.held.failedAppIds).toEqual([]);
      expect(result.messages[0]?.includes(ORDER)).toBe(false);
      expect(result.retirements).toEqual([]);
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

const boot = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

describe("a container's record of its host boots", () => {
  it.live('names only the ended boots this container recorded, never another container’s', () =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(path.join(tmpdir(), 'module-credential-boots-'))),
      (directory) =>
        Effect.gen(function* bootRecord() {
          const file = path.join(directory, 'state', 'boots.json');
          // A new container (every deploy) has no record: it names no earlier boot.
          expect(yield* recordHostBoot(file, boot(1))).toEqual([]);
          expect(yield* recordHostBoot(file, boot(2))).toEqual([boot(1)]);
          expect(yield* recordHostBoot(file, boot(3))).toEqual([boot(1), boot(2)]);
          // Another container's record is its own file: it never sees these boots.
          expect(yield* recordHostBoot(path.join(directory, 'other', 'boots.json'), boot(9))).toEqual([]);
          // The record stays bounded.
          for (let index = 4; index <= 30; index += 1) {
            yield* recordHostBoot(file, boot(index));
          }
          expect(yield* recordHostBoot(file, boot(31))).toHaveLength(20);
          // A record that cannot be read names nothing, so nothing unproven is retired.
          writeFileSync(file, 'not a record');
          expect(yield* recordHostBoot(file, boot(32))).toEqual([]);
        }),
      (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

const BOOT_ORDER_KEY = 'boot-order-key';

describe('retirement after a handover', () => {
  it.effect('keeps every key the host holds when the superseded retirement runs, not only those of the boot pass', () =>
    Effect.gen(function* lateKeepList() {
      const held = yield* Ref.make<readonly string[]>([BOOT_ORDER_KEY]);
      const runs: (readonly [string, readonly string[]])[] = [];
      const run = (pass: 'retire' | 'retire-own', retiring: { readonly providerKeyIds: readonly string[] }) =>
        Effect.sync(() => runs.push([pass, retiring.providerKeyIds]));
      const retirement = yield* Effect.forkChild(
        retireAfterHandoverWith(run)({
          compositionRevision: 'a'.repeat(64),
          current: Ref.get(held),
          earlierBoots: [],
          replaced: [],
          shellEnvironment: {},
          superseded: true,
        }),
      );
      // A fill issues a key for a caller the boot pass missed, during the grace period.
      yield* TestClock.adjust('1 minute');
      yield* Ref.set(held, [BOOT_ORDER_KEY, 'filled-party-key']);
      yield* TestClock.adjust('1 minute');
      yield* Fiber.join(retirement);
      expect(runs).toEqual([['retire', [BOOT_ORDER_KEY, 'filled-party-key']]]);
    }),
  );
});
