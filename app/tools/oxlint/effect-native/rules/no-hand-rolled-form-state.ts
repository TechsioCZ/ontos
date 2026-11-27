/**
 * One form model for module UI: effect-form, bound to the kit through `@app/core-runtime/ui/form`.
 * See `packages/core-runtime/src/ui/form/index.ts`.
 *
 * Detected in module UI (`uiGlobs`, test files excluded):
 *  1. Another form state or validation library (`formLibraries`: react-hook-form, Formik, TanStack
 *     Form, Final Form, Conform, Zod, Yup, Valibot, ...), and effect-form imported around the form
 *     module, which owns the kit bindings and is the only form import surface.
 *  2. A kit form control imported directly (`kitControls`): it would hold its value in hand-rolled
 *     React state. Controls are rendered only through the form module's field bindings.
 *  3. A native `<form>`, `<input>`, `<textarea>` or `<select>` element: `FormRoot` is the one form.
 *  4. Hand-read form data: `new FormData(...)`, `Schema.fromFormData` and React's `useFormStatus`.
 *  5. A field binding of the form module (an imported name ending in `Field`) rendered as JSX: a
 *     binding is handed to `FormReact.make({ fields })`, which gives it the field's effect-form state.
 *
 * Deliberately allowed: the form module itself (it lives outside `uiGlobs`), tests, type-only
 * imports, kit molecules that are not data-entry controls (`search-form` holds a query, not a form).
 */
import { defineRule } from '@oxlint/plugins';
import type { Context, ESTree } from '@oxlint/plugins';

import { isTestFile, matchesGlobs, scopePath } from '../shared/paths.ts';

const DEFAULT_UI_GLOBS = ['apps/*/src/**', 'verticals/*/src/**'];
const DEFAULT_FORM_MODULE = '@app/core-runtime/ui/form';
const DEFAULT_FORM_LIBRARIES = [
  '@conform-to',
  '@effect-atom/atom-react',
  '@felte',
  '@hookform',
  '@lucas-barake/effect-form',
  '@lucas-barake/effect-form-react',
  '@modular-forms',
  '@rvf',
  '@tanstack/form-core',
  '@tanstack/react-form',
  'ajv',
  'class-validator',
  'felte',
  'final-form',
  'formik',
  'informed',
  'joi',
  'react-final-form',
  'react-hook-form',
  'superstruct',
  'valibot',
  'vest',
  'yup',
  'zod',
];
const DEFAULT_KIT_CONTROLS = [
  '@techsio/ui-kit/atoms/checkbox',
  '@techsio/ui-kit/atoms/input',
  '@techsio/ui-kit/atoms/numeric-input',
  '@techsio/ui-kit/atoms/textarea',
  '@techsio/ui-kit/molecules/color-select',
  '@techsio/ui-kit/molecules/combobox',
  '@techsio/ui-kit/molecules/date-picker',
  '@techsio/ui-kit/molecules/form-checkbox',
  '@techsio/ui-kit/molecules/form-input',
  '@techsio/ui-kit/molecules/form-numeric-input',
  '@techsio/ui-kit/molecules/form-textarea',
  '@techsio/ui-kit/molecules/phone-input',
  '@techsio/ui-kit/molecules/radio-card',
  '@techsio/ui-kit/molecules/radio-group',
  '@techsio/ui-kit/molecules/select',
  '@techsio/ui-kit/molecules/slider',
  '@techsio/ui-kit/molecules/switch',
];
const NATIVE_CONTROLS = new Set(['form', 'input', 'select', 'textarea']);
const FORM_STATUS_MODULES = new Set(['react', 'react-dom']);

interface RuleOptions {
  readonly formLibraries?: readonly string[];
  readonly formModule?: string;
  readonly kitControls?: readonly string[];
  readonly uiGlobs?: readonly string[];
}

function readOptions(context: Context): Required<RuleOptions> {
  const raw = (context.options[0] ?? {}) as RuleOptions;
  return {
    formLibraries: raw.formLibraries ?? DEFAULT_FORM_LIBRARIES,
    formModule: raw.formModule ?? DEFAULT_FORM_MODULE,
    kitControls: raw.kitControls ?? DEFAULT_KIT_CONTROLS,
    uiGlobs: raw.uiGlobs ?? DEFAULT_UI_GLOBS,
  };
}

/** `react-hook-form` and `react-hook-form/x` belong to `react-hook-form`; `zod-x` does not. */
const belongsTo = (source: string, packages: readonly string[]): boolean =>
  packages.some((name) => source === name || source.startsWith(`${name}/`));

const importedName = (specifier: ESTree.ImportDeclaration['specifiers'][number]): string | null => {
  if (specifier.type !== 'ImportSpecifier') return null;
  return specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
};

/** `import type { X }` and `import { type X, type Y }`: nothing of the module is loaded at runtime. */
const isTypeOnly = (node: ESTree.ImportDeclaration): boolean =>
  node.importKind === 'type' ||
  (node.specifiers.length > 0 &&
    node.specifiers.every((specifier) => specifier.type === 'ImportSpecifier' && specifier.importKind === 'type'));

