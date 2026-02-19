# Changelog

## 0.1.0

Initial release.

- Type-safe graph API with `Node` classes, `@edge` and `@method` decorators
- WebSocket transport with automatic reconnection and exponential backoff
- SSR rendering with `createSSRContext` and client-side hydration
- `ref()` for cross-node references in method return values
- Validation via Standard Schema (zod, valibot, arktype, etc.)
- Rich serialization via devalue with custom type support
- ESLint plugin (`graphpc/eslint`) with `require-decorator` rule
