import { eslintCompatPlugin } from '@oxlint/plugins';

import { rule as noAdHocArgvInScripts } from './rules/no-ad-hoc-argv-in-scripts.ts';
import { rule as noAmbientDate } from './rules/no-ambient-date.ts';
import { rule as noAmbientProcessEnv } from './rules/no-ambient-process-env.ts';
import { rule as noAsyncScriptProgram } from './rules/no-async-script-program.ts';
import { rule as noBareEffectRun } from './rules/no-bare-effect-run.ts';
import { rule as noConsoleInScripts } from './rules/no-console-in-scripts.ts';
import { rule as noDependencyParameters } from './rules/no-dependency-parameters.ts';
import { rule as noDirectNodeIoInScripts } from './rules/no-direct-node-io-in-scripts.ts';
import { rule as noDotenvLoading } from './rules/no-dotenv-loading.ts';
import { rule as noDriverFailureInspection } from './rules/no-driver-failure-inspection.ts';
import { rule as noDuplicateLiteralVocabulary } from './rules/no-duplicate-literal-vocabulary.ts';
import { rule as noEffectProvideInLibrary } from './rules/no-effect-provide-in-library.ts';
import { rule as noEffectRunInScripts } from './rules/no-effect-run-in-scripts.ts';
import { rule as noEffectRunInTests } from './rules/no-effect-run-in-tests.ts';
import { rule as noEnvironmentRecordType } from './rules/no-environment-record-type.ts';
import { rule as noFailureDiscardingErrorCallback } from './rules/no-failure-discarding-error-callback.ts';
import { rule as noHandBuiltHttpServerInTests } from './rules/no-hand-built-http-server-in-tests.ts';
import { rule as noHandBuiltProblemDetails } from './rules/no-hand-built-problem-details.ts';
import { rule as noHandParsedEnvironmentValue } from './rules/no-hand-parsed-environment-value.ts';
import { rule as noHandRolledTaggedUnion } from './rules/no-hand-rolled-tagged-union.ts';
import { rule as noImperativeLoopInEffectGen } from './rules/no-imperative-loop-in-effect-gen.ts';
import { rule as noInterfaceFirstCodec } from './rules/no-interface-first-codec.ts';
import { rule as noJsonSchemaAsDocumentContract } from './rules/no-json-schema-as-document-contract.ts';
import { rule as noLayerFresh } from './rules/no-layer-fresh.ts';
import { rule as noLayerOrDieOutsideRoot } from './rules/no-layer-or-die-outside-root.ts';
import { rule as noLayerProvideInLibrary } from './rules/no-layer-provide-in-library.ts';
import { rule as noLiteralUnionTypeAlias } from './rules/no-literal-union-type-alias.ts';
import { rule as noLocalDefectSeam } from './rules/no-local-defect-seam.ts';
import { rule as noManualConfigInScaffoldTemplates } from './rules/no-manual-config-in-scaffold-templates.ts';
import { rule as noManualCookieSerialization } from './rules/no-manual-cookie-serialization.ts';
import { rule as noManualErrorHandlingInScaffoldTemplates } from './rules/no-manual-error-handling-in-scaffold-templates.ts';
import { rule as noManualIdentityAnnotations } from './rules/no-manual-identity-annotations.ts';
import { rule as noManualRouteParamParsing } from './rules/no-manual-route-param-parsing.ts';
import { rule as noManualTagComparison } from './rules/no-manual-tag-comparison.ts';
import { rule as noNativeErrorConstruction } from './rules/no-native-error-construction.ts';
import { rule as noNativeJsonParse } from './rules/no-native-json-parse.ts';
import { rule as noNativeJsonStringify } from './rules/no-native-json-stringify.ts';
import { rule as noNativeTimers } from './rules/no-native-timers.ts';
import { rule as noNestedEffectRun } from './rules/no-nested-effect-run.ts';
import { rule as noNullableSchemaField } from './rules/no-nullable-schema-field.ts';
import { rule as noNullableServiceOutcome } from './rules/no-nullable-service-outcome.ts';
import { rule as noPerOperationHttpApiClient } from './rules/no-per-operation-http-api-client.ts';
import { rule as noPerRequestKeyMaterial } from './rules/no-per-request-key-material.ts';
import { rule as noProcessExitOutsideScriptEntry } from './rules/no-process-exit-outside-script-entry.ts';
import { rule as noPromiseFirstScaffoldTemplates } from './rules/no-promise-first-scaffold-templates.ts';
import { rule as noPromiseShapedPort } from './rules/no-promise-shaped-port.ts';
import { rule as noRawEffectAdtTagCheck } from './rules/no-raw-effect-adt-tag-check.ts';
import { rule as noRefinementOutsideSchema } from './rules/no-refinement-outside-schema.ts';
import { rule as noRouteLocalErrorClassifier } from './rules/no-route-local-error-classifier.ts';
import { rule as noRuntimeConstructionOutsideRoot } from './rules/no-runtime-construction-outside-root.ts';
import { rule as noScatteredBrowserEffectRun } from './rules/no-scattered-browser-effect-run.ts';
import { rule as noSequentialIndependentYields } from './rules/no-sequential-independent-yields.ts';
import { rule as noStringTimestampSchema } from './rules/no-string-timestamp-schema.ts';
import { rule as noStructuralDocumentWalking } from './rules/no-structural-document-walking.ts';
import { rule as noSymbolSlottedOperationRecord } from './rules/no-symbol-slotted-operation-record.ts';
import { rule as noSyncSchemaCodec } from './rules/no-sync-schema-codec.ts';
import { rule as noThreadedCorrelationParameter } from './rules/no-threaded-correlation-parameter.ts';
import { rule as noThrowInConfigurationParser } from './rules/no-throw-in-configuration-parser.ts';
import { rule as noThrowInEffectCallback } from './rules/no-throw-in-effect-callback.ts';
import { rule as noThrowInScripts } from './rules/no-throw-in-scripts.ts';
import { rule as noUnbrandedIdentifierSchema } from './rules/no-unbranded-identifier-schema.ts';
import { rule as noUnjustifiedFileWideLintSuppression } from './rules/no-unjustified-file-wide-lint-suppression.ts';
import { rule as noUnmanagedMutableState } from './rules/no-unmanaged-mutable-state.ts';
import { rule as noUnredactedSecretField } from './rules/no-unredacted-secret-field.ts';
import { rule as noWideFactorySignature } from './rules/no-wide-factory-signature.ts';
import { rule as preferEffectFnForOperations } from './rules/prefer-effect-fn-for-operations.ts';
import { rule as preferMatchOverTagSwitch } from './rules/prefer-match-over-tag-switch.ts';
import { rule as requireConcurrencyOption } from './rules/require-concurrency-option.ts';
import { rule as requireContextServiceForServiceInterface } from './rules/require-context-service-for-service-interface.ts';
import { rule as requireObservabilityLayersAtRuntimeRoot } from './rules/require-observability-layers-at-runtime-root.ts';
import { rule as requireTimeoutOnExternalEffect } from './rules/require-timeout-on-external-effect.ts';

