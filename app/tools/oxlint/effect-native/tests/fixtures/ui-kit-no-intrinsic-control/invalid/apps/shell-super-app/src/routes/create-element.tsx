// expect-count: 2
import React, { createElement } from 'react';

export const viaFactory = () => [createElement('button', { type: 'button' }), React.createElement('dialog')];
