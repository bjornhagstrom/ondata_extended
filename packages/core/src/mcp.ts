/**
 * Registration of profiles on an McpServer.
 *
 * The SDK is wrapped here so that a later move to SDK v2 is a core change, not a profile
 * change. Registration checks what ondata/ckan-mcp-server checked by hand or not at all:
 * unique tool names across profiles, the profile prefix, and that every tool a prompt tells
 * the model to call exists.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Profile, PromptResult, ToolResult } from "@ondata-extended/profile-contract";
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
          inputSchema: tool.inputSchema,
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
          ...(tool.annotations ? { annotations: tool.annotations } : {})
        },
        (async (args: Record<string, unknown>): Promise<ToolResult> => {
          try {
            return await tool.handler(args, ctx);
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

/** The description a client sees: the profile's text, then its examples. */
export function describeTool(description: string, examples?: string[]): string {
  if (!examples?.length) return description;
  return `${description}\n\nExamples:\n${examples.map((e) => `  ${e}`).join("\n")}`;
}

/** One-line text prompt, as most guided prompts are. */
export function createTextPrompt(text: string): PromptResult {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}
