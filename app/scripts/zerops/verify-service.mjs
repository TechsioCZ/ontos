// Run the existing mandatory probe contract without making app proofs wait for a storefront deployment.
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Option } from 'effect';
import { Argument, Command } from 'effect/cli';

import { StageVerificationFailure, verifyStage } from '../ops/stage-demo-verify.mjs';

const verifyService = Command.make(
  'verify-service',
  {
    // Each verified service with the variable naming its storefront origin; the app has none.
    service: Argument.ChoiceWithValue('service', [
      ['app', { name: 'app', origin: Option.none() }],
      ['n1', { name: 'n1', origin: Option.some('STAGE_N1_URL') }],
      ['shop', { name: 'shop', origin: Option.some('STAGE_SHOP_URL') }],
      ['storefront', { name: 'storefront', origin: Option.some('STAGE_STOREFRONT_URL') }],
    ]),
  },
  ({ service: { name, origin } }) =>
    Effect.gen(function* verifyServiceProgram() {
      const shellUrl = yield* Config.String('STAGE_SHELL_URL');
      const storefrontUrl = Option.isNone(origin) ? shellUrl : yield* Config.String(origin.value);
      const { failures, warnings } = yield* verifyStage({
        shellUrl,
        storefrontUrl,
        storefrontUrls: Option.isNone(origin) ? [] : [storefrontUrl],
      });
      yield* Effect.forEach(warnings, (warning) => Console.log(`::warning title=Stage page budget::${warning}`), {
        discard: true,
      });
      if (failures.length > 0) {
        return yield* Effect.fail(
          new StageVerificationFailure(
            'stage verification',
            'summary',
            `stage verification FAILED: ${failures.map((failure) => failure.message).join('; ')}`,
          ),
        );
      }
      return yield* Console.log(`stage verification PASS (${name})`);
    }),
);

NodeRuntime.runMain(Command.run(verifyService, { version: '1.0.0' }).pipe(Effect.provide(NodeServices.layer)), {
  disableErrorReporting: false,
});
