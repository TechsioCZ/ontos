import { Effect, Match, Option } from 'effect';
import { ProjectLifecycleConflict, ProjectNotFound } from '../../shared/domain/project.ts';
import type { Project } from '../../shared/domain/project.ts';
import type { ProjectLookup } from './project-persistence.service.ts';

export type ProjectLifecycleGuardError = ProjectLifecycleConflict | ProjectNotFound;
export const requireProjectActionAllowed = <Value extends Pick<Project, 'lifecycleState'>>(project: Value) =>
  project.lifecycleState === 'active'
    ? Effect.succeed(project)
    : Effect.fail(
        new ProjectLifecycleConflict({
          code: 'project_lifecycle_conflict',
          reason: 'Archived Projects permit only Unarchive',
        }),
      );
export const requireActiveProject = <Failure>(
  lookup: (projectId: string) => Effect.Effect<ProjectLookup, Failure>,
  projectId: string,
) =>
  lookup(projectId).pipe(
    Effect.flatMap((result) =>
      Match.value(result).pipe(
        Match.tags({
          found: ({ value }) => requireProjectActionAllowed(value),
          not_found: () =>
            Effect.fail(new ProjectNotFound({ code: 'project_not_found', reason: 'Project was not found' })),
        }),
        Match.exhaustive,
      ),
    ),
  );

type HierarchyRow = Pick<Project, 'projectId' | 'lifecycleState'> & { readonly parentProjectId: string | null };
const blockingAncestor = (hierarchy: readonly HierarchyRow[], projectId: string, allowArchivedTarget: boolean) => {
  const parents = new Map(hierarchy.map((project) => [project.projectId, project]));
  let cursor: string | null = projectId;
  const visited = new Set<string>();
  while (cursor !== null) {
    const project = parents.get(cursor);
    if (project === undefined) {
      return Option.some(new ProjectNotFound({ code: 'project_not_found', reason: 'Project was not found' }));
    }
    if (visited.has(cursor)) {
      return Option.some(
        new ProjectLifecycleConflict({
          code: 'project_lifecycle_conflict',
          reason: 'Project hierarchy cannot be determined safely',
        }),
      );
    }
    visited.add(cursor);
    if (!(allowArchivedTarget && cursor === projectId) && project.lifecycleState === 'archived') {
      return Option.some(
        new ProjectLifecycleConflict({
          code: 'project_lifecycle_conflict',
          reason: 'An archived Project blocks descendant Actions',
        }),
      );
    }
    cursor = project.parentProjectId;
  }
  return Option.none<ProjectLifecycleGuardError>();
};
/** Caller holds the tenant hierarchy's ordered locks through transaction settlement. */
export const requireProjectHierarchyAllowed = (
  hierarchy: readonly HierarchyRow[],
  projectId: string,
  allowArchivedTarget = false,
) =>
  Effect.sync(() => blockingAncestor(hierarchy, projectId, allowArchivedTarget)).pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: Effect.fail })),
  );
