import { defineRule } from '@oxlint/plugins';
import type { ESTree } from '@oxlint/plugins';
import {
  allowsNativeScriptImport,
  isRequireAccess,
  nativeModuleAccess,
  nativeScriptAppRoot,
  validateNativeScriptRegistration,
} from '../shared/native-script-test-registration.ts';
import type { NativeScriptRegistration } from '../shared/native-script-test-registration.ts';

export const rule = defineRule({
  createOnce(context) {
    // One immutable evidence snapshot per lint invocation, never a process-global cache of mutable files.
    let registration: NativeScriptRegistration | undefined;
    const check = (node: ESTree.Node) => {
      const source = nativeModuleAccess(node);
      if (source === undefined) {
        return;
      }
      if (source === 'unsupported') {
        context.report({ messageId: 'dynamicNative', node });
        return;
      }
      registration ??= validateNativeScriptRegistration(nativeScriptAppRoot);
      if (!allowsNativeScriptImport(registration, context.filename, source)) {
        context.report({ data: { reason: registration.errors.join('; ') }, messageId: 'unregistered', node });
      }
    };
    return {
      CallExpression(node) {
        const [argument] = node.arguments;
        if (isRequireAccess(node.callee) && argument !== undefined) {
          check(argument);
        }
      },
      ExportAllDeclaration(node) {
        check(node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.source !== null) {
          check(node.source);
        }
      },
      ImportDeclaration(node) {
        check(node.source);
      },
      ImportExpression(node) {
        check(node.source);
      },
    };
  },
  meta: {
    docs: { description: 'Allow native Node test APIs only for structurally verified native CI registrations.' },
    messages: {
      dynamicNative:
        'Native test module access must use a statically provable specifier and a structurally registered native script; dynamic native access is not an exemption.',
      unregistered:
        'Use effect-rstest. Native Node test APIs require canonical nativeScriptTests metadata, effective Rstest exclusion, and exactly one literal unfiltered CI invocation in this checkout. {{reason}}',
    },
    schema: [],
    type: 'problem',
  },
});
