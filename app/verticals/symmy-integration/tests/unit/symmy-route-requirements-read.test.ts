import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SymmyRouteRequirementsRequestSchema } from '../../shared/apis/symmy-route-requirements.ts';
import { symmyRouteRequirementsRead } from '../../src/api/symmy-route-requirements.read.ts';
import { symmyIntegrationManifest } from '../../vertical.manifest.ts';

describe('integration.symmy.api.symmy-route-requirements', () => {
  it('is a protected read of the Symmy route permission in the selected company, registered with the module', () => {
    const { descriptor } = symmyRouteRequirementsRead;
    expect(descriptor.accessDeclaration?.key).toBe('integration.symmy.symmy-routes.read');
    expect(descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
    expect(descriptor.legalEntityScope).toBe('required');
    expect(symmyIntegrationManifest.publicSurface?.operationContracts).toContainEqual({
      apiKey: 'symmy-route-requirements',
      operationKey: 'symmyRouteRequirements.execute',
      registration: symmyRouteRequirementsRead,
    });
  });

  it('takes the same enable changes the Action is sent, and only those', () => {
    const decode = Schema.decodeUnknownResult(SymmyRouteRequirementsRequestSchema);
    const source = { issuerId: 'symmy-akros', sourceNamespace: 'akros-erp' };
    const integrationPrincipalId = '44444444-4444-4444-8444-444444444444';
    expect(
      decode({
        changes: [{ kind: 'enable', routeKey: 'productsBatch', settings: { retentionDays: 30, source } }],
        integrationPrincipalId,
      })._tag,
    ).toBe('Success');
    expect(
      decode({
        changes: [{ expectedChangeToken: 3, kind: 'disable', routeKey: 'productsBatch' }],
        integrationPrincipalId,
      })._tag,
    ).toBe('Failure');
    expect(decode({ changes: [], integrationPrincipalId })._tag).toBe('Failure');
  });
});
