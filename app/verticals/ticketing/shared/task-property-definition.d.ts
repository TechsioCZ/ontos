import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const checkboxPropertyDefinitionSchema: Schema.Struct<{
  readonly datatype: Schema.Literal<'checkbox'>;
  readonly hidden: Schema.Boolean;
  readonly mandatory: Schema.Boolean;
  readonly name: Schema.String;
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
}>;
export declare const filesMediaPropertyDefinitionSchema: Schema.Struct<{
  readonly datatype: Schema.Literal<'files_media'>;
  readonly hidden: Schema.Boolean;
  readonly mandatory: Schema.Boolean;
  readonly name: Schema.String;
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
}>;
export declare const idPropertyDefinitionSchema: Schema.Struct<{
  readonly datatype: Schema.Literal<'id'>;
  readonly hidden: Schema.Boolean;
  readonly mandatory: Schema.Boolean;
  readonly name: Schema.String;
  readonly prefix: Schema.String;
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
}>;
export declare const datePropertyDefinitionSchema: Schema.Struct<{
  readonly datatype: Schema.Literal<'date'>;
  readonly hidden: Schema.Boolean;
  readonly mandatory: Schema.Boolean;
  readonly name: Schema.String;
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
}>;
export declare const dateRangePropertyDefinitionSchema: Schema.Struct<{
  readonly datatype: Schema.Literal<'date_range'>;
  readonly hidden: Schema.Boolean;
  readonly mandatory: Schema.Boolean;
  readonly name: Schema.String;
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
  readonly timeEnabled: Schema.Boolean;
}>;
export declare const intrinsicPropertyDefinitionSchema: Schema.Struct<{
  readonly datatype: Schema.Literals<readonly ['created_time', 'created_by']>;
  readonly hidden: Schema.Boolean;
  readonly mandatory: Schema.Boolean;
  readonly name: Schema.String;
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
}>;
export declare const selectOptionOrderModeSchema: Schema.Literals<
  readonly ['manual', 'alphabetical', 'reverse_alphabetical']
>;
export declare const selectOptionSchema: Schema.Struct<{
  readonly color: Schema.String;
  readonly manualPosition: Schema.Finite;
  readonly name: Schema.String;
  readonly optionId: Schema.String;
  readonly revision: Schema.Finite;
}>;
export declare const selectPropertyDefinitionSchema: Schema.Struct<{
  readonly datatype: Schema.Literal<'select'>;
  readonly hidden: Schema.Boolean;
  readonly mandatory: Schema.Boolean;
  readonly name: Schema.String;
  readonly optionOrderMode: Schema.Literals<
    readonly ['manual', 'alphabetical', 'reverse_alphabetical']
  >;
  readonly options: Schema.$Array<
    Schema.Struct<{
      readonly color: Schema.String;
      readonly manualPosition: Schema.Finite;
      readonly name: Schema.String;
      readonly optionId: Schema.String;
      readonly revision: Schema.Finite;
    }>
  >;
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
}>;
export declare const statusGroupKeySchema: Schema.Literals<
  readonly ['todo', 'in_progress', 'complete']
