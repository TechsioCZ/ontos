import { ProjectLifecycleConflict } from '../../shared/domain/project-lifecycle-conflict.ts';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  makeProjectOwnerAuthorization,
  preparedProjectOwnerEligibility,
} from '../../src/services/project-owner-eligibility.service.ts';
import { requireProjectHierarchyAllowed } from '../../src/services/project-lifecycle-guard.service.ts';

const principalId = '30000000-0000-4000-8000-000000000001';
const candidate = { displayName: 'Eligible user', principalId };
const activePrincipals = { find: () => Effect.succeed(candidate) };

it.effect('checks the exact immutable Project identity instead of tenant access', () =>
  Effect.gen(function* ownerEligibility() {
    const requested: string[] = [];
    const authorize = makeProjectOwnerAuthorization({
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
      tenantId: 'tenant',
    });
    expect(yield* authorize('one', principalId)).toBe('allowed');
    expect(yield* authorize('two', principalId)).toBe('denied');
    expect(requested).toEqual(['ONE', 'TWO']);
  }),
);

it.effect('answers only the prepared Owner and prefix, and rechecks that the Owner is still active', () =>
  Effect.gen(function* preparedDecision() {
    const allowedOwner = { decision: 'allowed' as const, prefix: 'ONE', principalId };
    const prepared = Option.some(allowedOwner);
    expect(yield* preparedProjectOwnerEligibility(activePrincipals, prepared)('one', principalId)).toBe('allowed');
    expect(yield* preparedProjectOwnerEligibility(activePrincipals, prepared)('TWO', principalId)).toBe('unavailable');
    expect(yield* preparedProjectOwnerEligibility(activePrincipals, prepared)('ONE', 'other')).toBe('unavailable');
    expect(yield* preparedProjectOwnerEligibility(activePrincipals, Option.none())('ONE', principalId)).toBe(
      'unavailable',
    );
    const departed = { find: () => Effect.sync(() => [candidate].find(() => false)) };
    expect(yield* preparedProjectOwnerEligibility(departed, prepared)('ONE', principalId)).toBe('denied');
    let lookups = 0;
    const counted = {
      find: () => {
        lookups += 1;
        return Effect.succeed(candidate);
      },
    };
    expect(
      yield* preparedProjectOwnerEligibility(counted, Option.some({ ...allowedOwner, decision: 'denied' as const }))(
        'ONE',
        principalId,
      ),
    ).toBe('denied');
    expect(lookups).toBe(0);
  }),
);

it.effect('fails closed without an assignment adapter or with mismatched authorization evidence', () =>
  Effect.gen(function* failClosed() {
    expect(yield* makeProjectOwnerAuthorization({ access: {}, tenantId: 'tenant' })('ONE', principalId)).toBe(
      'unavailable',
    );
    expect(
      yield* makeProjectOwnerAuthorization({
        access: {
          tenantResources: () => Effect.succeed([{ decision: 'allowed', key: 'wrong-project' }]),
        },
        tenantId: 'tenant',
      })('ONE', principalId),
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
