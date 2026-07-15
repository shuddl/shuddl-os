import { createRequire } from "node:module";

// WHY THIS FILE EXISTS — the Concierge parse-parity harness (parse-parity.ts) calls the REAL
// composeConcierge, which renders the tenant-voice quote reply (concierge/quote-reply.tsx →
// @shuddl/design primitives) to a string with react-dom/server. Under a plain `tsx` run the tools tree
// has no tsconfig, so esbuild transforms that JSX with its DEFAULT (classic) runtime —
// `React.createElement(...)` — which needs a `React` binding in scope.
//
// The AUTOMATIC runtime is deliberately NOT used: tsx cannot ESM-link react/jsx-runtime's named `jsx`
// export (react ships it as a conditional CJS re-export that cjs-module-lexer can't statically see, so a
// react-jsx-transformed file throws "does not provide an export named 'jsx'"). Classic + a global React
// sidesteps that path entirely — and react-dom/server's named `renderToStaticMarkup` DOES link, so SSR
// works. This is a tools-only shim; nothing here ships.
//
// react is not a root dependency, so it is resolved from @shuddl/agents (which depends on it). This
// module is imported FIRST (for its side effect) by the harness, so the global is set BEFORE the
// agents/design view modules evaluate. It is synchronous on purpose (no top-level await): the global
// must exist before the JSX render, and a synchronous require guarantees ordering without a race.
// createRequire gives a synchronous CJS require (needed so the global is set before the classic-JSX views
// evaluate); `agentsRequire(...)` is a createRequire result, not the bare `require` global, so it doesn't
// trip @typescript-eslint/no-require-imports.
const agentsRequire = createRequire(new URL("../../packages/agents/package.json", import.meta.url));
(globalThis as unknown as { React: unknown }).React = agentsRequire("react");
