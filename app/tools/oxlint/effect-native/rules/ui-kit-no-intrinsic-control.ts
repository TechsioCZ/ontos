/**
 * effect-native/ui-kit-no-intrinsic-control
 *
 * Module UI is built from the kit. An intrinsic interactive or form element that the kit already provides as a
 * component bypasses the kit's styling, states, accessibility and theming, so it is reported:
 * `<button>`, `<input>`, `<select>`, `<option>`, `<optgroup>`, `<datalist>`, `<textarea>`, `<label>`, `<a>`,
 * `<dialog>`, `<details>` and `<summary>`, written as JSX or through `createElement`.
 *
 * Elements the kit has no component for (`<form>`, `<fieldset>`, `<legend>`) stay allowed. Components, member
 * tags (`Dialog.Content`) and lower-case custom elements with a dash are not intrinsic controls.
 * Scope: `apps/**`, `verticals/**`, `packages/**`, tests excluded; `includePaths` overrides it.
 * Report-only: no fixer, no suggestion.
 */
import { defineRule } from '@oxlint/plugins';

import { UI_SOURCE_PATHS, inUiScope } from '../shared/ui-kit-scope.ts';

const KIT_COUNTERPART: ReadonlyMap<string, string> = new Map([
  ['a', 'Link'],
  ['button', 'Button'],
  ['datalist', 'Combobox'],
  ['details', 'Accordion'],
  ['dialog', 'Dialog'],
  ['input', 'Input, Checkbox, Switch, RadioGroup or another form control'],
  ['label', 'Label'],
  ['optgroup', 'Select'],
  ['option', 'Select'],
  ['select', 'Select'],
  ['summary', 'Accordion'],
  ['textarea', 'Textarea'],
]);

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: { description: 'Use the kit component instead of an intrinsic interactive or form element.' },
    schema: [{ type: 'object', properties: { includePaths: { type: 'array', items: { type: 'string' } } } }],
    messages: {
      intrinsic: '<{{element}}> bypasses the kit: use its {{component}}.',
    },
  },
  create(context) {
    if (!inUiScope(context.filename, context.options[0], UI_SOURCE_PATHS)) return {};
    return {
      CallExpression(node) {
        const callee = node.callee;
        const name =
          callee.type === 'Identifier'
            ? callee.name
            : callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier'
              ? callee.property.name
              : null;
        const [first] = node.arguments;
        if (name !== 'createElement' || first?.type !== 'Literal' || typeof first.value !== 'string') return;
        const component = KIT_COUNTERPART.get(first.value);
        if (component !== undefined) {
          context.report({ data: { component, element: first.value }, messageId: 'intrinsic', node: first });
        }
      },
      JSXOpeningElement(node) {
        if (node.name.type !== 'JSXIdentifier') return;
        const component = KIT_COUNTERPART.get(node.name.name);
        if (component !== undefined) {
          context.report({ data: { component, element: node.name.name }, messageId: 'intrinsic', node: node.name });
        }
      },
    };
  },
});
