/**
 * The external identity provider a deployment installs. Deployment data names the Authentication Namespace, the
 * provider origin, the attester and the workload grants; the module that serves the namespace declares the rest in its
 * contract (`externalIdentityProviders`): provider name, admission deadline and verification endpoint. The Shell
 * resolves that declaration from the active composition on every use and never names the module.
 */
import type { AuthenticationNamespaceRegistration } from '@app/core-runtime/auth/external-identity-contracts';
import {
  AuthenticationNamespaceIdSchema,
  AuthenticationNamespaceRegistrationSchema,
  PrincipalIdSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import { OntosExternalIdentityProviderSchema } from '@app/core-runtime/auth/external-identity-provider';
import type { OntosExternalIdentityProvider } from '@app/core-runtime/auth/external-identity-provider';
import { Context, Option, Result, Schema } from 'effect';
import type { Effect } from 'effect';

import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import { ExternalIdentityHttpConfigurationSchema } from './external-identity/configuration.ts';

export const ExternalIdentityProviderConfigurationSchema = Schema.Struct({
  ...ExternalIdentityHttpConfigurationSchema.fields,
  attesterPrincipalId: PrincipalIdSchema,
  authenticationNamespaceId: AuthenticationNamespaceIdSchema,
});
export type ExternalIdentityProviderConfiguration = typeof ExternalIdentityProviderConfigurationSchema.Type;

/** The decoded deployment data of the installed provider. */
export class ExternalIdentityProviderConfigurationService extends Context.Service<
  ExternalIdentityProviderConfigurationService,
  ExternalIdentityProviderConfiguration
>()('@app/shell-super-app/api/auth/external-identity-provider/ExternalIdentityProviderConfigurationService') {}

/** Decodes deployment data once, before any trusted service is built; malformed data fails layer construction. */
export const decodeExternalIdentityProviderConfiguration = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Deployment input is decoded at the trusted composition boundary.
  input: unknown,
): Effect.Effect<ExternalIdentityProviderConfiguration, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(ExternalIdentityProviderConfigurationSchema, { onExcessProperty: 'error' })(input);

/** The installed module serving the configured namespace, with what its contract declares. */
export interface InstalledExternalIdentityProvider {
  readonly appId: string;
  /** The approved release origin of that module in the active composition. */
  readonly backendBaseUrl: string;
  readonly declaration: OntosExternalIdentityProvider;
}

const ContractProvidersSchema = Schema.fromJsonString(
  Schema.Struct({
    manifest: Schema.Struct({
      publicSurface: Schema.Struct({
        externalIdentityProviders: Schema.optionalKey(Schema.Array(OntosExternalIdentityProviderSchema)),
      }),
    }),
  }),
);
const decodeContractProviders = Schema.decodeUnknownOption(ContractProvidersSchema);

/** The module of an installed catalog that declares `authenticationNamespaceId`, if any. */
export const installedExternalIdentityProviderOf = (
  installed: ShellInstalledCatalog,
  authenticationNamespaceId: string,
): Option.Option<InstalledExternalIdentityProvider> => {
  for (const module of installed.composition.modules) {
    const declaration = Option.flatMapNullishOr(decodeContractProviders(module.contractDocument), (contract) =>
      contract.manifest.publicSurface.externalIdentityProviders?.find(
        (provider) => provider.authenticationNamespaceId === authenticationNamespaceId,
      ),
    );
    if (Option.isSome(declaration)) {
      return Option.some({
        appId: module.deployment.appId,
        backendBaseUrl: module.backend.baseUrl,
        declaration: declaration.value,
      });
    }
  }
  return Option.none();
};

const distinct = (values: readonly string[]): readonly string[] => [...new Set(values)];

/** Core consumes this registration; the Shell merges it behind the staff registry. */
export const externalIdentityProviderRegistrationOf = (
  configuration: ExternalIdentityProviderConfiguration,
  declaration: OntosExternalIdentityProvider,
): AuthenticationNamespaceRegistration =>
  Result.getOrThrow(
    Schema.decodeResult(AuthenticationNamespaceRegistrationSchema)({
      allowedAudiences: distinct([
        configuration.providerEndpointAudience,
        ...configuration.grants.flatMap(({ targetAudience }) => (targetAudience === undefined ? [] : [targetAudience])),
      ]),
      authenticationNamespaceId: configuration.authenticationNamespaceId,
      provider: declaration.provider,
      requiresOperationAdmission: true,
      reservationPrincipalKind: 'human',
      subjectTypes: ['user'],
      trustedAttesterPrincipalIds: [configuration.attesterPrincipalId],
    }),
  );
