declare const httpCode: number;
declare const token: string;
declare const GENERATE: string;
declare const VALIDATE: string;
declare const suffix: string;

/** Numeric protocol space, not a closed tagged vocabulary (the ARES status classifier shape). */
export const classifyStatus = (): string => {
  switch (httpCode) {
    case 400: {
      return 'invalid';
    }
    case 401:
    case 403: {
      return 'denied';
    }
    case 404: {
      return 'not_found';
    }
    default: {
      return 'unavailable';
    }
  }
};

/** A single literal case is below `minLiteralCases`. */
export const onlyOne = (): string => {
  switch (token) {
    case 'only': {
      return 'one';
    }
    default: {
      return 'other';
    }
  }
};

/** Non-literal case tests: this is not a declared closed vocabulary. */
export const constantCases = (): string => {
  switch (token) {
    case GENERATE: {
      return 'generate';
    }
    case VALIDATE: {
      return 'validate';
    }
    default: {
      return 'help';
    }
  }
};

/** Interpolating template literals are not static case literals. */
export const interpolated = (): string => {
  switch (token) {
    case `prefix-${suffix}`: {
      return 'prefixed';
    }
    case `other-${suffix}`: {
      return 'other';
    }
    default: {
      return 'none';
    }
  }
};

/** A dynamic computed member is not a discriminant access, and the cases are not literals. */
export const dynamic = (bag: Readonly<Record<string, number>>, key: string): string => {
  switch (bag[key]) {
    case httpCode: {
      return 'same';
    }
    default: {
      return 'different';
    }
  }
};

/** No cases at all. */
export const empty = (): void => {
  switch (token) {
  }
};
