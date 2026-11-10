import { Effect, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  SymmyExecutionJobSchema,
  SymmyFixtureExecutionPlanSchema,
  symmyPlanDependenciesValid,
} from '../../shared/domain/symmy-job-execution.ts';
import { projectSymmyExecutionJob } from '../../src/persistence/symmy-job-execution-store.ts';

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const pinnedEffect = (suffix: string) => ({
  effectKey: `effect-${suffix}`,
  itemId: id('2'),
  ref: {
    effectId: id(suffix),
    mappingVersion: 'mapping-original',
    occurrence: {
      occurrenceId: id('3'),
      record: {
        entityKind: 'product',
        issuerId: 'internal',
        route: { integrationRouteId: id('4'), tenantId: id('5') },
        sourceNamespace: 'fixtures',
        sourceRecordId: 'original-source',
      },
    },
    operation: { entrypointKey: 'integration.symmy.fixture-effect', moduleId: 'integration.symmy', schemaVersion: '1' },
    originalTarget: {
      moduleId: 'integration.symmy',
      resourceId: 'original-target',
      resourceType: 'integration.symmy.fixture-target',
      tenantId: id('5'),
    },
    routeRevision: 'route-original',
  },
});
const first = pinnedEffect('6');
const second = pinnedEffect('7');
const outcome = { effectId: first.ref.effectId, owner: 'integration.symmy', status: 'accepted_change' };
const execution = (secondState: 'planned' | 'attempting' | 'indeterminate' | 'blocked' | 'settled') =>
  Schema.decodeUnknownSync(SymmyExecutionJobSchema)({
    effects: [
      { effect: first, outcome, state: 'settled', version: 2 },
      {
        effect: second,
        outcome:
          secondState === 'settled' || secondState === 'blocked'
            ? { owner: 'integration.symmy', status: 'denied' }
            : null,
        state: secondState,
        version: 2,
      },
    ],
    jobId: id('1'),
    legalEntityId: null,
    mappingVersion: 'mapping-original',
    originalPrincipalId: id('8'),
    plan: { items: [{ effects: [first, second], itemId: id('2'), itemKey: 'source-one' }] },
    routeId: id('4'),
    routeRevision: 'route-original',
  });

describe('durable job execution projection', () => {
  it.effect('retains a settled sibling while reporting original uncertain work without private references', () =>
    Effect.gen(function* verifyUncertainty() {
      const result = yield* projectSymmyExecutionJob(execution('indeterminate'));
      expect(result).toEqual({
        items: [
          {
            effects: [outcome, { effectId: second.ref.effectId, owner: 'integration.symmy', status: 'indeterminate' }],
            itemId: id('2'),
          },
        ],
        jobId: id('1'),
        phase: 'indeterminate',
      });
      expect(JSON.stringify(result)).not.toContain('original-source');
      expect(JSON.stringify(result)).not.toContain('original-target');
    }),
  );

  it.effect('reports a completed partial job only after every effect is settled', () =>
    Effect.gen(function* verifyCompletion() {
      const waiting = yield* projectSymmyExecutionJob(execution('planned'));
      const executing = yield* projectSymmyExecutionJob(execution('attempting'));
      expect(waiting.phase).toBe('running');
      expect(waiting.items[0]?.effects[1]?.status).toBe('waiting');
      expect(executing.items[0]?.effects[1]?.status).toBe('executing');
      expect((yield* projectSymmyExecutionJob(execution('blocked'))).phase).toBe('blocked');
      expect((yield* projectSymmyExecutionJob(execution('settled'))).phase).toBe('completed_partial');
    }),
  );

  it.effect('refuses to project success when a durable effect row is missing', () =>
    Effect.gen(function* verifyMissingEffect() {
      const job = execution('settled');
      const failure = yield* projectSymmyExecutionJob({ ...job, effects: job.effects.slice(0, 1) }).pipe(Effect.flip);
      expect(failure.code).toBe('unavailable');
    }),
  );

  it('rejects caller payloads and duplicate fixture item keys from operator plans', () => {
    const parse = Schema.decodeUnknownResult(SymmyFixtureExecutionPlanSchema, { onExcessProperty: 'error' });
    const item = {
      effects: [{ effectKey: 'one', operation: first.ref.operation, originalTarget: first.ref.originalTarget }],
      itemKey: 'one',
      source: { entityKind: 'product', issuerId: 'internal', sourceNamespace: 'fixtures', sourceRecordId: 'record' },
    };
    expect(Result.isSuccess(parse({ items: [item] }))).toBe(true);
    expect(Result.isFailure(parse({ items: [item, item] }))).toBe(true);
    expect(Result.isFailure(parse({ items: [{ ...item, payload: { secret: 'not permitted' } }] }))).toBe(true);
  });
});

describe('bounded source effect dependency graph', () => {
  it('accepts named cross-item dependencies independently of array order', () => {
    expect(
      symmyPlanDependenciesValid([
        {
          effects: [{ dependsOn: [{ effectKey: 'create', itemKey: 'parent' }], effectKey: 'create' }],
          itemKey: 'child',
        },
        { effects: [{ effectKey: 'create' }], itemKey: 'parent' },
      ]),
    ).toBe(true);
  });
  it('rejects cross-item cycles, missing parents and duplicate edges', () => {
    expect(
      symmyPlanDependenciesValid([
        { effects: [{ dependsOn: [{ effectKey: 'write', itemKey: 'b' }], effectKey: 'write' }], itemKey: 'a' },
        { effects: [{ dependsOn: [{ effectKey: 'write', itemKey: 'a' }], effectKey: 'write' }], itemKey: 'b' },
      ]),
    ).toBe(false);
    expect(
      symmyPlanDependenciesValid([
        { effects: [{ dependsOn: [{ effectKey: 'write', itemKey: 'missing' }], effectKey: 'write' }], itemKey: 'a' },
      ]),
    ).toBe(false);
    expect(
      symmyPlanDependenciesValid([
        {
          effects: [
            { effectKey: 'parent' },
            { dependsOn: ['parent', { effectKey: 'parent', itemKey: 'a' }], effectKey: 'child' },
          ],
          itemKey: 'a',
        },
      ]),
    ).toBe(false);
  });
});
