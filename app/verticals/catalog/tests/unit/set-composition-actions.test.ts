import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { CreateSetCompositionPayloadSchema } from '../../shared/actions/create-set-composition.ts';
import { ReviseSetCompositionPayloadSchema } from '../../shared/actions/revise-set-composition.ts';
import { createSetCompositionAction } from '../../src/actions/create-set-composition.action.ts';
import { reviseSetCompositionAction } from '../../src/actions/revise-set-composition.action.ts';

describe('Set Composition governed Actions', () => {
  it('requires exact immutable revision input and no customer component choices', () => {
    for (const schema of [CreateSetCompositionPayloadSchema, ReviseSetCompositionPayloadSchema]) {
      expect(() => Schema.decodeUnknownSync(schema)({})).toThrow();
      expect(() =>
        Schema.decodeUnknownSync(schema)({
          effectiveFrom: '2026-09-17T00:00:00.000Z',
          expectedRevision: 0,
          lifecycleState: 'ACTIVE',
          revision: { components: [] },
        }),
      ).toThrow();
    }
  });

  it('keeps create and revise as explicit tenant-scoped idempotent Actions', () => {
    for (const action of [createSetCompositionAction, reviseSetCompositionAction]) {
      expect(action.descriptor.idempotency).toBe('required');
      expect(action.descriptor.legalEntityScope).toBe('forbidden');
      expect(action.descriptor.entrypoint.authorization).toEqual({
        kind: 'action_execution',
        provisioning: 'explicit',
      });
    }
  });
});
