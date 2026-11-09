/**
 * The Markdown footer on Workers (new: the text is the deployment's `CKAN_DEMO_NOTICE`, ondata's by
 * default; ondata's own footer test does not exist at 09e8cdc).
 */
import { describe, it, expect, afterEach } from "vitest";
import { addDemoFooter, ONDATA_DEMO_NOTICE } from "../src/utils/formatting.js";
import { ckanContext, ckanEngine } from "./helpers.js";

const g = globalThis as { WorkerGlobalScope?: unknown };
afterEach(() => { delete g.WorkerGlobalScope; });

describe("addDemoFooter", () => {
  it("adds nothing outside Workers", () => {
    expect(addDemoFooter(ckanContext(), "x")).toBe("x");
  });

  it("on Workers: ondata's notice by default", () => {
    g.WorkerGlobalScope = function () {};
    expect(addDemoFooter(ckanContext(), "x")).toBe(`x\n\n---\nℹ️ ${ONDATA_DEMO_NOTICE}`);
    expect(ONDATA_DEMO_NOTICE).toBe("Demo instance (100k requests/day shared quota). For unlimited access: https://github.com/ondata/ckan-mcp-server#installation");
  });

  it("on Workers: the deployment's CKAN_DEMO_NOTICE when set", () => {
    g.WorkerGlobalScope = function () {};
    expect(addDemoFooter(ckanContext(ckanEngine({ CKAN_DEMO_NOTICE: "Test instance" })), "x")).toBe("x\n\n---\nℹ️ Test instance");
  });
});
