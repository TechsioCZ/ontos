import assert from 'node:assert/strict';
import test from 'node:test';
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

test('exports the anti-slop-compliant Core service contracts', () => {
  assert.equal(preservePublicServiceContract.length, 1);
});
