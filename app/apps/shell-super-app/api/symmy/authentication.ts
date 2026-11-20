import { GatewayInternalProblemSchema } from '@app/shared-contracts';
import { HttpApiMiddleware, HttpApiSecurity } from 'effect/http-api';

import type { SymmyAdmittedCaller } from './admitted-caller.ts';
import { ingressProblems } from './contract.ts';

/** Every Symmy route verifies the API key and admits its workload before any path, header, query or body is decoded. */
export class SymmyAuthentication extends HttpApiMiddleware.Service<
  SymmyAuthentication,
  { provides: SymmyAdmittedCaller }
>()('@app/shell-super-app/api/symmy/authentication/SymmyAuthentication', {
  error: [...ingressProblems, GatewayInternalProblemSchema],
  security: { apiKey: HttpApiSecurity.apiKey({ in: 'header', key: 'x-api-key' }) },
}) {}
