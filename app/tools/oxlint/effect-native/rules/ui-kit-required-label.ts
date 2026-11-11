import { defineRule } from '@oxlint/plugins';
import type { ESTree } from '@oxlint/plugins';

/**
 * ui-kit's label-bearing form controls read an English "(required)" to screen readers after the label of a required
 * field unless they get a translation. `@app/admin-ui/form-controls` re-exports them with the page language's text,
 * so a required admin field must use those. Reported: a JSX element with a `required` attribute, or with spread props
 * that may carry one (a local wrapper passing its props on), whose tag (or the root of a compound tag such as
 * `DatePicker.Root`) is a value import from one of these ui-kit modules.
 */
const labelledControlModules: ReadonlySet<string> = new Set([
  '@techsio/ui-kit/atoms/label',
  '@techsio/ui-kit/molecules/cascade-select',
  '@techsio/ui-kit/molecules/combobox',
  '@techsio/ui-kit/molecules/date-picker',
  '@techsio/ui-kit/molecules/file-upload',
  '@techsio/ui-kit/molecules/form-input',
  '@techsio/ui-kit/molecules/form-numeric-input',
  '@techsio/ui-kit/molecules/form-textarea',
  '@techsio/ui-kit/molecules/phone-input',
  '@techsio/ui-kit/molecules/quantity-field',
  '@techsio/ui-kit/molecules/radio-card',
  '@techsio/ui-kit/molecules/radio-group',
  '@techsio/ui-kit/molecules/search-form',
  '@techsio/ui-kit/molecules/switch',
]);

const rootName = (name: ESTree.JSXElementName): string | null => {
  if (name.type === 'JSXIdentifier') {
    return name.name;
  }
  return name.type === 'JSXMemberExpression' ? rootName(name.object) : null;
};

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description: 'Require admin form controls from @app/admin-ui/form-controls on required fields.',
    },
    schema: [],
    messages: {
      direct:
        "Import {{name}} from '@app/admin-ui/form-controls': ui-kit's own required text is English and screen readers read it after the label.",
    },
  },
  create(context) {
    const imported = new Set<string>();
    return {
      ImportDeclaration(node) {
        if (node.importKind === 'type' || !labelledControlModules.has(node.source.value)) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ImportSpecifier' || specifier.importKind !== 'type') {
            imported.add(specifier.local.name);
          }
        }
      },
      JSXOpeningElement(node) {
        const name = rootName(node.name);
        if (name === null || !imported.has(name)) {
          return;
        }
        // `required={false}` marks nothing; every other `required` may, and so may spread props.
        const required = node.attributes.some(
          (attribute) =>
            attribute.type === 'JSXSpreadAttribute' ||
            (attribute.type === 'JSXAttribute' &&
              attribute.name.type === 'JSXIdentifier' &&
              attribute.name.name === 'required' &&
              !(
                attribute.value?.type === 'JSXExpressionContainer' &&
                attribute.value.expression.type === 'Literal' &&
                attribute.value.expression.value === false
              )),
        );
        if (required) {
          context.report({ data: { name }, messageId: 'direct', node });
        }
      },
    };
  },
});
