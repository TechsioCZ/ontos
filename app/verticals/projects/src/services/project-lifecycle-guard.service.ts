import { Effect } from 'effect';
import { ProjectLifecycleConflict, ProjectNotFound } from '../domain/project.ts';
import type { Project } from '../domain/project.ts';
import type { ProjectLookup } from './project-persistence.service.ts';

export type ProjectLifecycleGuardError = ProjectLifecycleConflict | ProjectNotFound;

export interface ProjectLifecycleLookup {
  readonly findForLifecycleGuard: (projectId: string) => Effect.Effect<ProjectLookup, unknown>;
}

export const requireProjectActionAllowed = <Value extends Pick<Project, 'lifecycleState'>>(
  project: Value,
): Effect.Effect<Value, ProjectLifecycleConflict> =>
  project.lifecycleState === 'active'
    ? Effect.succeed(project)
    : Effect.fail(
        new ProjectLifecycleConflict({
          code: 'project_lifecycle_conflict',
          reason: 'Archived Projects permit only Unarchive',
        }),
      );

/**
 * Owner-local lifecycle gate for Project mutations and future descendant operations.
 * The production lookup takes a row lock, so the successful guard remains true until
 * the surrounding governed transaction commits or rolls back.
 */
export const requireActiveProject = <Error>(
  lookup: (projectId: string) => Effect.Effect<ProjectLookup, Error>,
  projectId: string,
): Effect.Effect<Project, Error | ProjectLifecycleGuardError> =>
  Effect.gen(function* requireActiveProjectEffect() {
    const result = yield* lookup(projectId);
    if (result._tag === 'not_found') {
      return yield* new ProjectNotFound({
        code: 'project_not_found',
        reason: 'The requested Project does not exist',
      });
    }
    return yield* requireProjectActionAllowed(result.value);
  });
