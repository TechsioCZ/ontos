import { Effect, Match } from 'effect';
import { ActionTransactionError } from '@app/core-runtime';

import { ConfigurationUnitActionError } from '../../shared/actions/configuration-unit-contract.ts';
import type { ConfigurationUnitMutationOutcome } from '../persistence/configuration-unit-persistence.ts';
import { configurationUnitPersistenceForScope } from '../persistence/configuration-unit-persistence.ts';

export const configurationUnitPersistenceServiceFactory = (
  transaction: Parameters<typeof configurationUnitPersistenceForScope>[0],
  scope: Parameters<typeof configurationUnitPersistenceForScope>[1],
) => Effect.succeed(configurationUnitPersistenceForScope(transaction, scope));

export const mapConfigurationUnitPersistenceError = () =>
  new ConfigurationUnitActionError({
    code: 'configuration_unit_unavailable',
    reason: 'Authoritative Configuration Unit persistence or Current basis is unavailable',
  });

export const mapConfigurationUnitCaptureError = (cause: unknown) => {
  const failure = new ActionTransactionError({
    code: 'action_transaction_failed',
    reason: 'Catalog result capture failed',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

export const resolveConfigurationUnitMutation = (outcome: ConfigurationUnitMutationOutcome) =>
  Match.value(outcome).pipe(
    Match.whenOr({ status: 'CREATED' }, { status: 'REVISED' }, { status: 'RETIRED' }, ({ revision, unit }) =>
      Effect.succeed({ revision, unit }),
    ),
    Match.when({ status: 'INVALID' }, ({ reason }) =>
      Effect.fail(new ConfigurationUnitActionError({ code: 'configuration_unit_invalid', reason })),
    ),
    Match.when({ status: 'NOT_FOUND' }, () =>
      Effect.fail(
        new ConfigurationUnitActionError({
          code: 'configuration_unit_invalid',
          reason: 'Configuration Unit was not found in the trusted Tenant',
        }),
      ),
    ),
    Match.when({ status: 'STALE' }, () =>
      Effect.fail(
        new ConfigurationUnitActionError({
          code: 'configuration_unit_stale',
          reason: 'Configuration Unit revision changed',
        }),
      ),
    ),
    Match.exhaustive,
  );
