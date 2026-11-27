// expect-count: 9
import { createElement } from 'react';

export const RawControls = () => (
  <div>
    <label htmlFor="name">Name</label>
    <input id="name" />
    <textarea />
    <select>
      <option value="a">A</option>
    </select>
    <button type="button">Save</button>
    <a href="/help">Help</a>
    <details>
      <summary>More</summary>
    </details>
  </div>
);
