// Ported from ondata/ckan-mcp-server src/prompts/theme.ts at 09e8cdc (MIT, see NOTICE.md).
import { z } from "zod";
import { createTextPrompt } from "@ondata-extended/core";
import { definePrompt } from "../types.js";

export const THEME_PROMPT_NAME = "ckan-search-by-theme";

export const buildThemePromptText = (serverUrl: string, theme: string, rows: number): string => `# Guided search: datasets by theme

## Step 1: Find the theme/group
Use \`ckan_group_search\` to locate the group that matches the theme.

Example:

ckan_group_search({
  server_url: "${serverUrl}",
  pattern: "${theme}"
})

## Step 2: Search datasets in that group
Use \`ckan_package_search\` with a group filter.

Example:

ckan_package_search({
  server_url: "${serverUrl}",
  fq: "groups:<group_name>",
  sort: "metadata_modified desc",
  rows: ${rows}
})

## If no group matches
Fallback to a tag-based search using facets:

ckan_package_search({
  server_url: "${serverUrl}",
  q: "tags:${theme}",
  sort: "metadata_modified desc",
  rows: ${rows}
})

Note: metadata_modified is a CKAN record timestamp (publish time on source portals,
harvest time on aggregators). If the user asks for
content publication dates, prefer issued (or modified) with explicit ISO ranges.`;

export const themePrompt = definePrompt({
  name: THEME_PROMPT_NAME,
  title: "Search datasets by theme",
  description: "Guided prompt to discover a theme and search datasets under it.",
  argsSchema: {
    server_url: z.string().url().describe("Base URL of the CKAN server"),
    theme: z.string().min(1).describe("Theme or group name to search"),
    rows: z.coerce.number().int().positive().default(10).describe("Max results to return")
  },
  referencedTools: ["ckan_group_search", "ckan_package_search"],
  build({ server_url, theme, rows }) {
    return createTextPrompt(buildThemePromptText(server_url, theme, rows));
  }
});
