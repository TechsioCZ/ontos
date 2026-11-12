import { Schema } from 'effect';

/**
 * Launch capability matrix (#1154, #1159). An UNSUPPORTED capability yields a typed
 * `GatewayProviderUnsupported`, never a fallback to another provider or operation.
 */

export const GATEWAY_CAPABILITY_SUPPORT = ['SUPPORTED', 'UNSUPPORTED'] as const;
export const GatewayCapabilitySupportSchema = Schema.Literals(GATEWAY_CAPABILITY_SUPPORT);

export const GatewayCapabilityRowSchema = Schema.Struct({
  CANCEL_OR_VOID: GatewayCapabilitySupportSchema,
  COLLECT: GatewayCapabilitySupportSchema,
  NOTIFICATION: GatewayCapabilitySupportSchema,
  REFUND: GatewayCapabilitySupportSchema,
  RETRIEVE: GatewayCapabilitySupportSchema,
});
export type GatewayCapabilityRow = typeof GatewayCapabilityRowSchema.Type;

export const GatewayCapabilityMatrixSchema = Schema.Struct({
  COMGATE: GatewayCapabilityRowSchema,
  GOPAY: GatewayCapabilityRowSchema,
  STRIPE: GatewayCapabilityRowSchema,
});
export type GatewayCapabilityMatrix = typeof GatewayCapabilityMatrixSchema.Type;

/** Every Launch family supports every capability; GoPay cancels through Payments API v4 `DELETE /payments/{id}` (plan D-P1). */
export const GATEWAY_LAUNCH_CAPABILITIES: GatewayCapabilityMatrix = {
  COMGATE: {
    CANCEL_OR_VOID: 'SUPPORTED',
    COLLECT: 'SUPPORTED',
    NOTIFICATION: 'SUPPORTED',
    REFUND: 'SUPPORTED',
    RETRIEVE: 'SUPPORTED',
  },
  GOPAY: {
    CANCEL_OR_VOID: 'SUPPORTED',
    COLLECT: 'SUPPORTED',
    NOTIFICATION: 'SUPPORTED',
    REFUND: 'SUPPORTED',
    RETRIEVE: 'SUPPORTED',
  },
  STRIPE: {
    CANCEL_OR_VOID: 'SUPPORTED',
    COLLECT: 'SUPPORTED',
    NOTIFICATION: 'SUPPORTED',
    REFUND: 'SUPPORTED',
    RETRIEVE: 'SUPPORTED',
  },
};
