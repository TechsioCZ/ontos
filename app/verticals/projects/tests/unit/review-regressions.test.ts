import { ProjectLifecycleConflict } from '../../shared/domain/project-lifecycle-conflict.ts';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { makeProjectOwnerEligibilityService } from '../../src/services/project-owner-eligibility.service.ts';
import { requireProjectHierarchyAllowed } from '../../src/services/project-lifecycle-guard.service.ts';

const principalId = '30000000-0000-4000-8000-000000000001';
const candidate = { displayName: 'Eligible user', principalId };
const principals = {
  find: () => Effect.succeed(candidate),
  search: () => Effect.succeed([candidate]),
};

it.effect('checks the exact immutable Project identity instead of tenant access', () =>
  Effect.gen(function* ownerEligibility() {
    const requested: string[] = [];
    const service = makeProjectOwnerEligibilityService({
      access: {
        tenantResources: ({ permission, resources }) => {
          expect(permission).toBe('assign');
          return Effect.succeed(
            resources.map((resource) => {
              requested.push(resource.resourceId);
              return {
                decision: resource.resourceId === 'ONE' ? ('allowed' as const) : ('denied' as const),
                key: `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`,
              };
            }),
          );
        },
      },
      principals,
      tenantId: 'tenant',
    });
    expect(yield* service.check('one', principalId)).toBe('allowed');
    expect(yield* service.check('two', principalId)).toBe('denied');
    expect(requested).toEqual(['ONE', 'TWO']);
  }),
);

it.effect('rejects missing, inactive, non-human and foreign-tenant candidates before authorization', () =>
  Effect.gen(function* rejectCandidates() {
    let checks = 0;
    const service = makeProjectOwnerEligibilityService({
      access: {
        tenantResources: () => {
          checks += 1;
          return Effect.succeed([]);
        },
      },
      principals: {
        ...principals,
        find: () => principals.search().pipe(Effect.map((candidates) => candidates.find(() => false))),
      },
      tenantId: 'tenant',
    });
    expect(yield* service.check('ONE', principalId)).toBe('denied');
    expect(checks).toBe(0);
  }),
);

it.effect('fails closed without an assignment adapter or with mismatched authorization evidence', () =>
  Effect.gen(function* failClosed() {
    expect(
      yield* makeProjectOwnerEligibilityService({ access: {}, principals, tenantId: 'tenant' }).check(
        'ONE',
        principalId,
      ),
    ).toBe('unavailable');
    expect(
      yield* makeProjectOwnerEligibilityService({
        access: {
          tenantResources: () => Effect.succeed([{ decision: 'allowed', key: 'wrong-project' }]),
        },
        principals,
        tenantId: 'tenant',
      }).check('ONE', principalId),
    ).toBe('unavailable');
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
