import { Schema } from 'effect';

/**
 * Launch capability matrix (#1154, #1159). An UNSUPPORTED capability yields a typed
 * `GatewayProviderUnsupported`, never a fallback to another provider or operation.
 */

export const GATEWAY_CAPABILITY_SUPPORT = ['SUPPORTED', 'UNSUPPORTED'] as const;
export const GatewayCapabilitySupportSchema = Schema.Literals(GATEWAY_CAPABILITY_SUPPORT);
export type GatewayCapabilitySupport = typeof GatewayCapabilitySupportSchema.Type;

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

/** GoPay has no cancel API for a standard payment (plan N8). Comgate is built but not enableable (N9). */
export const GATEWAY_LAUNCH_CAPABILITIES: GatewayCapabilityMatrix = {
  COMGATE: {
    CANCEL_OR_VOID: 'SUPPORTED',
    COLLECT: 'SUPPORTED',
    NOTIFICATION: 'SUPPORTED',
    REFUND: 'SUPPORTED',
    RETRIEVE: 'SUPPORTED',
  },
  GOPAY: {
    CANCEL_OR_VOID: 'UNSUPPORTED',
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