/** Audit-derived diagnostic rules; application code is never autofixed. */
const effectNativePlugin = eslintCompatPlugin({
  meta: { name: 'effect-native' },
  rules: {
    'no-ad-hoc-argv-in-scripts': noAdHocArgvInScripts,
    'no-ambient-date': noAmbientDate,
    'no-ambient-process-env': noAmbientProcessEnv,
    'no-async-script-program': noAsyncScriptProgram,
    'no-bare-effect-run': noBareEffectRun,
    'no-console-in-scripts': noConsoleInScripts,
    'no-dependency-parameters': noDependencyParameters,
    'no-direct-node-io-in-scripts': noDirectNodeIoInScripts,
    'no-dotenv-loading': noDotenvLoading,
    'no-driver-failure-inspection': noDriverFailureInspection,
    'no-duplicate-literal-vocabulary': noDuplicateLiteralVocabulary,
    'no-effect-provide-in-library': noEffectProvideInLibrary,
    'no-effect-run-in-scripts': noEffectRunInScripts,
    'no-effect-run-in-tests': noEffectRunInTests,
    'no-environment-record-type': noEnvironmentRecordType,
    'no-failure-discarding-error-callback': noFailureDiscardingErrorCallback,
    'no-hand-built-http-server-in-tests': noHandBuiltHttpServerInTests,
    'no-hand-built-problem-details': noHandBuiltProblemDetails,
    'no-hand-parsed-environment-value': noHandParsedEnvironmentValue,
    'no-hand-rolled-tagged-union': noHandRolledTaggedUnion,
    'no-imperative-loop-in-effect-gen': noImperativeLoopInEffectGen,
    'no-interface-first-codec': noInterfaceFirstCodec,
    'no-json-schema-as-document-contract': noJsonSchemaAsDocumentContract,
    'no-layer-fresh': noLayerFresh,
    'no-layer-or-die-outside-root': noLayerOrDieOutsideRoot,
    'no-layer-provide-in-library': noLayerProvideInLibrary,
    'no-literal-union-type-alias': noLiteralUnionTypeAlias,
    'no-local-defect-seam': noLocalDefectSeam,
    'no-manual-config-in-scaffold-templates': noManualConfigInScaffoldTemplates,
    'no-manual-cookie-serialization': noManualCookieSerialization,
    'no-manual-error-handling-in-scaffold-templates': noManualErrorHandlingInScaffoldTemplates,
    'no-manual-identity-annotations': noManualIdentityAnnotations,
    'no-manual-route-param-parsing': noManualRouteParamParsing,
    'no-manual-tag-comparison': noManualTagComparison,
    'no-native-error-construction': noNativeErrorConstruction,
    'no-native-json-parse': noNativeJsonParse,
    'no-native-json-stringify': noNativeJsonStringify,
    'no-native-timers': noNativeTimers,
    'no-nested-effect-run': noNestedEffectRun,
    'no-nullable-schema-field': noNullableSchemaField,
    'no-nullable-service-outcome': noNullableServiceOutcome,
    'no-per-operation-http-api-client': noPerOperationHttpApiClient,
    'no-per-request-key-material': noPerRequestKeyMaterial,
    'no-process-exit-outside-script-entry': noProcessExitOutsideScriptEntry,
    'no-promise-first-scaffold-templates': noPromiseFirstScaffoldTemplates,
    'no-promise-shaped-port': noPromiseShapedPort,
    'no-raw-effect-adt-tag-check': noRawEffectAdtTagCheck,
    'no-refinement-outside-schema': noRefinementOutsideSchema,
    'no-route-local-error-classifier': noRouteLocalErrorClassifier,
    'no-runtime-construction-outside-root': noRuntimeConstructionOutsideRoot,
    'no-scattered-browser-effect-run': noScatteredBrowserEffectRun,
    'no-sequential-independent-yields': noSequentialIndependentYields,
    'no-string-timestamp-schema': noStringTimestampSchema,
    'no-structural-document-walking': noStructuralDocumentWalking,
    'no-symbol-slotted-operation-record': noSymbolSlottedOperationRecord,
    'no-sync-schema-codec': noSyncSchemaCodec,
    'no-threaded-correlation-parameter': noThreadedCorrelationParameter,
    'no-throw-in-configuration-parser': noThrowInConfigurationParser,
    'no-throw-in-effect-callback': noThrowInEffectCallback,
    'no-throw-in-scripts': noThrowInScripts,
    'no-unbranded-identifier-schema': noUnbrandedIdentifierSchema,
    'no-unjustified-file-wide-lint-suppression': noUnjustifiedFileWideLintSuppression,
    'no-unmanaged-mutable-state': noUnmanagedMutableState,
    'no-unredacted-secret-field': noUnredactedSecretField,
    'no-wide-factory-signature': noWideFactorySignature,
    'prefer-effect-fn-for-operations': preferEffectFnForOperations,
    'prefer-match-over-tag-switch': preferMatchOverTagSwitch,
    'require-concurrency-option': requireConcurrencyOption,
    'require-context-service-for-service-interface': requireContextServiceForServiceInterface,
    'require-observability-layers-at-runtime-root': requireObservabilityLayersAtRuntimeRoot,
    'require-timeout-on-external-effect': requireTimeoutOnExternalEffect,
  },
});

export default effectNativePlugin;