export const rule = defineRule({
  meta: {
    defaultOptions: [
      {
        formLibraries: DEFAULT_FORM_LIBRARIES,
        formModule: DEFAULT_FORM_MODULE,
        kitControls: DEFAULT_KIT_CONTROLS,
        uiGlobs: DEFAULT_UI_GLOBS,
      },
    ],
    docs: {
      description:
        'Module UI has one form model: effect-form driven from the Action payload Schema and rendered through the kit bindings of `@app/core-runtime/ui/form`. Other form libraries, direct kit form controls, native form elements and hand-read form data are hand-rolled form state.',
    },
    messages: {
      boundField:
        '`{{name}}` is a field binding: pass it to `FormReact.make({ fields })` and render the form field (`<form.name />`), which gives it the effect-form state of that field.',
      formData:
        '`{{name}}` reads form data by hand. Build the form with `fromPayload(PayloadSchema)` from `{{formModule}}`; effect-form decodes the values with the payload Schema.',
      formLibrary:
        '`{{source}}` is another form or validation model. Module UI forms use effect-form through `{{formModule}}`, validated by the Action payload Schema.',
      kitControl:
        '`{{source}}` is a kit form control. Render it through a field binding of `{{formModule}}` so its value, validation and errors live in effect-form, not in component state.',
      nativeControl:
        'Native `<{{name}}>` bypasses the form model. Use `FormRoot` and the kit field bindings of `{{formModule}}`.',
    },
    schema: [
      {
        additionalProperties: false,
        properties: {
          formLibraries: { items: { type: 'string' }, type: 'array' },
          formModule: { type: 'string' },
          kitControls: { items: { type: 'string' }, type: 'array' },
          uiGlobs: { items: { type: 'string' }, type: 'array' },
        },
        type: 'object',
      },
    ],
    type: 'problem',
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (!matchesGlobs(path, options.uiGlobs) || isTestFile(path)) return {};
    const { formModule } = options;
    const boundFields = new Set<string>();
    const formNamespaces = new Set<string>();

    const collectBoundFields = (node: ESTree.ImportDeclaration): void => {
      for (const specifier of node.specifiers) {
        if (specifier.type === 'ImportNamespaceSpecifier') {
          formNamespaces.add(specifier.local.name);
          continue;
        }
        if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type') continue;
        if (importedName(specifier)?.endsWith('Field') === true) boundFields.add(specifier.local.name);
      }
    };

    /** `<Forms.TextField />`: a field binding reached through a namespace import of the form module. */
    const namespacedField = (name: ESTree.JSXOpeningElement['name']): string | null => {
      if (name.type !== 'JSXMemberExpression' || name.object.type !== 'JSXIdentifier') return null;
      if (!formNamespaces.has(name.object.name) || !name.property.name.endsWith('Field')) return null;
      return `${name.object.name}.${name.property.name}`;
    };

    const reactNamespaces = new Set<string>();

    const reportFormStatus = (node: ESTree.ImportDeclaration): void => {
      for (const specifier of node.specifiers) {
        if (specifier.type === 'ImportNamespaceSpecifier' || specifier.type === 'ImportDefaultSpecifier') {
          reactNamespaces.add(specifier.local.name);
          continue;
        }
        if (
          specifier.type === 'ImportSpecifier' &&
          specifier.importKind !== 'type' &&
          importedName(specifier) === 'useFormStatus'
        ) {
          context.report({ data: { formModule, name: 'useFormStatus' }, messageId: 'formData', node: specifier });
        }
      }
    };

    return {
      ImportDeclaration(node) {
        if (isTypeOnly(node)) return;
        const source = node.source.value;
        if (source === formModule) {
          collectBoundFields(node);
        } else if (belongsTo(source, options.formLibraries)) {
          context.report({ data: { formModule, source }, messageId: 'formLibrary', node });
        } else if (belongsTo(source, options.kitControls)) {
          context.report({ data: { formModule, source }, messageId: 'kitControl', node });
        } else if (FORM_STATUS_MODULES.has(source)) {
          reportFormStatus(node);
        }
      },
      JSXOpeningElement(node) {
        const namespaced = namespacedField(node.name);
        if (namespaced !== null) {
          context.report({ data: { name: namespaced }, messageId: 'boundField', node });
          return;
        }
        if (node.name.type !== 'JSXIdentifier') return;
        const { name } = node.name;
        if (NATIVE_CONTROLS.has(name)) {
          context.report({ data: { formModule, name }, messageId: 'nativeControl', node });
        } else if (boundFields.has(name)) {
          context.report({ data: { name }, messageId: 'boundField', node });
        }
      },
      MemberExpression(node) {
        if (
          !node.computed &&
          node.object.type === 'Identifier' &&
          reactNamespaces.has(node.object.name) &&
          node.property.type === 'Identifier' &&
          node.property.name === 'useFormStatus'
        ) {
          context.report({ data: { formModule, name: 'useFormStatus' }, messageId: 'formData', node });
          return;
        }
        if (!node.computed && node.property.type === 'Identifier' && node.property.name === 'fromFormData') {
          context.report({ data: { formModule, name: 'Schema.fromFormData' }, messageId: 'formData', node });
        }
      },
      NewExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'FormData') {
          context.report({ data: { formModule, name: 'new FormData' }, messageId: 'formData', node });
        }
      },
    };
  },
});
