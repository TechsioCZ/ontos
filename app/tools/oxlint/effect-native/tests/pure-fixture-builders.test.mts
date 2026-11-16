import { readFileSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';

import { describe, expect, it } from 'effect-rstest';

import { provesDataFactoryImport } from '../../anti-slop/effect/rules/data-factory-proof.ts';
import { antiSlopEffectRule, appRoot, ruleTester } from './rule-tester.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const customerConsumer = 'scripts/integration/support/symmy-c14-customer-assignment-fixture.mts';
const organizationConsumer = 'verticals/privacy/tests/support/organization-business-applicability.fixture.ts';
const factorySource = './factory.ts';
const schemaImport = "import { Schema } from 'effect';";
const dataCodec =
  'const Codec = Schema.Struct({ id: Schema.String }); export const makeData = (id: string) => Schema.decodeUnknownEffect(Codec)({ id });';

it('proves both actual reusable DTO builders without treating support paths as test roots', () => {
  expect(
    provesDataFactoryImport(
      nodePath.join(appRoot, customerConsumer),
      './symmy-c14-customer-plan.mts',
      'makeSymmyC14CustomerPlan',
    ),
  ).toBe(true);
  expect(
    provesDataFactoryImport(
      nodePath.join(appRoot, organizationConsumer),
      './organization-profile-ico-applicability.fixture.ts',
      'makeOrganizationProfileIcoApplicabilityFixture',
    ),
  ).toBe(true);
});

ruleTester.run(
  'pure fixture builder imports retain the runtime constructor boundary',
  antiSlopEffectRule('no-service-constructor-imports'),
  {
    invalid: [],
    valid: [customerConsumer, organizationConsumer].map((file) => ({
      code: readFileSync(nodePath.join(appRoot, file), 'utf-8'),
      filename: nodePath.join(appRoot, file),
      name: file,
    })),
  },
);

const prove = (source: string): boolean =>
  withTemporaryWorkspace((directory) => {
    const consumer = nodePath.join(directory, 'runtime.ts');
    writeFileSync(consumer, "import { makeData } from './factory.ts'; void makeData;");
    writeFileSync(nodePath.join(directory, 'factory.ts'), source);
    return provesDataFactoryImport(consumer, factorySource, 'makeData');
  });

describe('keeps the codec Effect exception restricted to verified service-free data', () => {
  const valid = [
    "import { Config, Schema } from 'effect'; const description=Config.schema(Schema.String,'FIXTURE_PATH').pipe(Config.withDefault('default')); export const makeData=()=>({id:'data'});",
    `${schemaImport} ${dataCodec}`,
    "import { Schema, DateTime, SchemaGetter } from 'effect'; const codec=Schema.String.pipe(Schema.decodeTo(Schema.DateTimeUtc,{decode:SchemaGetter.transform(DateTime.makeUnsafe),encode:SchemaGetter.transform(DateTime.formatIso)})); export const makeData=(id:string)=>Schema.decodeUnknownEffect(codec)(id);",
    "import { DateTime, Option } from 'effect'; export const makeData=(value:string)=>({ epoch:DateTime.make(value).pipe(Option.map(DateTime.toEpochMillis),Option.getOrUndefined) });",
    'export const makeData=()=>{const map=new Map(); map.set("key",["value"]); return { entries:[...map.entries()] };};',
    'const fresh=()=>new Map([["key",["value"]]]); export const makeData=()=>{const map=fresh();map.set("second",["data"]);return {entries:[...map]};};',
    'export const makeData=()=>{const data:{id?:string}={};data.id="value";return data;};',
    'export const makeData=()=>({values:[].map(()=>fetch("unreachable"))});',
    'export const makeData=(value:string)=>({sum:[1,2].reduce((sum,weight,index)=>sum+Number(value[index])*weight,0)});',
  ];
  for (const source of valid) {
    it(source, () => expect(prove(source)).toBe(true));
  }
  const invalid = [
    "import { Config, Schema } from 'effect'; const description=Config.schema(Schema.String,process.env.FIXTURE_PATH).pipe(Config.withDefault('default')); export const makeData=()=>({id:'data'});",
    "import { Schema } from 'effect'; import { Config } from 'foreign-effect'; const description=Config.schema(Schema.String,'PATH');export const makeData=()=>({id:'data'});",
    "import { Schema, SchemaGetter } from 'effect'; const codec=Schema.String.pipe(Schema.decodeTo(Schema.String,{decode:SchemaGetter.transform(value=>fetch(value)),encode:SchemaGetter.transform(value=>value)}));export const makeData=(value:string)=>Schema.decodeUnknownEffect(codec)(value);",
    "import { Schema } from 'effect'; export const makeData=(value:string)=>Schema.decodeUnknownEffect(Schema.Unknown)(value);",
    "import { Schema } from 'effect'; import { Codec } from '@app/symmy-integration/unpublished-private-schema'; export const makeData=(value:string)=>Schema.decodeUnknownEffect(Codec)(value);",
    "import { Context, Effect } from 'effect'; class Service extends Context.Service<Service,{}>()('Service'){} export const makeData=()=>Effect.gen(function*(){return yield* Service;});",
    "import { Layer, Context } from 'effect'; class Service extends Context.Service<Service,{}>()('Service'){} export const makeData=()=>Layer.succeed(Service,{});",
    "import { Effect } from 'effect'; export const makeData=()=>Effect.succeed({id:'data'});",
    `import { Schema } from 'foreign-effect'; ${dataCodec}`,
    `import type { Schema } from 'effect'; ${dataCodec}`,
    `${schemaImport} const codec=Schema.String.check(Schema.makeFilter(value=>{fetch(value);return undefined;})); export const makeData=(value:string)=>Schema.decodeUnknownEffect(codec)(value);`,
    "import { Schema, SchemaGetter, Effect } from 'effect'; const codec=Schema.String.pipe(Schema.decodeTo(Schema.String,{decode:SchemaGetter.transform(value=>Effect.succeed(value)),encode:SchemaGetter.transform(value=>value)}));export const makeData=(value:string)=>Schema.decodeUnknownEffect(codec)(value);",
    "import { DateTime } from 'effect'; export const makeData=()=>({now:DateTime.now});",
    'const map=new Map();export const makeData=()=>{map.set("changed","value");return {entries:[...map]};};',
    'const change=(map)=>{map.set("changed","value");return map;};export const makeData=()=>({entries:[...change(new Map())]});',
    'export const makeData=()=>{const map=new Map();map.set("key",()=>fetch("service"));return {entries:[...map]};};',
    'export const makeData=()=>{const map=new Map();map.set("key",map);return {entries:[...map]};};',
    'export const makeData=()=>{const map=new Map();return {value:map.unknown()};};',
    'const data={};export const makeData=()=>{data.id="value";return data;};',
    'const change=(data)=>{data.id="value";return data;};export const makeData=()=>change({});',
    'export const makeData=()=>{const data={};data.__proto__={};return data;};',
    'export const makeData=()=>{const data={};data.self=data;return data;};',
    'export const makeData=(value:string,key:string)=>({part:value[key]});',
    'export const makeData=()=>{const Map=unknownFactory;return new Map();};',
    'export const makeData=()=>({sum:[1,2].reduce((sum,value)=>{fetch("service");return sum+value;},0)});',
  ];
  for (const source of invalid) {
    it(source, () => expect(prove(source)).toBe(false));
  }
});

it('follows equivalent public schema re-exports and rejects ambiguous source identities', () => {
  withTemporaryWorkspace((directory) => {
    const consumer = nodePath.join(directory, 'consumer.ts');
    writeFileSync(consumer, "import { makeData } from './factory.ts'; void makeData;");
    writeFileSync(
      nodePath.join(directory, 'factory.ts'),
      "import { Schema } from 'effect'; import { Codec } from './barrel.ts';export const makeData=(value:string)=>Schema.decodeUnknownEffect(Codec)(value);",
    );
    writeFileSync(
      nodePath.join(directory, 'first.ts'),
      "import { Schema } from 'effect';export const Codec=Schema.String;",
    );
    writeFileSync(nodePath.join(directory, 'second.ts'), "export { Codec } from './first.ts';");
    writeFileSync(nodePath.join(directory, 'barrel.ts'), "export * from './first.ts';export * from './second.ts';");
    expect(provesDataFactoryImport(consumer, factorySource, 'makeData')).toBe(true);
    writeFileSync(
      nodePath.join(directory, 'second.ts'),
      "import { Schema } from 'effect';export const Codec=Schema.Number;",
    );
    expect(provesDataFactoryImport(consumer, factorySource, 'makeData')).toBe(false);
  });
});
