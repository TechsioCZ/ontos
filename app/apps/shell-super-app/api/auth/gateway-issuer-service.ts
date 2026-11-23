import type { GatewayContextResponse, GatewayRefusalReason } from '@app/shared-contracts';
import { Context, Effect } from 'effect';

import type { DocumentGatewayAssertion } from '../../shared/document-gateway-api.ts';
import type { GatewayIssuerError, IssueGatewayAssertionInput } from './gateway-issuer.ts';

type IssueSymmyGatewayAssertionInput<Principal> = Pick<
  IssueGatewayAssertionInput<Principal>,
  'compositionRevision' | 'principal'
> & { readonly principalKind: string };

export interface IssueDocumentGatewayAssertionsInput<Principal> {
  readonly audiences: readonly string[];
  readonly compositionRevision: string;
  readonly principal: Principal;
}

export interface GatewayIssuerService {
  readonly issue: <Principal>(
    input: IssueGatewayAssertionInput<Principal>,
  ) => Effect.Effect<GatewayContextResponse, GatewayIssuerError>;
  readonly issueDocument: <Principal>(
    input: IssueDocumentGatewayAssertionsInput<Principal>,
  ) => Effect.Effect<readonly DocumentGatewayAssertion[], GatewayIssuerError>;
  readonly issueSymmy: <Principal>(
    input: IssueSymmyGatewayAssertionInput<Principal>,
  ) => Effect.Effect<GatewayContextResponse, GatewayIssuerError>;
}

export class GatewayIssuer extends Context.Service<GatewayIssuer, GatewayIssuerService>()(
  '@app/shell-super-app/api/auth/gateway-issuer-service/GatewayIssuer',
) {}

/**
 * The refusal code a caller logs for an issuer failure: a scope grant the database would not register is the scope's
 * step, every other unavailable step is the issuer's.
 */
export const gatewayIssuerRefusalReason = (error: GatewayIssuerError): GatewayRefusalReason =>
  error.stage === 'scope_grant' ? 'scope_unavailable' : 'issuer_unavailable';

export const issueSymmyGatewayContextAssertion = Effect.fn('GatewayIssuer.issueSymmyGatewayContextAssertion')(
  function* issueSymmyGatewayContextAssertionEffect<Principal>(input: IssueSymmyGatewayAssertionInput<Principal>) {
    return yield* (yield* GatewayIssuer).issueSymmy(input);
  },
);
