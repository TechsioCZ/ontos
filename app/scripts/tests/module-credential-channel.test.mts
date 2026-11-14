import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, Exit, Fiber, Option, Queue, Redacted, Ref, Schema, Stream } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { claimHostedModuleCredentials } from '../../packages/core-runtime/src/auth/hosted-module-credential-store.ts';
import { HostedModuleCredentialsSchema } from '../../packages/core-runtime/src/auth/hosted-module-credentials.ts';
import {
  ownModuleCredential,
  ownWorkloadCredential,
} from '../../packages/core-runtime/src/auth/owner-module-credential.ts';
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
  workloadKeysDiffer,
} from '../zerops/app-host.mts';
import type { HandoverChannel, ModuleCredentialHealingStreaks } from '../zerops/app-host.mts';
import {
  applyModuleCredentialHandovers,
  encodeModuleCredentialHandover,
  makeHostedCredentialHolders,
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
const TENANT = '70000000-0000-4000-8000-000000000001';
const COMPANY = '70000000-0000-4000-8000-000000000021';
const OTHER_COMPANY = '70000000-0000-4000-8000-000000000022';
/** An internal workload of the order module, registered in two companies of one tenant: one key each. */
const ORDER_WORKLOAD = { appId: ORDER, tenantId: TENANT, workloadKey: 'demo.order.intake' };
const ORDER_WORKLOAD_ENTRY = `${ORDER}/demo.order.intake/${TENANT}/${COMPANY}`;
const ORDER_WORKLOAD_ELSEWHERE = `${ORDER}/demo.order.intake/${TENANT}/${OTHER_COMPANY}`;
const WORKLOAD_KEY_ONE = 'order-intake-workload-key-1';
const WORKLOAD_KEY_TWO = 'order-intake-workload-key-2';
const WORKLOAD_KEY_ELSEWHERE = 'order-intake-workload-key-x';
const PRICING_WORKLOAD_ENTRY = `pricing/demo.pricing.sync/${TENANT}/${COMPANY}`;
const PRICING_WORKLOAD_KEY = 'pricing-sync-workload-key';

/** What the order module reads as its intake workload key in one company of the tenant: exactly that entry. */
const readWorkload = (legalEntityId: string) =>
  ownWorkloadCredential({ ...ORDER_WORKLOAD, legalEntityId }).pipe(
    Effect.map((key) => (Option.isSome(key) ? Redacted.value(key.value) : undefined)),
  );
const decoder = new TextDecoder();

/** What one owner of this process reads as its module credential, per call. */
const readOwnerCredential = (appId: string) =>
  ownModuleCredential(appId).pipe(Effect.map((key) => (Option.isSome(key) ? Redacted.value(key.value) : undefined)));

/** Keys issued at the test clock's start live a day, as the platform issues them. */
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const output = (
  credentials: Readonly<Record<string, string>>,
  failedAppIds: readonly string[] = [],
  generation = '',
  expiresAt = DAY,
  workloadCredentials: Readonly<Record<string, string>> = {},
) =>
  Schema.decodeUnknownSync(ProvisioningOutputJsonSchema)(
    JSON.stringify({
      credentials,
      failedAppIds,
      keys: Object.fromEntries(
        [...Object.keys(credentials), ...Object.keys(workloadCredentials)].map((entry) => [
          entry,
          { expiresAt: new Date(expiresAt).toISOString(), providerKeyId: `${entry}-provider-key${generation}` },
        ]),
      ),
      schemaVersion: 1,
      workloadCredentials,
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
            workloadCredentials: {},
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
      expect(Exit.isFailure(exit)).toBe(true);
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

        // An owner's internal workload key, per tenant and company: read from its slot, never from the environment.
        expect(yield* readWorkload(COMPANY)).toBeUndefined();
        const withWorkloads = yield* encodeModuleCredentialHandover({ [ORDER]: Redacted.make(ORDER_KEY) }, [ORDER], {
          [ORDER_WORKLOAD_ELSEWHERE]: Redacted.make(WORKLOAD_KEY_ELSEWHERE),
          [ORDER_WORKLOAD_ENTRY]: Redacted.make(WORKLOAD_KEY_ONE),
          // Another module's workload is never handed to an owner that does not serve it.
          [PRICING_WORKLOAD_ENTRY]: Redacted.make(PRICING_WORKLOAD_KEY),
        });
        expect(decoder.decode(withWorkloads)).not.toContain(PRICING_WORKLOAD_KEY);
        yield* applyModuleCredentialHandovers(receiver, Stream.make(withWorkloads));
        expect(yield* readWorkload(COMPANY)).toBe(WORKLOAD_KEY_ONE);
        expect(yield* readWorkload(OTHER_COMPANY)).toBe(WORKLOAD_KEY_ELSEWHERE);
        expect(yield* readWorkload('70000000-0000-4000-8000-000000000023')).toBeUndefined();
        // A rotation hands the workload a new key in the running process; a company whose registration ended is dropped.
        const rotatedWorkload = yield* encodeModuleCredentialHandover(
          { [ORDER]: Redacted.make(ORDER_KEY_TWO) },
          [ORDER],
          { [ORDER_WORKLOAD_ENTRY]: Redacted.make(WORKLOAD_KEY_TWO) },
        );
        yield* applyModuleCredentialHandovers(receiver, Stream.make(rotatedWorkload));
        expect(yield* readWorkload(COMPANY)).toBe(WORKLOAD_KEY_TWO);
        expect(yield* readWorkload(OTHER_COMPANY)).toBeUndefined();
        // A handover that names only another owner leaves this owner's workload keys as they are.
        yield* applyModuleCredentialHandovers(
          receiver,
          Stream.make(yield* encodeModuleCredentialHandover({ [PARTY]: Redacted.make(PARTY_KEY_TWO) }, [PARTY])),
        );
        expect(yield* readWorkload(COMPANY)).toBe(WORKLOAD_KEY_TWO);
        const stranger = yield* receiver.accept(
          Schema.decodeUnknownSync(HostedModuleCredentialsSchema)({
            credentials: {},
            schemaVersion: 1,
            workloads: { [PRICING_WORKLOAD_ENTRY]: PRICING_WORKLOAD_KEY },
          }),
        );
        expect(stranger).toEqual({ accepted: [], refused: [PRICING_WORKLOAD_ENTRY] });
      }),
  );
});

