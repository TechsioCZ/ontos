#!/usr/bin/env bash
# Download this reviewed file by immutable commit and verify its SHA256 before running it.
# A new container needs only the same download command, never a copied multiline program.
set +x
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: bash repair-n1-portal-module-stage.sh [check]
       bash repair-n1-portal-module-stage.sh apply <fingerprint>

Stage only: fixed N1 tenant and commerce.customer-context module.
The default check authenticates the existing N1 administrator and reports the
current state, authority decision and exact activation plan. It does not activate.
Apply requires that plan's fingerprint and uses the public Core Action, its
permission checks, compare-and-set, idempotency and persisted-state verification.
The administrator password is requested without echo; no new key is generated.
USAGE
}

if [[ "${1:-}" == '--help' && "$#" -eq 1 ]]; then
  usage
  exit 0
fi

mode="${1:-check}"
if [[ "$mode" == check && "$#" -le 1 ]]; then
  :
elif [[ "$mode" == apply && "$#" -eq 2 && "${2:-}" =~ ^[a-f0-9]{64}$ ]]; then
  :
else
  printf '%s\n' 'INVALID_ARGUMENTS: use check, or apply <fingerprint>.' >&2
  exit 64
fi

if [[ "${ULTRAMODERN_DEPLOYMENT_ENVIRONMENT:-}" != stage || "${ONTOS_PUBLIC_ORIGIN:-}" != 'https://ontos-stage.web-revolution.cz' ]]; then
  printf '%s\n' 'STAGE_ONLY: this operator is restricted to the existing Stage host.' >&2
  exit 78
fi

if ! cd /var/www/app; then
  printf '%s\n' 'APP_ROOT_UNAVAILABLE: run inside the app service container.' >&2
  exit 78
fi

export ONTOS_AGENT_SETUP_EMAIL='admin@n1.ontos.demo'
export N1_MODULE_ACTIVATION_MODE="$mode"
unset N1_MODULE_ACTIVATION_REVIEWED_SHA256
if [[ "$mode" == apply ]]; then
  export N1_MODULE_ACTIVATION_REVIEWED_SHA256="$2"
fi
trap 'unset ONTOS_AGENT_SETUP_PASSWORD N1_MODULE_ACTIVATION_REVIEWED_SHA256' EXIT

if [[ -z "${ONTOS_AGENT_SETUP_PASSWORD:-}" ]]; then
  if ! IFS= read -r -s -p 'Heslo správce N1: ' ONTOS_AGENT_SETUP_PASSWORD </dev/tty; then
    printf '%s\n' 'INTERACTIVE_PASSWORD_REQUIRED: no password was read.' >&2
    exit 78
  fi
  printf '\n' >/dev/tty
fi
export ONTOS_AGENT_SETUP_PASSWORD

node --input-type=module <<'N1_CORE_OPERATOR'
const q=process.env;if(q.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT!=="stage"||q.ONTOS_PUBLIC_ORIGIN!=="https://ontos-stage.web-revolution.cz"){console.log("STAGE_ONLY");process.exit(1)}let z;try{z=JSON.parse(q.ONTOS_OWNER_SECRETS_JSON??"{}")?.["shell-super-app"]?.BETTER_AUTH_SECRET}catch{}if(typeof z!=="string"||z.trim().length<32){console.log("SHELL_AUTH_CONFIGURATION_UNAVAILABLE");process.exit(1)}q.BETTER_AUTH_URL=q.ONTOS_PUBLIC_ORIGIN;q.BETTER_AUTH_SECRET=z;q.BETTER_AUTH_TRUSTED_ORIGINS=[q.ONTOS_PUBLIC_ORIGIN,q.ONTOS_STOREFRONT_ORIGIN,q.ONTOS_SHOP_STOREFRONT_ORIGIN].filter(Boolean).join(",");q.ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL="http://127.0.0.1:3001/_host/composition";

import { createHash, randomUUID } from 'node:crypto';
import { Effect, Schema } from 'effect';
import { NodeServices } from '@effect/platform-node';
import { ActionRuntime, changeTenantModuleStateAction, makeTenantModuleStateService } from '@app/core-runtime';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { ActionAuthority } from '@app/core-runtime/actions/runtime-wiring';
import { OperationalScopeResolver } from '@app/core-runtime/operations/context';
import { ActiveApplicationCompositionService, loadActiveApplicationComposition } from '@app/core-runtime/modules/active-application-composition';
import { StageMarketOperatorLive } from './scripts/demo/activate-market-stage.mts';
import { authenticateAgentProfileOperator } from './scripts/demo/agent-profile-operator.mts';
import { ProcessDatabasePoolsLive } from './scripts/zerops/process-database-pools.mts';

