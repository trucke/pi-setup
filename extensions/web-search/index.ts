import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createOptionalFirecrawlKeyProvider,
  registerDeveloperSearchTool,
} from "./developer.ts";
import { registerFetchTool } from "./fetch.ts";
import { registerHostedFetchTool } from "./hosted-fetch.ts";
import { createMcpCaller } from "./mcp.ts";
import { registerSearchTool } from "./search.ts";

export default function webSearch(pi: ExtensionAPI) {
  const call = createMcpCaller();
  const getApiKey = createOptionalFirecrawlKeyProvider();
  registerSearchTool(pi, call);
  registerFetchTool(pi, call);
  registerDeveloperSearchTool(pi, { getApiKey });
  if (process.env.PI_WEB_HOSTED_FETCH === "1")
    registerHostedFetchTool(pi, call);
}