/**
 * A store copy as one built bundle carries it. It records exactly what the host hands it, and keeps its own second
 * lock: it takes only its own modules' keys.
 */
const bundleCopy = (owners: readonly string[]) => {
  const held = new Map<string, string>();
  const workloads = new Map<string, string>();
  const handed: (readonly string[])[] = [];
  return {
    copy: {
      accept: (handover: typeof HostedModuleCredentialsSchema.Type) =>
        Effect.sync(() => {
          handed.push([...Object.keys(handover.credentials), ...Object.keys(handover.workloads ?? {})].toSorted());
          const named = Object.keys(handover.credentials).filter((owner) => owners.includes(owner));
          for (const owner of named) {
            const key = handover.credentials[owner];
            if (key !== undefined) {
              held.set(owner, Redacted.value(key));
            }
          }
          for (const [entry, key] of Object.entries(handover.workloads ?? {})) {
            if (owners.some((owner) => entry.startsWith(`${owner}/`))) {
              workloads.set(entry, Redacted.value(key));
            }
          }
          return {
            accepted: named,
            refused: Object.keys(handover.credentials).filter((owner) => !owners.includes(owner)),
          };
        }),
      owners,
    },
    handed,
    held,
    workloads,
  };
};

const handoverLine = (
  credentials: Readonly<Record<string, string>>,
  workloads: Readonly<Record<string, string>> = {},
) => Schema.decodeUnknownSync(HostedModuleCredentialsSchema)({ credentials, schemaVersion: 1, workloads });

