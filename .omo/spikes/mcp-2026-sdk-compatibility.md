# MCP 2026-07-28 SDK compatibility matrix

Recorded during the MCP 2026 implementation spike.

| Check | Observed result | Implementation decision |
| --- | --- | --- |
| `npm view @modelcontextprotocol/sdk version dist-tags --json` | `latest: 1.29.0` | Current latest was inspected before final wiring. |
| `@modelcontextprotocol/sdk/types.js LATEST_PROTOCOL_VERSION` | `2025-11-25` | Do not depend on SDK latest-version constants for modern upstream ingress. |
| `SUPPORTED_PROTOCOL_VERSIONS` | `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07` | Hand-roll the MCP `2026-07-28` HTTP edge and keep SDK-backed clients for downstream/legacy compatibility. |
| Modern upstream primitives (`server/discover`, required request `_meta`, `HeaderMismatch`, `UnsupportedProtocolVersionError`, `subscriptions/listen`, `InputRequiredResult`, `CacheableResult`) | Not represented by the installed runtime constants as final `2026-07-28` support | Define the modern upstream validation/errors/types locally under `src/mcp/modern/`. |

The modern adapter is feature-flagged with `MCP_2026_ENABLED` and `MCP_2026_SUPPORTED_VERSIONS`; legacy SDK-driven initialization remains unchanged.
