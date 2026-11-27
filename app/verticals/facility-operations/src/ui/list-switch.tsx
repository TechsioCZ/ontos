// A switch over a list that acts at once (only open incidents, only alerts): a one-field form whose value the list
// filters by. Every switch has its own form, and each opens with the value its list starts from.
import { FormBuilder, FormReact, FormRoot, SwitchField, useAtomValue } from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect, Option, Schema } from 'effect';
import { Atom } from 'effect/reactivity';
import type { ReactNode } from 'react';
import { browserAtomRuntime } from '../runtime/browser-effect-runtime.ts';

const switchFormOf = (initial: boolean) => {
  const form = FormReact.make(FormBuilder.empty.addField('on', Schema.Boolean), {
    fields: { on: SwitchField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  });
  return {
    form,
    initial: { on: initial },
    on: form.getFieldAtoms(form.fields.on).value.pipe(Atom.map(Option.getOrElse(() => initial))),
  };
};

const switchForms = {
  incidentsOpenOnly: switchFormOf(true),
  ordersOpenOnly: switchFormOf(true),
  stockAlertsOnly: switchFormOf(false),
};

/** The switches over lists. */
export const ListSwitchNameSchema = Schema.Literals(['incidentsOpenOnly', 'ordersOpenOnly', 'stockAlertsOnly']);
export type ListSwitchName = typeof ListSwitchNameSchema.Type;

/** Whether a list's switch is on; the value its list starts from before the switch is on screen. */
export const useListSwitch = (name: ListSwitchName): boolean => useAtomValue(switchForms[name].on);

/** The switch of one list; its children are the label. */
export const ListSwitch = ({ children, name }: { readonly children: ReactNode; readonly name: ListSwitchName }) => {
  const { t } = useModernI18n();
  const { form, initial } = switchForms[name];
  return (
    <FormRoot defaultValues={initial} form={form} translateMessage={(message) => t(message)}>
      <form.on>{children}</form.on>
    </FormRoot>
  );
};
