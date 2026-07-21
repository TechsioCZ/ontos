import { cleanup } from '@testing-library/react';
import * as jestDomMatchers from '@testing-library/jest-dom/matchers';
import { afterEach, expect } from '@rstest/core';

expect.extend(jestDomMatchers);

afterEach(() => {
  cleanup();
});
