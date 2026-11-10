/**
 * Registration of profiles on an McpServer.
 *
 * The SDK is wrapped here so that a later move to SDK v2 is a core change, not a profile
 * change. Registration checks what ondata/ckan-mcp-server checked by hand or not at all:
 * unique tool names across profiles, the profile prefix, and that every tool a prompt tells
 * the model to call exists.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import type { Profile, PromptResult, RowsResult, ToolResult, ToolSpec } from "@ondata-extended/profile-contract";
import type { Engine } from "./engine.js";
import { SsrfGuardError } from "./net/guards.js";

export { McpServer };

export interface ServerInfo {
  name: string;
  version: string;
}

export function createMcpServer(info: ServerInfo): McpServer {
  return new McpServer({ name: info.name, version: info.version });
}

/** Check a set of profiles before registering: names, prefixes and prompt references. */
export function validateProfiles(profiles: readonly Profile[]): void {
  const toolNames = new Set<string>();
  const profileIds = new Set<string>();
  for (const profile of profiles) {
    if (profileIds.has(profile.id)) throw new Error(`Profile "${profile.id}" registered twice`);
    profileIds.add(profile.id);
    for (const tool of profile.tools) {
      if (!tool.handler === !tool.rows) {
        throw new Error(`Tool "${tool.name}" in profile "${profile.id}" must have exactly one of handler and rows`);
      }
      if (toolNames.has(tool.name)) throw new Error(`Tool name "${tool.name}" is registered by more than one profile`);
      if (profile.toolPrefix && !tool.shared && !tool.name.startsWith(profile.toolPrefix)) {
        throw new Error(`Tool "${tool.name}" in profile "${profile.id}" does not start with "${profile.toolPrefix}"`);
      }
      toolNames.add(tool.name);
    }
  }
  for (const profile of profiles) {
    for (const prompt of profile.prompts ?? []) {
      for (const ref of prompt.referencedTools) {
        if (!toolNames.has(ref)) {
          throw new Error(`Prompt "${prompt.name}" in profile "${profile.id}" refers to tool "${ref}", which is not registered`);
        }
      }
    }
  }
}

/** Empty-result text when neither the tool nor the profile gives one. */
export const DEFAULT_EMPTY_TEXT =
  "No results. Do not infer or invent the missing value: rephrase the query, widen the filter, or check the identifiers.";

/**
 * Call a row-level tool outside MCP, e.g. from a CLI: validates the arguments with the tool's
 * schema as the MCP SDK does (async parse, defaults applied, unknown keys dropped) and returns the
 * rows unformatted, with `emptyText` resolved (tool, then profile, then core) as MCP would show it.
 * The CLI picks the format. Errors are thrown as they are; a CLI that wants the model-facing hint
 * calls `profile.describeError(error, toolName)` itself.
 */
export async function runRowsTool(profile: Profile, toolName: string, args: Record<string, unknown>, engine: Engine): Promise<RowsResult & { emptyText: string }> {
  const tool = profile.tools.find((t) => t.name === toolName);
  if (!tool) throw new Error(`Unknown tool "${toolName}" in profile "${profile.id}"`);
  if (!tool.rows) throw new Error(`Tool "${toolName}" returns a document, not rows; call it through MCP`);
  const parsed = await inputSchemaOf(tool).parseAsync(args);
  const result = await tool.rows(parsed, engine.contextFor(profile, {}));
  return { ...result, emptyText: result.emptyText ?? profile.emptyText ?? DEFAULT_EMPTY_TEXT };
}

/** The text a caller sees for an error no profile described. Never echoes upstream bodies. */
export function genericErrorText(error: unknown): string {
  if (error instanceof SsrfGuardError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function registerProfiles(server: McpServer, profiles: readonly Profile[], engine: Engine): void {
  validateProfiles(profiles);
  for (const profile of profiles) {
    const ctx = engine.contextFor(profile, server);

    for (const tool of profile.tools) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: describeTool(tool.description, tool.examples),
          // The raw shape, as ondata's servers register it, unless the tool is strict: the SDK then
          // lists an empty shape as `{ type: "object", properties: {} }`, where a z.object({}) would
          // add `additionalProperties: false`. A non-empty shape lists the same either way.
          inputSchema: tool.strictInput ? inputSchemaOf(tool) : tool.inputSchema,
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
          ...(tool.annotations ? { annotations: tool.annotations } : {})
        },
        (async (args: Record<string, unknown>): Promise<ToolResult> => {
          try {
            if (tool.rows) {
              const r = await tool.rows(args, ctx);
              return ctx.output.table(r.rows, {
                ...(r.columns ? { columns: r.columns } : {}),
                ...(r.notice ? { notice: r.notice } : {}),
                emptyText: r.emptyText ?? profile.emptyText ?? DEFAULT_EMPTY_TEXT
              });
            }
            return await tool.handler!(args, ctx);
          } catch (error) {
            const base = genericErrorText(error);
            const hint = profile.describeError?.(error, tool.name) ?? null;
            const asJson = args?.response_format === "json";
            return ctx.output.error(hint ? `${base}\n${hint}` : base, asJson);
          }
        }) as never
      );
    }

    for (const resource of profile.resources ?? []) {
      server.registerResource(
        resource.name,
        new ResourceTemplate(resource.uriTemplate, { list: undefined }),
        {
          ...(resource.title ? { title: resource.title } : {}),
          ...(resource.description ? { description: resource.description } : {}),
          ...(resource.mimeType ? { mimeType: resource.mimeType } : {})
        },
        (async (uri: URL, variables: Record<string, string | string[]>) => resource.read(uri, variables, ctx)) as never
      );
    }

    for (const prompt of profile.prompts ?? []) {
      server.registerPrompt(
        prompt.name,
        {
          ...(prompt.title ? { title: prompt.title } : {}),
          description: prompt.description,
          ...(prompt.argsSchema ? { argsSchema: prompt.argsSchema } : {})
        },
        ((args: Record<string, unknown>): PromptResult => prompt.build(args ?? {})) as never
      );
    }
  }
}

/** The schema the SDK validates with: the shape, made strict when the tool asks for it. */
export function inputSchemaOf(tool: Pick<ToolSpec, "inputSchema" | "strictInput">): z.ZodObject<ZodRawShape> {
  const schema = z.object(tool.inputSchema);
  return tool.strictInput ? schema.strict() : schema;
}

/** The description a client sees: the profile's text, then its examples. */
export function describeTool(description: string, examples?: string[]): string {
  if (!examples?.length) return description;
  return `${description}\n\nExamples:\n${examples.map((e) => `  ${e}`).join("\n")}`;
}

/** One-line text prompt, as most guided prompts are. */
export function createTextPrompt(text: string): PromptResult {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}
