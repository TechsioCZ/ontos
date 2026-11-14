import type { OperationalScope } from '@app/core-runtime';
import { PrincipalIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { readVerifiedGatewayWorkload } from '@app/core-runtime/auth/system-principal-context-provenance';
import { Config, DateTime, Effect, Schema } from 'effect';

import { ImportSymmyRulePayloadSchema } from '../../shared/actions/policy-administration.ts';
import type { ImportSymmyRulePayload } from '../../shared/actions/policy-administration.ts';
import {
  AssortmentSymmyFixtureAccessDenied,
  AssortmentSymmyFixtureConfigurationUnavailable,
} from '../../shared/domain/policy-errors.ts';
import { assortmentMeaningFingerprint, assortmentSymmyRuleFixtureWorkload } from './policy-administration.service.ts';

export const importSymmyRuleActionKey = 'commerce.assortment.import-symmy-rule';
const configuredSymmyRuleFixtures = Config.schema(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        command: ImportSymmyRulePayloadSchema,
        permit: Schema.RedactedFromValue(Schema.String.check(Schema.isUUID())),
        principalId: PrincipalIdSchema,
      }),
    ).check(Schema.isMaxLength(256)),
  ),
  'ONTOS_ASSORTMENT_SYMMY_RULE_FIXTURES',
).pipe(Config.withDefault([]));

export const symmyRuleCommandFingerprint = ({ binding, rule }: ImportSymmyRulePayload): string =>
  assortmentMeaningFingerprint({
    binding: { ...binding, effectiveFrom: DateTime.formatIso(binding.effectiveFrom) },
    rule,
  });

const fixtureAccessDenied = () =>
  new AssortmentSymmyFixtureAccessDenied({
    code: 'assortment_symmy_fixture_access_denied',
    reason: 'The exact internal fixture is outside the approved execution scope',
  });

/** Only an exact owner-enrolled synthetic fixture may use the separate migration Action. */
export const findEnrolledSymmyRuleFixture = Effect.fn('Assortment.findEnrolledSymmyRuleFixture')(
  function* authorizeFixture(scope: OperationalScope, commandFingerprint: string) {
    const source = readVerifiedGatewayWorkload(scope);
    if (
      source?.sourceMode !== 'worker' ||
      source.sourceAppId !== 'symmy-integration' ||
      source.workerModuleKey !== 'integration.symmy' ||
      source.workerKey !== 'integration.symmy.execute-symmy-job' ||
      source.workloadKey !== assortmentSymmyRuleFixtureWorkload ||
      source.entrypointKey !== importSymmyRuleActionKey ||
      source.schemaVersion !== '1' ||
      source.legalEntityScope !== 'required' ||
      source.legalEntityId !== scope.legalEntityId ||
      source.claimId === undefined ||
      source.recovery !== undefined
    ) {
      return yield* fixtureAccessDenied();
    }
    const configured = yield* configuredSymmyRuleFixtures.pipe(
      Effect.mapError((cause) =>
        Object.defineProperty(
          new AssortmentSymmyFixtureConfigurationUnavailable({
            code: 'assortment_symmy_fixture_configuration_unavailable',
            reason: 'The internal Assortment fixture configuration is unavailable',
          }),
          'cause',
          { value: cause },
        ),
      ),
    );
    const permitted = configured.find(
      (permit) =>
        permit.principalId === scope.principalId && symmyRuleCommandFingerprint(permit.command) === commandFingerprint,
    );
    const seller = permitted?.command.binding.commercialScope.sellingLegalEntityRef;
    return permitted === undefined || seller?.tenantId !== scope.tenantId || seller.resourceId !== scope.legalEntityId
      ? yield* fixtureAccessDenied()
      : permitted;
  },
);
