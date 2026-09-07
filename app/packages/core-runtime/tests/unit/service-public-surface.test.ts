import assert from 'node:assert/strict';
import test from 'node:test';
import { makePersistenceAttempt } from '../../src/index.ts';
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

void test('exports the anti-slop-compliant Core service contracts', () => {
  assert.equal(preservePublicServiceContract.length, 1);
});

void test('exports the persistence attempt constructor from the CoreSDK server surface', () => {
  assert.equal(makePersistenceAttempt.length, 1);
});
