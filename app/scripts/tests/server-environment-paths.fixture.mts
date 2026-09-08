import { NodeRuntime } from '@effect/platform-node';
import { Console } from 'effect';
import { ROOT_ENV_PATH as databaseEnvironmentPath } from '../../packages/core-runtime/src/db/config.ts';
import { SPICEDB_ROOT_ENV_PATH } from '../../packages/core-runtime/src/permissions/config.ts';
import { ROOT_ENV_PATH as authenticationEnvironmentPath } from '../../apps/shell-super-app/api/auth/config.ts';

NodeRuntime.runMain(
  Console.log(
    JSON.stringify([databaseEnvironmentPath, SPICEDB_ROOT_ENV_PATH, authenticationEnvironmentPath]),
  ),
);
