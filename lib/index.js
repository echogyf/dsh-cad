// DSH imports the native MCP client from its own installation.
// Python and MCP packages remain in a separate, plugin-owned virtualenv.
import * as McpClient from "@deepseek-ai/dsh-mcp-client";
import { createPlugin } from "./plugin.mjs";

const plugin = createPlugin(McpClient);
export const name = plugin.name;
export const inject = plugin.inject;
export const apply = plugin.apply;
