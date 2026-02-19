To get quickly up to speed on what this library does, read `docs/llm.md`.

# Bun

- Use Bun instead of Node.js. `bun <file>`, `bun test`, `bunx`, etc.
- The Bun API docs can be found in `node_modules/bun-types/docs/**.mdx`
- `bun run typecheck`

# Guidelines

- The documentation is the spec
- When making changes to behavior, you _must_ change the docs to match. Be thorough: some concepts are cross-referenced or summarized in several places.
- Write code with an eye towards making it easy to test; then write tests
- Delete tests that don't provide value
- Write efficient code. Avoid linear scans
- Prefer `WeakMap` to stashing data on "userland" objects
- Security is especially important for an RPC framework. Be mindful of common vulnerabilities, like `prototype` and `constructor` accesses
