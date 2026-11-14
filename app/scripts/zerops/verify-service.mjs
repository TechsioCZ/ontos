// Run the existing mandatory probe contract without making app proofs wait for a storefront deployment.
import { NodeRuntime } from '@effect/platform-node';
import { Config, Console, Effect } from 'effect';
import { verifyStage, StageVerificationFailure } from '../ops/stage-demo-verify.mjs';

const service = process.argv[2];
const origins = { storefront: 'STAGE_STOREFRONT_URL', shop: 'STAGE_SHOP_URL', n1: 'STAGE_N1_URL' };
NodeRuntime.runMain(Effect.gen(function* verifyService() {
  const shellUrl = yield* Config.String('STAGE_SHELL_URL');
  const variable = origins[service];
  if (service !== 'app' && variable === undefined) {
    return yield* Effect.fail(new StageVerificationFailure('service', 'summary', 'Unknown verification service'));
  }
  const storefrontUrl = variable === undefined ? shellUrl : yield* Config.String(variable);
  const { failures, warnings } = yield* verifyStage({
    shellUrl, storefrontUrl, storefrontUrls: service === 'app' ? [] : [storefrontUrl],
  });
  for (const warning of warnings) yield* Console.log(`::warning title=Stage page budget::${warning}`);
  if (failures.length > 0) {
    return yield* Effect.fail(new StageVerificationFailure('stage verification', 'summary',
      `stage verification FAILED: ${failures.map((failure) => failure.message).join('; ')}`));
  }
  yield* Console.log(`stage verification PASS (${service})`);
}), { disableErrorReporting: false });
