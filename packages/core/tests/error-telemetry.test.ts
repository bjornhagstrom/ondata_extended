// Ported from ondata/ckan-mcp-server tests/unit/error-telemetry.test.ts (commit 09e8cdc). Expectations unchanged;
// only the way the tests reach the code changed (imports, env prefix APP_ instead of ondata's,
// policy-building wrappers in ./helpers.ts). See docs/test-parity.md.
import { describe, it, expect } from "vitest";
import { summarizeToolError } from "../src/index.js";

describe("summarizeToolError", () => {
  it.each([
    ["MCP error -32602: Input validation error: Invalid arguments for tool demo_status_show: [\n  {\n    \"message\": \"Invalid url\"", "validation"],
    ["Domain \"evil.example\" is not in the allowed list (APP_ALLOWED_DOMAINS).", "not_allowed"],
    ["Server appears to be offline or not a valid upstream instance:\nRequest timeout connecting to https://portal-d.example", "timeout"],
    ["Error retrieving quality metrics: MQA API error: The operation was aborted due to timeout", "timeout"],
    ["Server appears to be offline or not a valid upstream instance:\nUpstream API error (404): Not Found", "upstream_http"],
    ["Could not fetch portal list from datashades.info:\ndatashades.info returned 503 Service Unavailable", "upstream_http"],
    ["Server not found: https://no-such-portal.example", "unreachable"],
    // The portal's own reason can contain any words: the HTTP status, written by this
    // server, decides the class.
    ["Upstream API error (403): Accès non autorisé: function not allowed\n→ hint", "upstream_http"],
    ["Upstream API error (409): query: canceling statement due to statement timeout", "upstream_http"],
    ["Upstream API error (400): Invalid URL in field url", "upstream_http"],
    ["Could not fetch portal list from datashades.info:\nThe 'cache' field on 'RequestInitializerDict' is not implemented.", "other"]
  ])("classifies %j as %s", (text, kind) => {
    expect(summarizeToolError(text).error_kind).toBe(kind);
  });

  it("keeps the message on one line, capped at 200 characters", () => {
    const { error_message } = summarizeToolError(`first line\n\n  second   line ${"x".repeat(300)}`);
    expect(error_message).toMatch(/^first line second line x+$/);
    expect(error_message).toHaveLength(200);
  });
});