>;
export declare const statusOptionSchema: Schema.Struct<{
  readonly color: Schema.String;
  readonly group: Schema.Literals<readonly ['todo', 'in_progress', 'complete']>;
  readonly name: Schema.String;
  readonly optionId: Schema.String;
  readonly position: Schema.Finite;
  readonly revision: Schema.Finite;
}>;
export declare const statusGroupSchema: Schema.Struct<{
  readonly group: Schema.Literals<readonly ['todo', 'in_progress', 'complete']>;
  readonly label: Schema.String;
  readonly options: Schema.$Array<
    Schema.Struct<{
      readonly color: Schema.String;
      readonly group: Schema.Literals<readonly ['todo', 'in_progress', 'complete']>;
      readonly name: Schema.String;
      readonly optionId: Schema.String;
      readonly position: Schema.Finite;
      readonly revision: Schema.Finite;
    }>
  >;
}>;
export declare const statusPropertyDefinitionSchema: Schema.Struct<{
  readonly datatype: Schema.Literal<'status'>;
  readonly defaultOptionId: Schema.String;
  readonly groups: Schema.$Array<
    Schema.Struct<{
      readonly group: Schema.Literals<readonly ['todo', 'in_progress', 'complete']>;
      readonly label: Schema.String;
      readonly options: Schema.$Array<
        Schema.Struct<{
          readonly color: Schema.String;
          readonly group: Schema.Literals<readonly ['todo', 'in_progress', 'complete']>;
          readonly name: Schema.String;
          readonly optionId: Schema.String;
          readonly position: Schema.Finite;
          readonly revision: Schema.Finite;
        }>
      >;
    }>
  >;
  readonly hidden: Schema.Boolean;
  readonly mandatory: Schema.Boolean;
  readonly name: Schema.String;
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
}>;
export declare const textPropertyDefinitionSchema: Schema.Struct<{
  readonly datatype: Schema.Literal<'text'>;
  readonly hidden: Schema.Boolean;
  readonly mandatory: Schema.Boolean;
  readonly name: Schema.String;
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
}>;
export declare const numberPropertyDefinitionSchema: Schema.Struct<{
  readonly datatype: Schema.Literal<'number'>;
  readonly format: Schema.Literals<readonly ['number', 'number_with_separators', 'percent']>;
  readonly hidden: Schema.Boolean;
  readonly mandatory: Schema.Boolean;
  readonly name: Schema.String;
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
}>;
export declare const urlPropertyDefinitionSchema: Schema.Struct<{
  readonly datatype: Schema.Literal<'url'>;
  readonly hidden: Schema.Boolean;
  readonly mandatory: Schema.Boolean;
  readonly name: Schema.String;
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
}>;
export declare const emailPropertyDefinitionSchema: Schema.Struct<{
  readonly datatype: Schema.Literal<'email'>;
  readonly hidden: Schema.Boolean;
  readonly mandatory: Schema.Boolean;
  readonly name: Schema.String;
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
}>;
export declare const phonePropertyDefinitionSchema: Schema.Struct<{
  readonly datatype: Schema.Literal<'phone'>;
  readonly hidden: Schema.Boolean;
  readonly mandatory: Schema.Boolean;
  readonly name: Schema.String;
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
}>;
export declare const personPropertyDefinitionSchema: Schema.Struct<{
  readonly cardinality: Schema.Literals<readonly ['one', 'unlimited']>;
  readonly datatype: Schema.Literal<'person'>;
  readonly hidden: Schema.Boolean;
  readonly mandatory: Schema.Boolean;
  readonly name: Schema.String;
  readonly propertyDefinitionId: Schema.String;
  readonly revision: Schema.Finite;
}>;
export declare const taskPropertyDefinitionSchema: Schema.Union<
  readonly [
    Schema.Struct<{
      readonly datatype: Schema.Literal<'checkbox'>;
      readonly hidden: Schema.Boolean;
      readonly mandatory: Schema.Boolean;
      readonly name: Schema.String;
      readonly propertyDefinitionId: Schema.String;
      readonly revision: Schema.Finite;
    }>,
    Schema.Struct<{
      readonly datatype: Schema.Literal<'date'>;
      readonly hidden: Schema.Boolean;
      readonly mandatory: Schema.Boolean;
      readonly name: Schema.String;
      readonly propertyDefinitionId: Schema.String;
      readonly revision: Schema.Finite;
    }>,
    Schema.Struct<{
      readonly datatype: Schema.Literal<'date_range'>;
      readonly hidden: Schema.Boolean;
      readonly mandatory: Schema.Boolean;
      readonly name: Schema.String;
      readonly propertyDefinitionId: Schema.String;
      readonly revision: Schema.Finite;
      readonly timeEnabled: Schema.Boolean;
    }>,
    Schema.Struct<{
      readonly datatype: Schema.Literal<'email'>;
      readonly hidden: Schema.Boolean;
      readonly mandatory: Schema.Boolean;
      readonly name: Schema.String;
      readonly propertyDefinitionId: Schema.String;
      readonly revision: Schema.Finite;
    }>,
    Schema.Struct<{
      readonly datatype: Schema.Literal<'files_media'>;
      readonly hidden: Schema.Boolean;
      readonly mandatory: Schema.Boolean;
      readonly name: Schema.String;
      readonly propertyDefinitionId: Schema.String;
      readonly revision: Schema.Finite;
    }>,
    Schema.Struct<{
      readonly datatype: Schema.Literal<'id'>;
      readonly hidden: Schema.Boolean;
      readonly mandatory: Schema.Boolean;
      readonly name: Schema.String;
      readonly prefix: Schema.String;
      readonly propertyDefinitionId: Schema.String;
      readonly revision: Schema.Finite;
    }>,
    Schema.Struct<{
      readonly datatype: Schema.Literals<readonly ['created_time', 'created_by']>;
      readonly hidden: Schema.Boolean;
      readonly mandatory: Schema.Boolean;
      readonly name: Schema.String;
      readonly propertyDefinitionId: Schema.String;
      readonly revision: Schema.Finite;
    }>,
    Schema.Struct<{
      readonly datatype: Schema.Literal<'number'>;
      readonly format: Schema.Literals<readonly ['number', 'number_with_separators', 'percent']>;
      readonly hidden: Schema.Boolean;
      readonly mandatory: Schema.Boolean;
      readonly name: Schema.String;
      readonly propertyDefinitionId: Schema.String;
      readonly revision: Schema.Finite;
    }>,
    Schema.Struct<{
      readonly cardinality: Schema.Literals<readonly ['one', 'unlimited']>;
      readonly datatype: Schema.Literal<'person'>;
      readonly hidden: Schema.Boolean;
      readonly mandatory: Schema.Boolean;
      readonly name: Schema.String;
      readonly propertyDefinitionId: Schema.String;
      readonly revision: Schema.Finite;
    }>,
    Schema.Struct<{
      readonly datatype: Schema.Literal<'phone'>;
      readonly hidden: Schema.Boolean;
      readonly mandatory: Schema.Boolean;
      readonly name: Schema.String;
      readonly propertyDefinitionId: Schema.String;
      readonly revision: Schema.Finite;
    }>,
    Schema.Struct<{
      readonly datatype: Schema.Literal<'select'>;
      readonly hidden: Schema.Boolean;
      readonly mandatory: Schema.Boolean;
      readonly name: Schema.String;
      readonly optionOrderMode: Schema.Literals<
        readonly ['manual', 'alphabetical', 'reverse_alphabetical']
      >;
      readonly options: Schema.$Array<
        Schema.Struct<{
          readonly color: Schema.String;
          readonly manualPosition: Schema.Finite;
          readonly name: Schema.String;
          readonly optionId: Schema.String;
          readonly revision: Schema.Finite;
        }>
      >;
      readonly propertyDefinitionId: Schema.String;
      readonly revision: Schema.Finite;
    }>,
    Schema.Struct<{
      readonly datatype: Schema.Literal<'status'>;
      readonly defaultOptionId: Schema.String;
      readonly groups: Schema.$Array<
        Schema.Struct<{
          readonly group: Schema.Literals<readonly ['todo', 'in_progress', 'complete']>;
          readonly label: Schema.String;
          readonly options: Schema.$Array<
            Schema.Struct<{
              readonly color: Schema.String;
              readonly group: Schema.Literals<readonly ['todo', 'in_progress', 'complete']>;
              readonly name: Schema.String;
              readonly optionId: Schema.String;
              readonly position: Schema.Finite;
              readonly revision: Schema.Finite;
            }>
          >;
        }>
      >;
      readonly hidden: Schema.Boolean;
      readonly mandatory: Schema.Boolean;
      readonly name: Schema.String;
      readonly propertyDefinitionId: Schema.String;
      readonly revision: Schema.Finite;
    }>,
    Schema.Struct<{
      readonly datatype: Schema.Literal<'text'>;
      readonly hidden: Schema.Boolean;
      readonly mandatory: Schema.Boolean;
      readonly name: Schema.String;
      readonly propertyDefinitionId: Schema.String;
      readonly revision: Schema.Finite;
    }>,
    Schema.Struct<{
      readonly datatype: Schema.Literal<'url'>;
      readonly hidden: Schema.Boolean;
      readonly mandatory: Schema.Boolean;
      readonly name: Schema.String;
      readonly propertyDefinitionId: Schema.String;
      readonly revision: Schema.Finite;
    }>,
  ]
