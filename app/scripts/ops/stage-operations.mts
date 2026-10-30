import { Console, Context, Effect, Redacted } from 'effect';

import { ZeropsPublicApi } from '../zerops-public-api.mts';
import { runCommand } from './ops-shell.mts';
import { StageOperationError } from './stage-operation-error.mts';

/**
 * Shared vocabulary of the stage operations scripts: the Zerops service listing, service variable
 * reads, and the dry-run gate every mutation passes through. Zerops is driven through the locally
 * authenticated `zcli` behind the `OpsShell` seam.
 */
const ZCLI = 'zcli';
const PROJECT_ID_FLAG = '--project-id';

export interface OpsModeSettings {
  /** Reads always run, so a dry run reports the real plan; mutations are only reported. */
  readonly dryRun: boolean;
}

export const OpsMode = Context.Service<OpsModeSettings>('@app/scripts/ops/stage-operations/OpsMode');

/** Runs `effect` unless this is a dry run, in which case it only reports the mutation. */
export const perform = <A, E, R>(description: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* performEffect() {
    const { dryRun } = yield* OpsMode;
    yield* Console.log(dryRun ? `[dry-run] would ${description}` : description);
    if (!dryRun) {
      yield* effect;
    }
  });

// ---------------------------------------------------------------------------------------------
// Zerops through zcli

export interface ZeropsService {
  readonly hostname: string;
  readonly id: string;
  readonly status: string;
}

/** Parses the table `zcli service list` prints: `│ ID │ NAME │ STATUS │` rows under a header row. */
export const parseZeropsServiceList = (output: string): readonly ZeropsService[] =>
  output.split('\n').flatMap((line) => {
    const cells = line
      .split('│')
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);
    const [id, hostname, status] = cells;
    return cells.length === 3 && id !== undefined && hostname !== undefined && status !== undefined && id !== 'ID'
      ? [{ hostname, id, status }]
      : [];
  });

export const listZeropsServices = (projectId: string) =>
  runCommand({ args: ['service', 'list', PROJECT_ID_FLAG, projectId], command: ZCLI }).pipe(
    Effect.map(parseZeropsServiceList),
  );

/** `<hostname>_<KEY>`: a Zerops hostname has no underscore, so the first one splits the service from its key. */
const SERVICE_VALUE_KEY = /^(?<hostname>[a-z0-9]{1,25})_(?<name>[A-Za-z0-9_]+)$/u;

/**
 * Reads one service variable into memory without printing it, named the way the project scope names it:
 * `<hostname>_<KEY>` (for example `db18_password`). The value comes from the service's data through the Zerops
 * API, because `zcli project env` prints sensitive secrets and generated passwords as `REDACTED`.
 */
export const readZeropsValue = (projectId: string, key: string) =>
  Effect.gen(function* readZeropsValueEffect() {
    const { hostname, name } = SERVICE_VALUE_KEY.exec(key)?.groups ?? {};
    if (hostname === undefined || name === undefined) {
      return yield* new StageOperationError({ message: `"${key}" is not a Zerops <hostname>_<KEY> variable name` });
    }
    const service = (yield* listZeropsServices(projectId)).find((candidate) => candidate.hostname === hostname);
    if (service === undefined) {
      return yield* new StageOperationError({ message: `Zerops project ${projectId} has no ${hostname} service` });
    }
    const api = yield* ZeropsPublicApi;
    const value = (yield* api.serviceSecrets(service.id)).get(name);
    const content = value === undefined ? '' : Redacted.value(value);
    if (value === undefined || content.length === 0) {
      return yield* new StageOperationError({ message: `Zerops project ${projectId} has no value for ${key}` });
    }
    // A read-only Zerops token sees sensitive values masked as this marker.
    if (content === 'REDACTED') {
      return yield* new StageOperationError({
        message: `the Zerops token can only read ${key} masked; use a full-access token`,
      });
    }
    return value;
  });
