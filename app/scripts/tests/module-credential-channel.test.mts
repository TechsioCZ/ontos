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
  AppHostError,
  captureChannel,
  healModuleCredentialsOnce,
  makeCredentialHolder,
  makeReplacedKeyLedger,
  planModuleCredentialHealing,
  provisionModuleCredentialsForReleaseWith,
  recordHostBoot,
  retireAfterHandoverWith,
} from '../zerops/app-host.mts';
import type { HandoverChannel, ModuleCredentialHealingStreaks } from '../zerops/app-host.mts';
import {
  applyModuleCredentialHandovers,
  encodeModuleCredentialHandover,
  noProvisionedCredentials,
  providerKeyIdsOf,
  ProvisioningOutputJsonSchema,
  watchModuleCredentialChannel,
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

describe('a process watching its channel', () => {
  it.effect('leaves when the channel can no longer be read, and not for a malformed line or a closed channel', () =>
    Effect.gen(function* watching() {
      // This process already claimed its store in another test; a receiver that counts what it is handed stands in.
      const accepted: string[] = [];
      const receiver = {
        accept: (handover: { readonly credentials: Readonly<Record<string, Redacted.Redacted>> }) =>
          Effect.sync(() => {
            accepted.push(...Object.keys(handover.credentials));
            return { accepted: Object.keys(handover.credentials), refused: [] };
          }),
        owners: [ORDER],
      };
      const lost: string[] = [];
      const leave = (reason: string) => Effect.sync(() => lost.push(reason));
      const line = yield* encodeModuleCredentialHandover({ [ORDER]: Redacted.make(ORDER_KEY) }, [ORDER]);
      // Read once and closed (the local demo's Outbox pipe), with a malformed line on the way: the process stays.
      yield* watchModuleCredentialChannel(
        receiver,
        Stream.make(new TextEncoder().encode('not a handover\n'), line),
        leave,
      );
      expect(lost).toEqual([]);
      // A channel that fails while the host still hands keys over: the process leaves rather than go stale.
      yield* watchModuleCredentialChannel(
        receiver,
        Stream.concat(Stream.make(line), Stream.fail('unreadable descriptor')),
        leave,
      );
      expect(lost).toEqual(['the handover channel could not be read']);
      expect(accepted).toEqual([ORDER, ORDER]);
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
    expect(planModuleCredentialHealing(held, Option.some(new Set()), 0)).toEqual({ kind: 'renew', reason: 'revoked' });
    expect(planModuleCredentialHealing(held, Option.some(new Set([ORDER_PROVIDER_KEY])), 0)).toEqual({
      appIds: [PARTY],
      kind: 'fill',
    });
    const whole = output({ [ORDER]: ORDER_KEY_ONE });
    expect(planModuleCredentialHealing(whole, Option.some(new Set([ORDER_PROVIDER_KEY])), 15 * HOUR)).toEqual({
      kind: 'none',
    });
    // Eight hours before a 24-hour key ends it is rotated, whatever else the host holds.
    expect(planModuleCredentialHealing(whole, Option.some(new Set([ORDER_PROVIDER_KEY])), 16 * HOUR)).toEqual({
      kind: 'renew',
      reason: 'expiring',
    });
    expect(planModuleCredentialHealing(noProvisionedCredentials([ORDER]), Option.some(new Set()), 0)).toEqual({
      appIds: [ORDER],
      kind: 'fill',
    });
    // Without a liveness read nothing is filled or renewed for a revocation, but rotation by end of life still is:
    // the ends are held locally.
    expect(planModuleCredentialHealing(whole, Option.none(), 15 * HOUR)).toEqual({ kind: 'none' });
    expect(planModuleCredentialHealing(held, Option.none(), 0)).toEqual({ kind: 'none' });
    expect(planModuleCredentialHealing(whole, Option.none(), 16 * HOUR)).toEqual({ kind: 'renew', reason: 'expiring' });
  });

  const healing = (
    active: Effect.Effect<ReadonlySet<string>, string>,
    issued: ProvisioningOutput,
    start: ProvisioningOutput = held,
    nowMillis = 0,
    streaks: Ref.Ref<ModuleCredentialHealingStreaks> = Ref.makeUnsafe({ revocations: 0, unreadable: 0 }),
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
      const healthy = yield* healModuleCredentialsOnce(
        {
          activeProviderKeyIds: active,
          callers: [ORDER, PARTY],
          held: state,
          holders: Effect.succeed([holder, holder]),
          issue: (appIds) => Effect.sync(() => issues.push(appIds)).pipe(Effect.as(issued)),
          retireOwn: (keep) => Effect.sync(() => retirements.push(keep)),
          serving: Effect.succeed(true),
        },
        streaks,
      );
      return { healthy, held: yield* Ref.get(state), issues, messages, retirements, streaks: yield* Ref.get(streaks) };
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
      // A revocation renewal backs off like a failure, so a store that keeps saying "not live" is not hit every minute.
      expect(result.healthy).toBe(false);
      expect(result.streaks.revocations).toBe(1);
      const streaks = Ref.makeUnsafe<ModuleCredentialHealingStreaks>({ revocations: 2, unreadable: 0 });
      const again = yield* healing(Effect.succeed(new Set()), fresh, held, 0, streaks);
      expect(again.healthy).toBe(false);
      expect(again.streaks.revocations).toBe(3);
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

  it.effect('treats an unreadable enrolment as no evidence of a revocation and changes nothing else', () =>
    Effect.gen(function* unreadable() {
      const result = yield* healing(Effect.fail('unreadable'), output({}));
      expect(result.issues).toEqual([]);
      expect(result.messages).toEqual([]);
      expect(result.held).toEqual(held);
      expect(result.streaks.unreadable).toBe(1);
    }),
  );

  it.effect('still rotates keys before they end while liveness stays unreadable', () =>
    Effect.gen(function* rotationWithoutRead() {
      const current = output({ [ORDER]: ORDER_KEY_ONE, [PARTY]: PARTY_KEY_ONE });
      const rotated = output({ [ORDER]: ORDER_KEY_TWO, [PARTY]: PARTY_KEY_TWO }, [], GENERATION_TWO, 40 * HOUR);
      const streaks = Ref.makeUnsafe<ModuleCredentialHealingStreaks>({ revocations: 0, unreadable: 3 });
      const result = yield* healing(Effect.fail('unreadable'), rotated, current, 17 * HOUR, streaks);
      expect(result.issues).toEqual([[ORDER, PARTY]]);
      expect(result.held).toEqual(rotated);
      expect(result.retirements).toEqual([providerKeyIdsOf(current)]);
      expect(result.streaks.unreadable).toBe(4);
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
const RENEWED_ORDER_KEY = 'renewed-order-key';

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

  it.effect('never retires a key a renewal replaced less than the grace period ago', () =>
    Effect.gen(function* renewalDuringGrace() {
      const held = yield* Ref.make<readonly string[]>([BOOT_ORDER_KEY]);
      const ledger = yield* makeReplacedKeyLedger;
      const runs: (readonly [string, readonly string[]])[] = [];
      const run = (pass: 'retire' | 'retire-own', retiring: { readonly providerKeyIds: readonly string[] }) =>
        Effect.sync(() => runs.push([pass, retiring.providerKeyIds]));
      const retirement = yield* Effect.forkChild(
        retireAfterHandoverWith(run)({
          compositionRevision: 'a'.repeat(64),
          current: ledger.keptWith(Ref.get(held)),
          earlierBoots: [],
          replaced: [],
          shellEnvironment: {},
          superseded: true,
        }),
      );
      // A minute and a half after publishing a revocation renewal replaces the boot key and hands over a fresh one.
      yield* TestClock.adjust('90 seconds');
      yield* ledger.record([BOOT_ORDER_KEY]);
      yield* Ref.set(held, [RENEWED_ORDER_KEY]);
      yield* TestClock.adjust('30 seconds');
      yield* Fiber.join(retirement);
      // The superseded retirement keeps the replaced key: its own renewal retires it two minutes after its hand-over.
      expect(runs).toEqual([['retire', [RENEWED_ORDER_KEY, BOOT_ORDER_KEY]]]);
      // Once that grace has passed, it is no longer kept.
      yield* TestClock.adjust('2 minutes');
      expect(yield* ledger.keptWith(Ref.get(held))).toEqual([RENEWED_ORDER_KEY]);
    }),
  );

  it.effect('still retires the superseded keys when the boot pass issued nothing', () =>
    Effect.gen(function* nothingIssued() {
      const runs: (readonly [string, readonly string[]])[] = [];
      const run = (pass: 'retire' | 'retire-own', retiring: { readonly providerKeyIds: readonly string[] }) =>
        Effect.sync(() => runs.push([pass, retiring.providerKeyIds]));
      const retirement = yield* Effect.forkChild(
        retireAfterHandoverWith(run)({
          compositionRevision: 'a'.repeat(64),
          current: Effect.succeed([]),
          earlierBoots: [],
          replaced: [],
          shellEnvironment: {},
          superseded: true,
        }),
      );
      yield* TestClock.adjust('2 minutes');
      yield* Fiber.join(retirement);
      expect(runs).toEqual([['retire', []]]);
    }),
  );
});

describe('the boot provisioning pass', () => {
  it.effect('makes one bounded attempt and never retries before publishing; healing retries later', () =>
    Effect.gen(function* oneAttempt() {
      const attempts: string[] = [];
      const capture = (name: string) =>
        Effect.sync(() => attempts.push(name)).pipe(Effect.andThen(Effect.fail(new AppHostError({ reason: name }))));
      const pass = yield* Effect.forkChild(
        provisionModuleCredentialsForReleaseWith(capture)({
          appIds: [ORDER],
          operationId: 'boot-pass',
          release: { buildMarkers: { [ORDER]: 'order-build' }, compositionRevision: 'a'.repeat(64) },
          shellEnvironment: {},
        }),
      );
      // However long the clock runs on, the pass made exactly one attempt and left the caller without a key.
      yield* TestClock.adjust('10 minutes');
      expect(yield* Fiber.join(pass)).toEqual(noProvisionedCredentials([ORDER]));
      expect(attempts).toEqual(['module-credentials']);
    }),
  );
});
