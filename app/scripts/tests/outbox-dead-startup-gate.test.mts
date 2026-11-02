import { readFileSync } from 'node:fs';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  startupDeadOutboxInventory,
  OutboxDeadStartupBlocked,
  withOutboxDeadStartupGate,
} from '../zerops/outbox-dead-startup-gate.mts';

const dead = {
  attemptsCount: 5,
  completionOriginalRevision: null,
  consumerModuleKey: 'commerce.market-catalog',
  lastError: 'not included in the startup diagnostic',
  outboxMessageId: 'ce579216-a027-48bb-a346-51b6ca7ee758',
  tenantId: 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9',
  updatedAt: new Date('2026-11-02T16:33:45Z'),
  workerKey: 'commerce.market-catalog.rebuild-search',
};

it.effect('refuses an untracked dead delivery from any Tenant before invoking migrations or publication', () =>
  Effect.gen(function* deadStartup() {
    const calls: string[] = [];
    const failure = yield* Effect.flip(
      withOutboxDeadStartupGate(
        Effect.succeed([dead]),
        Effect.sync(() => calls.push('DDL and authority')),
      ),
    );
    expect(calls).toEqual([]);
    expect(Schema.is(OutboxDeadStartupBlocked)(failure)).toBe(true);
    expect(failure.reason).toContain(dead.outboxMessageId);
    expect(failure.reason).toContain(dead.workerKey);
    expect(failure.reason).not.toContain(dead.lastError);
  }),
);
it.effect('fails closed when the native inventory cannot be read, without starting DDL', () =>
  Effect.gen(function* unavailableStartup() {
    let started = false;
    const failure = yield* Effect.flip(
      withOutboxDeadStartupGate(
        Effect.fail('secret database failure'),
        Effect.sync(() => {
          started = true;
        }),
      ),
    );
    expect(started).toBe(false);
    expect(failure.reason).toContain('were not started');
    expect(failure.reason).not.toContain('secret');
  }),
);
it.effect('continues the original startup exactly once after a successful empty native inventory', () =>
  Effect.gen(function* emptyStartup() {
    const calls: string[] = [];
    const result = yield* withOutboxDeadStartupGate(
      Effect.sync(() => {
        calls.push('list');
        return [];
      }),
      Effect.sync(() => {
        calls.push('DDL', 'publish');
        return 'ready';
      }),
    );
    expect(result).toBe('ready');
    expect(calls).toEqual(['list', 'DDL', 'publish']);
  }),
);
it('wires the unfiltered native gate before the real migrator and publication, without weakening the drain', () => {
  const source = readFileSync(new URL('../zerops/app-host.mts', import.meta.url), 'utf-8');
  const startup = source.slice(source.indexOf('const startup = Effect.gen(function* startupSequence()'));
  expect(startup.indexOf('listDeadOutboxDeliveries(database.executor, { limit: 10 })')).toBeGreaterThan(0);
  expect(startup.indexOf('withOutboxDeadStartupGate(')).toBeLessThan(startup.indexOf("runChild('migrator'"));
  expect(startup.indexOf('withOutboxDeadStartupGate(')).toBeLessThan(startup.indexOf('yield* publish;'));
});

it.effect('permits only proven first Core install, never an inventory or catalog error', () =>
  Effect.gen(function* firstCoreBootstrap() {
    let reads = 0;
    const list = Effect.sync(() => {
      reads += 1;
      return [dead];
    });
    expect(yield* startupDeadOutboxInventory(Effect.succeed(false), list)).toEqual([]);
    expect(reads).toBe(0);
    expect(yield* startupDeadOutboxInventory(Effect.succeed(true), list)).toEqual([dead]);
    expect(reads).toBe(1);
    const problem = yield* Effect.flip(startupDeadOutboxInventory(Effect.fail('catalog unavailable'), list));
    expect(problem).toBe('catalog unavailable');
    expect(reads).toBe(1);
  }),
);
