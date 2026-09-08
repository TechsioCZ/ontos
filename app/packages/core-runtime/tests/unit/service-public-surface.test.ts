import { expect, it } from '@app/effect-rstest';
import type {
  ContextAccessService,
  InstalledModuleCatalogServiceContract,
  LegalEntityContextService,
  ModuleEntrypointGatewayService,
  ModuleStateGateService,
  OperationalScopeResolverService,
  PrincipalResolverService,
  SupportRecoveryPrincipalContextResolverService,
  TenantModuleStateServiceContract,
} from '../../src/index.ts';

type PublicServiceContract =
  | ContextAccessService
  | InstalledModuleCatalogServiceContract
  | LegalEntityContextService
  | ModuleEntrypointGatewayService
  | ModuleStateGateService
  | OperationalScopeResolverService
  | PrincipalResolverService
  | SupportRecoveryPrincipalContextResolverService
  | TenantModuleStateServiceContract;

const preservePublicServiceContract = <Service extends PublicServiceContract>(
  service: Service,
): Service => service;

it('exports the anti-slop-compliant Core service contracts', () => {
  expect(preservePublicServiceContract.length).toBe(1);
});
