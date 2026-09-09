import { Layer } from 'effect';

import {
  CustomerContextGatewayCredentialService,
  unavailableCustomerContextGatewayCredentialIssuer,
} from '../shared/domain/customer-context-gateway-credential.ts';

/** Explicit local/default issuer; deployment composition must replace it with trusted issuance. */
export const unavailableCustomerContextGatewayCredentialLive = Layer.succeed(
  CustomerContextGatewayCredentialService,
  unavailableCustomerContextGatewayCredentialIssuer,
);
