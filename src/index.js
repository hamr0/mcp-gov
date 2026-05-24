/**
 * GovernedMCPServer - MCP Server with permission control and audit logging.
 * Middleware wrapper that intercepts tool registration to inject governance.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { parseToolName } from './operation-detector.js';
import { normalizeRules, isAllowed } from './rules.js';

/**
 * @typedef {Object} ServerConfig
 * @property {string} name - Server name
 * @property {string} version - Server version
 */

/**
 * @typedef {Object.<string, Object.<string, 'allow'|'deny'>>} PermissionRules
 */

/**
 * @typedef {Object} ToolDefinition
 * @property {string} name - Tool name
 * @property {string} description - Tool description
 * @property {Object} inputSchema - JSON Schema for input
 */

/**
 * @typedef {function(any): Promise<Object>} ToolHandler
 */

/**
 * MCP Server with governance layer for permission control and audit logging.
 */
export class GovernedMCPServer {
  /**
   * @param {ServerConfig} config - Server configuration {name, version}
   * @param {PermissionRules} rules - Permission rules {serviceName: {operation: 'allow'|'deny'}}
   */
  constructor(config, rules = {}) {
    this.config = config;
    this.rules = rules;
    // Normalize whatever rule shape was passed (nested-map, legacy object, or
    // array) into one canonical form, sharing the same matcher as the proxy.
    // defaultPolicy is read from the rules object first (the documented
    // location), falling back to the config object; defaults to 'allow' for
    // backward compatibility.
    this.normalizedRules = normalizeRules(rules, config.defaultPolicy);
    this.defaultPolicy = this.normalizedRules.defaultPolicy;
    this.tools = new Map(); // Store tool definitions and handlers
    this.server = new Server(
      {
        name: config.name,
        version: config.version
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    // Set up tool handlers
    this._setupHandlers();
  }

  /**
   * Set up MCP protocol handlers for listing and calling tools.
   * @private
   */
  _setupHandlers() {
    // Handle tools/list request
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: Array.from(this.tools.values()).map(t => ({
          name: t.definition.name,
          description: t.definition.description,
          inputSchema: t.definition.inputSchema
        }))
      };
    });

    // Handle tools/call request
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const args = request.params.arguments || {};

      const tool = this.tools.get(toolName);
      if (!tool) {
        return {
          content: [
            {
              type: 'text',
              text: `Unknown tool: ${toolName}`
            }
          ],
          isError: true
        };
      }

      // Check permission
      const allowed = this.checkPermission(toolName);

      if (!allowed) {
        this.logOperation(toolName, args, 'denied', 'Permission denied by governance rules');

        return {
          content: [
            {
              type: 'text',
              text: `Permission denied: ${toolName} is not allowed by governance policy`
            }
          ],
          isError: true
        };
      }

      this.logOperation(toolName, args, 'allowed');

      try {
        const result = await tool.handler(args);
        this.logOperation(toolName, args, 'success');
        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logOperation(toolName, args, 'error', errorMessage);
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${errorMessage}`
            }
          ],
          isError: true
        };
      }
    });
  }

  /**
   * Check if a tool operation is permitted by rules.
   * @param {string} toolName - Tool name to check
   * @returns {boolean} True if allowed, false if denied
   */
  checkPermission(toolName) {
    const { service, operation } = parseToolName(toolName);
    return isAllowed(this.normalizedRules, service, operation);
  }

  /**
   * Log operation to stderr as structured JSON.
   * @param {string} tool - Tool name
   * @param {Object|string} args - Arguments (will be truncated to 200 chars)
   * @param {string} status - Status: 'allowed', 'denied', 'success', 'error'
   * @param {string} detail - Optional detail message
   */
  logOperation(tool, args, status, detail = '') {
    const argsStr = typeof args === 'string' ? args : JSON.stringify(args);
    const truncatedArgs = argsStr.length > 200 ? argsStr.substring(0, 200) + '...' : argsStr;

    const logEntry = {
      timestamp: new Date().toISOString(),
      tool,
      args: truncatedArgs,
      status,
      detail
    };

    console.error(JSON.stringify(logEntry));
  }

  /**
   * Register a tool with governance wrapper.
   * @param {ToolDefinition} toolDef - Tool definition {name, description, inputSchema}
   * @param {ToolHandler} handler - Async handler function
   */
  registerTool(toolDef, handler) {
    this.tools.set(toolDef.name, {
      definition: toolDef,
      handler
    });
  }

  /**
   * Start the MCP server with stdio transport.
   */
  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('MCP Server started:', this.config.name, 'v' + this.config.version);
  }
}
