import type { GatewayContextClientEffect, GatewayContextClientOptions, GatewayContextResponse } from '@app/shared-contracts';
import { Effect } from 'effect';
export declare const ACTION_GATEWAY_AUDIENCE: 'crm';
export type ActionGatewayIssuer = (payload: {
    readonly audience: typeof ACTION_GATEWAY_AUDIENCE;
}, options?: GatewayContextClientOptions) => GatewayContextClientEffect<GatewayContextResponse>;
export type ActionGatewayAttempt<Success, Failure> = (authorization: string) => Effect.Effect<Success, Failure>;
export declare const makeActionGateway: (acquire?: ActionGatewayIssuer) => {
    invoke: <Success, Failure>(attempt: ActionGatewayAttempt<Success, Failure>, options?: GatewayContextClientOptions) => Effect.Effect<Success, Failure | import("@app/shared-contracts").GatewayContextClientError, never>;
};
export declare const actionGateway: {
    invoke: <Success, Failure>(attempt: ActionGatewayAttempt<Success, Failure>, options?: GatewayContextClientOptions) => Effect.Effect<Success, Failure | import("@app/shared-contracts").GatewayContextClientError, never>;
};
export declare const makeOperationGateway: typeof makeActionGateway;
export declare const operationGateway: {
    invoke: <Success, Failure>(attempt: ActionGatewayAttempt<Success, Failure>, options?: GatewayContextClientOptions) => Effect.Effect<Success, Failure | import("@app/shared-contracts").GatewayContextClientError, never>;
};
