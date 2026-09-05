// False positive (adversarial review): a *read* of a symbol slot written as a destructuring pattern
// is an `ObjectPattern` `Property`, so the `Property` visitor reports it as `symbolSlot` ("stores an
// operation capability under a unique-symbol slot") even though (a) nothing is stored, (b) the slot
// being read is an allowed `true` brand marker, and (c) `allowSameFileAccessors: true` explicitly
// blesses the equivalent member read on the very next line. This is the destructuring spelling of
// `packages/core-runtime/src/modules/runtime-registration.ts:131`, which the rule is silent on.
const registrationMarker: unique symbol = Symbol('@app/core-runtime/fixture/marker');

export interface Registration {
  readonly [registrationMarker]: true;
  readonly name: string;
}

export const viaMember = (registration: Registration): boolean => registration[registrationMarker];

export const viaDestructure = (registration: Registration): boolean => {
  const { [registrationMarker]: marked } = registration;
  return marked;
};

export const withoutMarker = (registration: Registration): string => {
  const { [registrationMarker]: _marked, ...rest } = registration;
  return rest.name;
};
