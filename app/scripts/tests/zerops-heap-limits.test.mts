import { NodeServices } from '@effect/platform-node';
import { Effect, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  containerMemoryBytes,
  OWNERS_YOUNG_GENERATION_ARGUMENTS,
  heapLimitArguments,
  heapLimitMiB,
  parseCgroupMemoryLimit,
  readContainerMemoryBytes,
} from '../zerops/heap-limits.mts';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

it('reads cgroup v2 byte counts and treats `max` and malformed values as no limit', () => {
  expect(parseCgroupMemoryLimit('4294967296\n')).toEqual(Option.some(4 * GIB));
  expect(parseCgroupMemoryLimit('max\n')).toEqual(Option.none());
  expect(parseCgroupMemoryLimit('')).toEqual(Option.none());
  expect(parseCgroupMemoryLimit('0')).toEqual(Option.none());
  expect(parseCgroupMemoryLimit('-1')).toEqual(Option.none());
  expect(parseCgroupMemoryLimit('3.5G')).toEqual(Option.none());
  expect(parseCgroupMemoryLimit('99999999999999999999')).toEqual(Option.none());
});

it('uses the lower cgroup limit and falls back to machine memory only when neither is a number', () => {
  const total = 64 * GIB;
  expect(containerMemoryBytes([Option.some(String(4 * GIB)), Option.some(String(3 * GIB))], total)).toBe(3 * GIB);
  expect(containerMemoryBytes([Option.some(String(4 * GIB)), Option.some('max')], total)).toBe(4 * GIB);
  expect(containerMemoryBytes([Option.some('max'), Option.some(String(3 * GIB))], total)).toBe(3 * GIB);
  expect(containerMemoryBytes([Option.some('max'), Option.some('max')], total)).toBe(total);
  expect(containerMemoryBytes([Option.none(), Option.none()], total)).toBe(total);
  expect(containerMemoryBytes([], total)).toBe(total);
});

it('gives the Shell and the Outbox worker their shares at both stage sizes, in whole 16 MiB steps', () => {
  const floor = Math.round(2.95 * GIB);
  expect(heapLimitMiB('shell', floor)).toBe(752);
  expect(heapLimitMiB('outbox', floor)).toBe(752);
  expect(heapLimitMiB('shell', 4 * GIB)).toBe(1024);
  expect(heapLimitMiB('outbox', 4 * GIB)).toBe(1024);
  for (const memory of [floor, 4 * GIB, 3 * GIB + 7]) {
    expect(heapLimitMiB('shell', memory) % 16).toBe(0);
    expect(heapLimitMiB('outbox', memory) % 16).toBe(0);
  }
  // Together they take at most half of the smaller container; the owners and non-heap memory keep the rest.
  expect((heapLimitMiB('shell', floor) + heapLimitMiB('outbox', floor)) * MIB).toBeLessThan(floor / 2);
});

it('never caps below the floor on a small container nor above the ceiling on a large machine', () => {
  expect(heapLimitMiB('shell', GIB)).toBe(512);
  expect(heapLimitMiB('outbox', GIB)).toBe(512);
  expect(heapLimitMiB('shell', 64 * GIB)).toBe(1024);
  expect(heapLimitMiB('outbox', 64 * GIB)).toBe(1024);
  expect(heapLimitArguments('outbox', 4 * GIB)).toEqual(['--max-old-space-size=1024']);
});

it.effect('reads a positive limit on this machine', () =>
  Effect.gen(function* readsMachineLimit() {
    const bytes = yield* readContainerMemoryBytes;
    expect(Number.isSafeInteger(bytes)).toBe(true);
    expect(bytes).toBeGreaterThan(0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it('gives the owners a 64 MiB semi-space and no old-space cap', () => {
  expect(OWNERS_YOUNG_GENERATION_ARGUMENTS).toEqual(['--max-semi-space-size=64']);
  expect(OWNERS_YOUNG_GENERATION_ARGUMENTS.some((flag) => flag.startsWith('--max-old-space-size'))).toBe(false);
});
