import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { SetVariantAttributeOverrideActionIneligibleProblemSchema } from '../../shared/apis/set-variant-attribute-override-action.ts';
import {
  makeRetainedControlledValueFixture,
  retainedControlledValueTestServices,
} from '../support/retained-controlled-value-receiver.fixture.ts';

it.live(
  'retains direct and inherited Current use after genuine Controlled Value retirement while denying new assignment',
  () =>
    Effect.gen(function* retainedControlledValueNative() {
      const receiver = yield* makeRetainedControlledValueFixture();
      const before = yield* receiver.observeRetained();
      expect(before.controlled).toMatchObject([{ currentRevision: 1, lifecycleState: 'ACTIVE' }]);
      expect((yield* receiver.read()).evidence).toMatchObject({ status: 'VALID' });
      expect((yield* receiver.read(receiver.alternate)).evidence).toMatchObject({ status: 'VALID' });
      expect(yield* receiver.retire()).toMatchObject({ changed: true, lifecycle: 'RETIRED', revision: 2 });
      expect((yield* receiver.nativeRead()).evidence).toMatchObject({ status: 'VALID' });
      expect((yield* receiver.nativeRead(receiver.alternate)).evidence).toMatchObject({ status: 'VALID' });
      expect((yield* receiver.read()).evidence).toMatchObject({ status: 'VALID' });
      expect((yield* receiver.read(receiver.alternate)).evidence).toMatchObject({ status: 'VALID' });
      const retired = yield* receiver.observeRetained();
      expect(retired.sets).toEqual(before.sets);
      expect(retired.items).toEqual(before.items);
      expect(retired.revisions).toEqual(before.revisions);
      expect(retired.controlled).toMatchObject([{ currentRevision: 2, lifecycleState: 'RETIRED' }]);
      expect(retired.controlledRevisions.map(({ revision }) => revision)).toEqual([1, 2]);
      expect(retired.controlledRevisions[0]).toEqual(before.controlledRevisions[0]);
      expect(retired.controlledRevisions[1]).toMatchObject({
        meaning: retired.controlledRevisions[0]?.meaning,
        name: retired.controlledRevisions[0]?.name,
        specialization: 'GENERAL',
      });
      const denied = yield* receiver.attemptNewAssignment().pipe(Effect.flip);
      expect(Schema.is(SetVariantAttributeOverrideActionIneligibleProblemSchema)(denied)).toBe(true);
      expect(denied).toMatchObject({ code: 'attribute_values_ineligible', status: 422 });
      expect(yield* receiver.observeRetained()).toEqual(retired);
      // Vocabulary retirement is not an exemption from a real independent Current restriction.
      expect(yield* receiver.restrict([], 1)).toMatchObject({ allowanceRevision: 2, changed: true });
      expect((yield* receiver.read()).evidence).toMatchObject({ status: 'INVALID' });
      expect((yield* receiver.read(receiver.alternate)).evidence).toMatchObject({ status: 'INVALID' });
      expect(yield* receiver.observeRetained()).toEqual(retired);
    }).pipe(Effect.scoped, Effect.provide(retainedControlledValueTestServices)),
);
