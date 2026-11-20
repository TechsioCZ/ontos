// Run the existing mandatory probe contract without making app proofs wait for a storefront deployment.
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Option } from 'effect';
import { Argument, Command } from 'effect/cli';

import { StageVerificationFailure, verifyStage } from '../ops/stage-demo-verify.mjs';

const SYMMY_INGRESS_PROBE = '/api/symmy/v1/admin/products';
/**
 * The Shell mounts the Symmy REST ingress (ONTOS_INTERNAL_SYMMY_INGRESS in zerops.yaml's app build): a caller without a
 * key gets the ingress's own 401 problem with the API key challenge, never a redirect into the web app or its HTML.
 * @param {string} shellUrl The live Shell origin.
 */
const symmyIngressFailures = (shellUrl) =>
  Effect.tryPromise({
    catch: (cause) =>
      new StageVerificationFailure('Symmy ingress', 'transport', `${SYMMY_INGRESS_PROBE} failed: ${String(cause)}`),
    try: async () =>
      await fetch(new URL(SYMMY_INGRESS_PROBE, shellUrl), { redirect: 'manual', signal: AbortSignal.timeout(20_000) }),
  }).pipe(
    Effect.match({
      onFailure: (failure) => [failure],
      onSuccess: (response) => {
        const contentType = response.headers.get('content-type') ?? 'none';
        const location = response.headers.get('location');
        const redirectedTo = location === null ? '' : ` to ${location}`;
        return [
          ...(response.status === 401 ? [] : [`answered ${response.status}${redirectedTo}, not 401`]),
          ...(contentType.startsWith('application/problem+json') ? [] : [`answered content-type ${contentType}`]),
          ...(response.headers.get('www-authenticate')?.startsWith('ApiKey ') === true
            ? []
            : ['answered without the ApiKey challenge']),
        ].map(
          (problem) => new StageVerificationFailure('Symmy ingress', 'status', `${SYMMY_INGRESS_PROBE} ${problem}`),
        );
      },
    }),
  );

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
      const stage = yield* verifyStage({
        shellUrl,
        storefrontUrl,
        storefrontUrls: Option.isNone(origin) ? [] : [storefrontUrl],
      });
      const { warnings } = stage;
      const failures = [...stage.failures, ...(Option.isNone(origin) ? yield* symmyIngressFailures(shellUrl) : [])];
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
