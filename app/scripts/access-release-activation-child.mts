import path from 'node:path';

/**
 * How the migrator starts the access catalog release activation (`run-zerops-migrator.mjs`): this Node, the script
 * by its absolute path, no argument at all, in the application directory, with the migrator's own environment. The
 * migrator and the script test that proves the script accepts exactly this both build it here, so they cannot drift.
 */
export const ACCESS_RELEASE_ACTIVATION_SCRIPT = 'scripts/activate-access-catalog-release.mts';

/** The child's argument vector after the Node executable, for the given application directory. */
export const accessReleaseActivationArguments = (appDirectory: string): readonly string[] => [
  path.join(appDirectory, ACCESS_RELEASE_ACTIVATION_SCRIPT),
];