describe('a process holding one store copy per loaded bundle', () => {
  it.effect('hands each copy only its own module entries, on boot issue, rotation and late fill', () =>
    Effect.gen(function* everyCopy() {
      const { holders, receiver } = yield* makeHostedCredentialHolders([ORDER, PARTY]);
      const order = bundleCopy([ORDER]);
      yield* holders.hold(order.copy, [ORDER]);
      // Boot issue: every caller's key, a workload key of the order module, and a stranger's key.
      const first = yield* receiver.accept(
        handoverLine(
          { [ORDER]: ORDER_KEY_ONE, [PARTY]: PARTY_KEY_ONE, pricing: 'pricing-module-key-00000' },
          { [ORDER_WORKLOAD_ENTRY]: WORKLOAD_KEY_ONE },
        ),
      );
      expect(first.accepted.toSorted()).toEqual([ORDER, ORDER_WORKLOAD_ENTRY, PARTY].toSorted());
      expect(first.refused).toEqual(['pricing']);
      // The order copy was handed its own key and workload key, nothing of the party module or the stranger.
      expect(order.handed).toEqual([[ORDER, ORDER_WORKLOAD_ENTRY].toSorted()]);
      expect([...order.workloads]).toEqual([[ORDER_WORKLOAD_ENTRY, WORKLOAD_KEY_ONE]]);
      // Late fill: a bundle loaded after the line arrived gets only its module's current key.
      const party = bundleCopy([PARTY]);
      yield* holders.hold(party.copy, [PARTY]);
      expect(party.handed).toEqual([[PARTY]]);
      // Rotation: each copy in place, each only its own entries; a line naming only one module reaches only its copy.
      yield* receiver.accept(handoverLine({ [ORDER]: ORDER_KEY_TWO, [PARTY]: PARTY_KEY_TWO }));
      yield* receiver.accept(handoverLine({ [PARTY]: 'party-registry-module-key-3' }));
      expect(order.handed.slice(1)).toEqual([[ORDER]]);
      expect(party.handed.slice(1)).toEqual([[PARTY], [PARTY]]);
      expect(order.held.get(ORDER)).toBe(ORDER_KEY_TWO);
      expect(party.held.get(PARTY)).toBe('party-registry-module-key-3');
      // A copy loaded after the rotation gets the rotated key, and no longer the workload its module was not handed.
      const lateOrder = bundleCopy([ORDER]);
      yield* holders.hold(lateOrder.copy, [ORDER]);
      expect(lateOrder.held.get(ORDER)).toBe(ORDER_KEY_TWO);
      expect([...lateOrder.workloads]).toEqual([]);
    }),
  );

  it.effect(
    'refuses a copy whose claim names other modules than the one it was loaded for, and gives nothing early',
    () =>
      Effect.gen(function* refusedCopy() {
        const { holders, receiver } = yield* makeHostedCredentialHolders([ORDER, PARTY]);
        yield* receiver.accept(handoverLine({ [ORDER]: ORDER_KEY_ONE, [PARTY]: PARTY_KEY_ONE }));
        const greedy = bundleCopy([ORDER, PARTY]);
        expect(Exit.isFailure(yield* Effect.exit(holders.hold(greedy.copy, [ORDER])))).toBe(true);
        const other = bundleCopy([PARTY]);
        expect(Exit.isFailure(yield* Effect.exit(holders.hold(other.copy, [ORDER])))).toBe(true);
        expect([...greedy.handed, ...other.handed]).toEqual([]);
        const { holders: quiet } = yield* makeHostedCredentialHolders([ORDER]);
        const order = bundleCopy([ORDER]);
        yield* quiet.hold(order.copy, [ORDER]);
        expect(order.handed).toEqual([]);
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
      // Launched by the app host, whose channel lives as long as it does: its end means the host is gone.
      yield* watchModuleCredentialChannel(receiver, Stream.make(line), leave, 'lives-with-launcher');
      expect(lost).toEqual([
        'the handover channel could not be read',
        'the host closed the handover channel; it has ended',
      ]);
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
    renewal: Ref.Ref<boolean> = Ref.makeUnsafe(false),
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
          renewal,
          retireOwn: (keep) => Effect.sync(() => retirements.push(keep)),
          serving: Effect.succeed(true),
        },
        streaks,
      );
      return { healthy, held: yield* Ref.get(state), issues, messages, retirements, streaks: yield* Ref.get(streaks) };
    });

  it.effect('renews every caller once when the internal workload registrations changed, keys live or not', () =>
    Effect.gen(function* registrationsChanged() {
      const current = output({ [ORDER]: ORDER_KEY_ONE, [PARTY]: PARTY_KEY_ONE });
      const live = new Set(providerKeyIdsOf(current));
      const fresh = output({ [ORDER]: ORDER_KEY_TWO, [PARTY]: PARTY_KEY_TWO }, [], GENERATION_TWO, 40 * HOUR, {
        [ORDER_WORKLOAD_ENTRY]: WORKLOAD_KEY_ONE,
      });
      const renewal = Ref.makeUnsafe(true);
      const result = yield* healing(Effect.succeed(live), fresh, current, HOUR, undefined, renewal);
      expect(result.issues).toEqual([[ORDER, PARTY]]);
      expect(result.messages.every((message) => message.includes(WORKLOAD_KEY_ONE))).toBe(true);
      expect(result.retirements).toEqual([providerKeyIdsOf(current)]);
      expect(yield* Ref.get(renewal)).toBe(false);
      // Asked once: the next step, with nothing new, renews nothing.
      const quiet = yield* healing(
        Effect.succeed(new Set(providerKeyIdsOf(fresh))),
        fresh,
        fresh,
        HOUR,
        undefined,
        renewal,
      );
      expect(quiet.issues).toEqual([]);
    }),
  );

  it('compares the registrations with the workload keys held, company by company', () => {
    const holding = output({ [ORDER]: ORDER_KEY_ONE }, [], '', DAY, { [ORDER_WORKLOAD_ENTRY]: WORKLOAD_KEY_ONE });
    const registration = { appId: ORDER, legalEntityId: COMPANY, tenantId: TENANT, workloadKey: 'demo.order.intake' };
    expect(workloadKeysDiffer(holding, [registration])).toBe(false);
    expect(workloadKeysDiffer(holding, [registration, { ...registration, legalEntityId: OTHER_COMPANY }])).toBe(true);
    expect(workloadKeysDiffer(holding, [])).toBe(true);
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

  it.effect('rotates workload keys with their module and retires the key of a workload no longer registered', () =>
    Effect.gen(function* workloadRotation() {
      const current = output({ [ORDER]: ORDER_KEY_ONE, [PARTY]: PARTY_KEY_ONE }, [], '', DAY, {
        [ORDER_WORKLOAD_ELSEWHERE]: WORKLOAD_KEY_ELSEWHERE,
        [ORDER_WORKLOAD_ENTRY]: WORKLOAD_KEY_ONE,
      });
      const live = new Set(providerKeyIdsOf(current));
      // The operator ended the registration in the other tenant: the renewal issues the one still registered.
      const rotated = output({ [ORDER]: ORDER_KEY_TWO, [PARTY]: PARTY_KEY_TWO }, [], GENERATION_TWO, 40 * HOUR, {
        [ORDER_WORKLOAD_ENTRY]: WORKLOAD_KEY_TWO,
      });
      const result = yield* healing(Effect.succeed(live), rotated, current, 17 * HOUR);
      expect(result.held).toEqual(rotated);
      expect(result.messages.every((message) => message.includes(WORKLOAD_KEY_TWO))).toBe(true);
      expect(result.messages.some((message) => message.includes(WORKLOAD_KEY_ELSEWHERE))).toBe(false);
      expect(result.retirements).toEqual([providerKeyIdsOf(current)]);
      // Nothing left behind ends, so the next step renews nothing.
      expect(
        planModuleCredentialHealing(result.held, Option.some(new Set(providerKeyIdsOf(rotated))), 17 * HOUR),
      ).toEqual({
        kind: 'none',
      });
      // A pass that could not issue the order module's workload keys keeps the ones it holds in use.
      const partial = output({ [ORDER]: ORDER_KEY_TWO, [PARTY]: PARTY_KEY_TWO }, [ORDER], GENERATION_TWO, 40 * HOUR);
      const kept = yield* healing(Effect.succeed(live), partial, current, 17 * HOUR);
      expect(Object.keys(kept.held.workloadCredentials).toSorted()).toEqual(
        [ORDER_WORKLOAD_ENTRY, ORDER_WORKLOAD_ELSEWHERE].toSorted(),
      );
      expect(kept.retirements).toEqual([[`${ORDER}-provider-key`, `${PARTY}-provider-key`]]);
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