class Stopped extends Schema.TaggedError()('N1ModuleActivationStopped', {
  code: Schema.Literals(['scope_mismatch', 'lifecycle_mismatch', 'permission_denied', 'plan_mismatch', 'state_unconfirmed'])
}) {}
const tenantId = 'cfcd7ae8-90b9-4c49-927c-b5d66224a618';
const principalId = '6f78d366-1c9d-4d37-82ff-2fe2c6fe7e15';
const moduleKey = 'commerce.customer-context';
const mode = process.env.N1_MODULE_ACTIVATION_MODE ?? 'check';
let phase = 'setup';
const program = Effect.gen(function* () {
  phase = 'authentication';
  const operator = yield* Effect.acquireRelease(authenticateAgentProfileOperator, (s) => s.close.pipe(Effect.ignore));
  const principal = operator.principal;
  if (principal.tenantId !== tenantId || principal.principalId !== principalId || principal.authMethod !== 'session' || principal.legalEntityId !== undefined) {
    return yield* new Stopped({ code: 'scope_mismatch' });
  }
  phase = 'state-read';
  const states = makeTenantModuleStateService(yield* CoreDatabase);
  const current = (yield* states.getTenantModuleStates(tenantId, [moduleKey]))[0]?.state ?? 'missing';
  if (!['missing', 'inactive', 'active'].includes(current)) {
    return yield* new Stopped({ code: 'lifecycle_mismatch' });
  }
  const snapshot = yield* loadActiveApplicationComposition(yield* ActiveApplicationCompositionService);
  const payload = { expectedState: 'inactive', moduleKey, newState: 'active', reason: 'Repair the confirmed missing N1 portal enrollment module activation' };
  const plan = { actionKey: changeTenantModuleStateAction.descriptor.actionKey, tenantId, principalId, compositionRevision: snapshot.composition.revision, payload };
  const fingerprint = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  phase = 'authority';
  const scope = yield* (yield* OperationalScopeResolver).resolve({ correlationId: randomUUID(), legalEntityScope: 'forbidden', principal });
  const decisions = yield* (yield* ActionAuthority).checkActionAuthorities({ actionKeys: [plan.actionKey], scope });
  if (decisions.length !== 1 || decisions[0]?.actionKey !== plan.actionKey || decisions[0].execute !== 'allowed') {
    return yield* new Stopped({ code: 'permission_denied' });
  }
  if (mode === 'check') return { mode, ...plan, state: current, fingerprint, execute: 'allowed' };
  if (process.env.N1_MODULE_ACTIVATION_REVIEWED_SHA256 !== fingerprint) {
    return yield* new Stopped({ code: 'plan_mismatch' });
  }
  if (current !== 'active') {
    phase = 'action';
    yield* (yield* ActionRuntime).runAction({
      payload, principal, registration: changeTenantModuleStateAction,
      transport: { correlationId: randomUUID(), idempotencyKey: `n1-portal-module-activation:${fingerprint}` }
    });
  }
  phase = 'verification';
  const state = (yield* states.getTenantModuleStates(tenantId, [moduleKey]))[0]?.state ?? 'missing';
  if (state !== 'active') return yield* new Stopped({ code: 'state_unconfirmed' });
  return { mode, tenantId, moduleKey, state, fingerprint };
});
if (process.env.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT !== 'stage' || !['check', 'apply'].includes(mode)) {
  console.log('STAGE_ONLY');
  process.exitCode = 1;
} else {
  const guarded = program.pipe(
    Effect.scoped,
    Effect.provide(StageMarketOperatorLive),
    Effect.provide(ProcessDatabasePoolsLive),
    Effect.provide(NodeServices.layer),
    Effect.timeout('60 seconds'),
    Effect.match({
      onFailure: (failure) => { process.exitCode = 1; return { status: 'NOT_CONFIRMED', phase, code: Schema.is(Stopped)(failure) ? failure.code : 'operation_unavailable' }; },
      onSuccess: (result) => result
    })
  );
  try { console.log(JSON.stringify(await Effect.runPromise(guarded), null, 2)); }
  catch { console.log(JSON.stringify({ status: 'NOT_CONFIRMED', phase, code: 'operation_unavailable' })); process.exitCode = 1; }
}
N1_CORE_OPERATOR
