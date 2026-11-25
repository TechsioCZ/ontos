import { Context } from 'effect';
import type { GatewayNativeEvidenceOperations } from './gateway-native-evidence.service.ts';

/** Fresh native admission facts, never caller-controlled queries or database handles. */
export class GatewayNativeEvidence extends Context.Service<GatewayNativeEvidence, GatewayNativeEvidenceOperations>()(
  '@app/shell-super-app/api/auth/gateway-native-evidence/GatewayNativeEvidence',
) {}
