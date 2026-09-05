#!/usr/bin/env node
declare const status: number;
declare const command: string;

/** A shebang, and an open numeric protocol space (D tier: leave it alone). */
export const classify = (): string => {
  switch (status) {
    case 400: {
      return 'bad_request';
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
export const only = (): string => {
  switch (command) {
    case 'plan': {
      return 'plan';
    }
    default: {
      return 'help';
    }
  }
};
