import { PrincipalCandidatesUnavailable } from '@app/core-runtime';

import { ProjectLifecycleConflict } from '../../shared/domain/project-lifecycle-conflict.ts';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { makeProjectOwnerEligibilityService } from '../../src/services/project-owner-eligibility.service.ts';
import { requireProjectHierarchyAllowed } from '../../src/services/project-lifecycle-guard.service.ts';

const principalId = '30000000-0000-4000-8000-000000000001';
const candidate = { displayName: 'Eligible user', principalId };

it.effect('admits an active human Principal of this tenant as an Owner and refuses anyone else', () =>
  Effect.gen(function* ownerEligibility() {
    // Owner eligibility is an owner-local fact about the candidate (O64), not a permission question
    // about the person offering the change: the Project's own capabilities decide that at the gate.
    const service = makeProjectOwnerEligibilityService({
      principals: {
        find: (candidateId) => Effect.succeed(candidateId === principalId ? candidate : undefined),
        search: () => Effect.succeed([candidate]),
      },
    });
    expect(yield* service.check(principalId)).toBe('allowed');
    expect(yield* service.check('30000000-0000-4000-8000-000000000099')).toBe('denied');
    expect(yield* service.candidates('elig')).toEqual([candidate]);
  }),
);

it.effect('fails closed when the tenant principal records cannot be read', () =>
  Effect.gen(function* failClosed() {
    const unavailable = makeProjectOwnerEligibilityService({
      principals: {
        find: () =>
          Effect.fail(new PrincipalCandidatesUnavailable({ reason: 'Unit principal records are unavailable' })),
        search: () => Effect.succeed([]),
      },
    });
    expect(yield* unavailable.check(principalId)).toBe('unavailable');
  }),
);

it.effect('blocks active descendants and descendant Unarchive until all ancestors are active', () =>
  Effect.gen(function* ancestorGuard() {
    const hierarchy = [
      { lifecycleState: 'archived' as const, parentProjectId: null, projectId: 'root' },
      { lifecycleState: 'active' as const, parentProjectId: 'root', projectId: 'child' },
      { lifecycleState: 'archived' as const, parentProjectId: 'child', projectId: 'leaf' },
    ];
    expect(
      Schema.is(ProjectLifecycleConflict)(yield* requireProjectHierarchyAllowed(hierarchy, 'child').pipe(Effect.flip)),
    ).toBe(true);
    expect(
      Schema.is(ProjectLifecycleConflict)(
        yield* requireProjectHierarchyAllowed(hierarchy, 'leaf', true).pipe(Effect.flip),
      ),
    ).toBe(true);
    yield* requireProjectHierarchyAllowed(hierarchy, 'root', true);
    yield* requireProjectHierarchyAllowed(
      [
        { lifecycleState: 'active', parentProjectId: null, projectId: 'root' },
        { lifecycleState: 'active', parentProjectId: 'root', projectId: 'child' },
      ],
      'child',
    );
  }),
);