>;
export type CheckboxPropertyDefinition = typeof checkboxPropertyDefinitionSchema.Type;
export type DatePropertyDefinition = typeof datePropertyDefinitionSchema.Type;
export type DateRangePropertyDefinition = typeof dateRangePropertyDefinitionSchema.Type;
export type EmailPropertyDefinition = typeof emailPropertyDefinitionSchema.Type;
export type FilesMediaPropertyDefinition = typeof filesMediaPropertyDefinitionSchema.Type;
export type IdPropertyDefinition = typeof idPropertyDefinitionSchema.Type;
export type IntrinsicPropertyDefinition = typeof intrinsicPropertyDefinitionSchema.Type;
export type NumberPropertyDefinition = typeof numberPropertyDefinitionSchema.Type;
export type PersonPropertyDefinition = typeof personPropertyDefinitionSchema.Type;
export type PhonePropertyDefinition = typeof phonePropertyDefinitionSchema.Type;
export type SelectOption = typeof selectOptionSchema.Type;
export type SelectOptionOrderMode = typeof selectOptionOrderModeSchema.Type;
export type SelectPropertyDefinition = typeof selectPropertyDefinitionSchema.Type;
export type StatusGroup = typeof statusGroupSchema.Type;
export type StatusGroupKey = typeof statusGroupKeySchema.Type;
export type StatusOption = typeof statusOptionSchema.Type;
export type StatusPropertyDefinition = typeof statusPropertyDefinitionSchema.Type;
export type TextPropertyDefinition = typeof textPropertyDefinitionSchema.Type;
export type UrlPropertyDefinition = typeof urlPropertyDefinitionSchema.Type;
export type TaskPropertyDefinition = typeof taskPropertyDefinitionSchema.Type;
