// jest-dom matchers (toBeInTheDocument, toHaveTextContent, …) for component
// tests. Harmless for the node-env lib tests, which simply never use them.
import '@testing-library/jest-dom/vitest';

// Lets React's act(...) run in the test environment (RTL relies on this too).
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
