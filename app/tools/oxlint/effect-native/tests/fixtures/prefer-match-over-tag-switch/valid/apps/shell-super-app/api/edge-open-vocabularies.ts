declare const metrics: { readonly count: number };
declare const token: string;
declare const PLAN: string;
declare const key: string;
declare const bag: Readonly<Record<string, string>>;

/** A numeric member whose property is not a discriminant name. */
export const byCount = (): string => {
  switch (metrics.count) {
    case 1: {
      return 'one';
    }
    case 2: {
      return 'two';
    }
    default: {
      return 'many';
    }
  }
};

/** Mixing literal and constant case tests is not a declared closed vocabulary. */
export const mixed = (): string => {
  switch (token) {
    case 'plan': {
      return 'plan';
    }
    case PLAN: {
      return 'constant';
    }
    default: {
      return 'help';
    }
  }
};

/** Only a `default` branch: there is no vocabulary at all. */
export const fallbackOnly = (): string => {
  switch (token) {
    default: {
      return 'always';
    }
  }
};

/** A dynamic computed access with non-literal cases. */
export const dynamic = (): string => {
  switch (bag[key]) {
    case token: {
      return 'same';
    }
    default: {
      return 'other';
    }
  }
};
