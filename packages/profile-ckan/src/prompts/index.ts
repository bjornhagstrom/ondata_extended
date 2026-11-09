// Ported from ondata/ckan-mcp-server src/prompts/index.ts at 09e8cdc (MIT, see NOTICE.md): same order.
import { themePrompt } from "./theme.js";
import { organizationPrompt } from "./organization.js";
import { formatPrompt } from "./format.js";
import { recentPrompt } from "./recent.js";
import { datasetAnalysisPrompt } from "./dataset-analysis.js";
import { hvdPrompt } from "./hvd.js";

export const CKAN_PROMPTS = [themePrompt, organizationPrompt, formatPrompt, recentPrompt, datasetAnalysisPrompt, hvdPrompt];
