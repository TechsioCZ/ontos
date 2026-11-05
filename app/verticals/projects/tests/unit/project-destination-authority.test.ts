import type { BoundAccessGate, OperationalScope, OwnerAuthorizationInput } from '@app/core-runtime';
import { ModuleKeySchema, RecordKeySchema } from '@app/core-runtime/access/ids';
import { unavailableBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { DateTime, Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { decideProjectDestination } from '../../src/access/project-destination-authority.ts';
import { projectDestinationParentFacts } from '../../src/access/project-destination-facts.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const source = '10000000-0000-4000-8000-000000000002';
const child = '10000000-0000-4000-8000-000000000003';
const grandchild = '10000000-0000-4000-8000-000000000004';
const parent = '10000000-0000-4000-8000-000000000005';
const scope = {
  authContextRef: 'projects-overlay-test',
  authMethod: 'session',
  correlationId: 'projects-overlay-test',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId,
} satisfies OperationalScope;
const rows = [
  { parentProjectId: null, projectId: parent },
  { parentProjectId: null, projectId: source },
  { parentProjectId: source, projectId: child },
  { parentProjectId: child, projectId: grandchild },
];
const hierarchyInput = (destination: null | string, capabilityKey: string): OwnerAuthorizationInput => ({
  capabilityKey,
  operation: 'action',
  operationAt: DateTime.makeUnsafe(new Date('2026-11-03T09:00:00Z')),
  operationKey: 'projects.core.move-project',
  ownerFacts: projectDestinationParentFacts(destination),
  owningModuleKey: 'projects.core',
  scope,
  targets: [],
});
const moveInput = (destination: null | string): OwnerAuthorizationInput => ({
  ...hierarchyInput(destination, 'projects.core.project.move'),
  target: { moduleKey: ModuleKeySchema.make('projects.core'), recordKey: RecordKeySchema.make(source) },
});

const scenario = (outcomes: Readonly<Record<string, 'ALLOWED' | 'DENIED' | 'UNAVAILABLE'>>) => {
  const asked: string[] = [];
  const gate: BoundAccessGate = {
    ...unavailableBoundAccessGate,
    decide: ({ target }: Parameters<BoundAccessGate['decide']>[0]) => {
      const key = target?.recordKey ?? '';
      asked.push(key);
      return Effect.succeed({
        evidence: [],
        outcome: outcomes[key] ?? 'ALLOWED',
        reasons: [{ code: 'deny.insufficient_grant' as const }],
        selectors: [],
      });
    },
  };
  const lock = { acquired: false };
  const loadHierarchy = () =>
    Effect.sync(() => {
      lock.acquired = true;
      return rows;
    });
  return { asked, gate, loadHierarchy, lock };
};

it.effect('refuses a move when the source and destination are granted but an affected descendant is not', () =>
  Effect.gen(function* deniedDescendant() {
    const { asked, gate, loadHierarchy } = scenario({ [grandchild]: 'DENIED' });
    const answer = yield* decideProjectDestination(gate, moveInput(parent), loadHierarchy);
    expect(answer).toBe('denied');
    expect(asked).toEqual([parent, child, grandchild]);
  }),
);

it.effect('admits all-authorized moves only after locking the source subtree and destination', () =>
  Effect.gen(function* allAllowed() {
    const state = scenario({});
    const answer = yield* decideProjectDestination(state.gate, moveInput(parent), state.loadHierarchy);
    expect(answer).toBe('allowed');
    expect(state.lock.acquired).toBe(true);
    expect(state.asked).toEqual([parent, child, grandchild]);
  }),
);

it.effect('a move to root still checks every affected descendant without inventing a root record', () =>
  Effect.gen(function* rootMove() {
    const state = scenario({ [child]: 'DENIED' });
    const answer = yield* decideProjectDestination(state.gate, moveInput(null), state.loadHierarchy);
    expect(answer).toBe('denied');
    expect(state.asked).toEqual([child]);
  }),
);

it.effect('treats an unavailable descendant decision as retryable, never as permission denial', () =>
  Effect.gen(function* unavailable() {
    const state = scenario({ [grandchild]: 'UNAVAILABLE' });
    const answer = yield* decideProjectDestination(state.gate, moveInput(parent), state.loadHierarchy);
    expect(answer).toBe('unavailable');
  }),
);

it.effect('a parented create checks destination write authority; a root create names no destination', () =>
  Effect.gen(function* create() {
    const state = scenario({ [parent]: 'DENIED' });
    const parented = hierarchyInput(parent, 'projects.core.project.create');
    expect(yield* decideProjectDestination(state.gate, parented, state.loadHierarchy)).toBe('denied');
    expect(state.asked).toEqual([parent]);
    expect(
      yield* decideProjectDestination(
        state.gate,
        hierarchyInput(null, 'projects.core.project.create'),
        state.loadHierarchy,
      ),
    ).toBe('allowed');
    expect(state.asked).toEqual([parent]);
    expect(state.lock.acquired).toBe(true);
  }),
);
