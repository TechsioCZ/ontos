#!/usr/bin/env node
/**
 * The CRM's governed Party Registry intake identity (CRM.md §3/§4). LOCAL ONLY, idempotent.
 *
 *   node scripts/demo/crm-party-intake.mts               # principal row + managed API key
 *   node scripts/demo/crm-party-intake.mts --skip-keys   # principal row only
 *
 * Every active CRM client needs a Party Registry identity, but salespeople must not get registry access (its
 * customer list is company-wide), so the CRM server creates/reuses the registry Party + CUSTOMER Counterparty
 * itself while authenticated as this non-human principal.
 *
 * This script owns identity and credentials only. The reviewed canonical source binds this service to
 * `demo.crm.party-intake`, used by CRM's slim pending-client-intake Read and link-only intake Action.
 * Composed caller `crm` delegates the same bound workload to the purpose-specific Party Action and
 * the existing reconciliation carriers. No CRM records/apply-command or Party human Role is assigned.
 * Native owner target checks, current composition and selected-company provenance remain required.
 * A prepared source binding is not proof of live activation or completed native validation.
 *
 * The managed key lands in `app/.env.demo.local` as `ONTOS_CRM_PARTY_INTAKE_API_KEY` (with the principal id as
 * `ONTOS_CRM_PARTY_INTAKE_PRINCIPAL_ID`); the CRM server reads both there (or from its environment) on each
 * intake, so no CRM restart is needed after (re)issuing the key.
 */
import { NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Exit, Layer, Path, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';

import { DatabaseConfig, parseDatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';
import { AuthDatabaseFromDatabaseConfigLive } from '../../apps/shell-super-app/api/auth/db/client.ts';
import { demoTenantId } from './fixture-ids.mts';
import {
  ensureMachinePrincipals,
  issueManagedKey,
  MachineIdentityError,
  machineIdentityEnvironment,
  shellIsServing,
  workspaceRootOf,
  writeEnvValues,
} from './machine-identity.mts';
import { CRM_PARTY_INTAKE_WORKLOAD, crmPartyIntakePrincipal } from './permissions.mts';

const ENV_FILE = '.env.demo.local';
const OPERATOR_EMAIL = 'obchod@demo.ontos';
const PRINCIPAL_ID_VARIABLE = 'ONTOS_CRM_PARTY_INTAKE_PRINCIPAL_ID';

const adminDatabaseConfigLive = Layer.effect(
  DatabaseConfig,
  Config.Redacted('DATABASE_ADMIN_URL').pipe(
    Effect.flatMap((url) => parseDatabaseConfig({ DATABASE_URL: Redacted.value(url) })),
    Effect.mapError(() => new MachineIdentityError({ reason: 'DATABASE_ADMIN_URL is not a local PostgreSQL URL' })),
  ),
);

const installIntakeIdentity = (skipKeys: boolean) =>
  Effect.gen(function* installCrmPartyIntakeIdentity() {
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(workspaceRootOf(import.meta.url));
    yield* ensureMachinePrincipals([
      {
        displayName: crmPartyIntakePrincipal.displayName,
        kind: 'service' as const,
        principalId: crmPartyIntakePrincipal.principalId,
        tenantId: demoTenantId,
      },
    ]);
    yield* Console.log(`crm-party-intake: principal ${crmPartyIntakePrincipal.principalId}`);
    yield* Console.log(
      `crm-party-intake: reviewed workload ${CRM_PARTY_INTAKE_WORKLOAD}; no human Role or broad CRM/Party grants`,
    );
    if (skipKeys) {
      return yield* Effect.void;
    }
    const { password, shellUrl } = yield* machineIdentityEnvironment(root);
    if (!(yield* shellIsServing(shellUrl))) {
      return yield* new MachineIdentityError({
        reason: `The Shell at ${shellUrl} is not serving; its managed-key endpoint is how this identity is issued. Start the stack and re-run.`,
      });
    }
    const secret = yield* issueManagedKey({
      keyName: crmPartyIntakePrincipal.apiKeyName,
      operatorEmail: OPERATOR_EMAIL,
      password,
      principalId: crmPartyIntakePrincipal.principalId,
      shellUrl,
    });
    yield* writeEnvValues({
      header: 'CRM Party Registry intake identity (scripts/demo/crm-party-intake.mts). Local secrets; gitignored.',
      path: path.join(root, ENV_FILE),
      values: new Map([
        [crmPartyIntakePrincipal.envVar, Redacted.value(secret)],
        [PRINCIPAL_ID_VARIABLE, crmPartyIntakePrincipal.principalId],
      ]),
    });
    return yield* Console.log(
      `crm-party-intake: API key issued -> app/${ENV_FILE} (${crmPartyIntakePrincipal.envVar}); key never printed`,
    );
  });

const command = Command.make(
  crmPartyIntakePrincipal.apiKeyName,
  { skipKeys: Flag.Boolean('skip-keys').pipe(Flag.withDefault(false)) },
  ({ skipKeys }) =>
    installIntakeIdentity(skipKeys).pipe(
      Effect.tapError((problem) =>
        Console.error(
          Schema.is(MachineIdentityError)(problem)
            ? `CRM party intake failed: ${problem.reason}`
            : `CRM party intake failed (${problem._tag})`,
        ),
      ),
    ),
);

if (import.meta.main) {
  const exit = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.provide(AuthDatabaseFromDatabaseConfigLive.pipe(Layer.provide(adminDatabaseConfigLive))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(NodeServices.layer),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
