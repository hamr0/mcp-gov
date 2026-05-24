#!/usr/bin/env node

/**
 * mcp-gov-proxy - MCP Governance Proxy
 * Intercepts tool calls and checks permissions before forwarding to target MCP server
 */

import { parseArgs } from 'node:util';
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { extractService, detectOperation } from '../src/operation-detector.js';
import { normalizeRules, isAllowed } from '../src/rules.js';

// Default audit log path
const DEFAULT_AUDIT_LOG = join(homedir(), '.mcp-gov', 'audit.log');

/**
 * Parse command line arguments
 * @returns {{ target: string, rules: string, service: string, log: string, help: boolean }}
 */
function parseCliArgs() {
  try {
    const { values } = parseArgs({
      options: {
        service: {
          type: 'string',
          short: 's',
        },
        target: {
          type: 'string',
          short: 't',
        },
        'target-args': {
          type: 'string',
        },
        rules: {
          type: 'string',
          short: 'r',
        },
        log: {
          type: 'string',
          short: 'l',
        },
        help: {
          type: 'boolean',
          short: 'h',
        },
      },
      allowPositionals: false,
    });

    return values;
  } catch (error) {
    console.error(`Error parsing arguments: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Show usage information
 */
function showUsage() {
  console.log(`
Usage: mcp-gov-proxy [--service <name>] --target <command> --rules <rules.json> [--log <file>]

Options:
  --service, -s  Service name for rule matching (recommended, falls back to tool name prefix)
  --target, -t   Target MCP server command to wrap (required)
  --rules, -r    Path to rules.json file (required)
  --log, -l      Path to audit log file (optional, logs to file AND stderr)
  --help, -h     Show this help message

Description:
  Intercepts MCP tool calls and checks permissions before forwarding to target server.
  Provides audit logging and permission control based on rules.json.

  IMPORTANT: Use --service to ensure correct rule matching. Without it, the service
  name is extracted from tool name prefixes, which may not match your rules.

Examples:
  mcp-gov-proxy --service filesystem --target "npx -y @modelcontextprotocol/server-filesystem" --rules rules.json
  mcp-gov-proxy -s github -t "npx github-mcp" -r ./config/rules.json -l ~/.mcp-gov/audit.log
`);
}

/**
 * Parse JSON-RPC message
 * @param {string} line - Raw message line
 * @returns {object|null} Parsed message or null if not valid JSON-RPC
 */
function parseJsonRpcMessage(line) {
  try {
    const msg = JSON.parse(line);
    if (msg.jsonrpc === '2.0' && msg.method) {
      return msg;
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Check if message is a tools/call method
 * @param {object} message - Parsed JSON-RPC message
 * @returns {boolean}
 */
function isToolsCallMessage(message) {
  return message && message.method === 'tools/call';
}

/**
 * Load rules from JSON file
 * @param {string} rulesPath - Path to rules.json
 * @returns {object} Parsed rules object
 */
function loadRules(rulesPath) {
  try {
    const rulesContent = readFileSync(rulesPath, 'utf-8');
    return JSON.parse(rulesContent);
  } catch (error) {
    console.error(`Error loading rules file: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Create a JSON-RPC error response
 * @param {number|string} id - Request ID
 * @param {string} message - Error message
 * @returns {string} JSON-RPC error response
 */
function createErrorResponse(id, message) {
  const response = {
    jsonrpc: '2.0',
    id: id,
    error: {
      code: -32000,
      message: message
    }
  };
  return JSON.stringify(response);
}

/** @type {string|null} */
let auditLogPath = null;

/**
 * Log audit information to stderr and optionally to file.
 *
 * Emitted as a single JSON object per line. Tool/service names originate from
 * client-controlled JSON-RPC params; JSON encoding escapes newlines, quotes and
 * control characters, so a crafted name cannot forge additional audit records
 * or inject delimiter-shaped fields (closes the log-injection vector). The
 * "type":"AUDIT" tag keeps lines greppable.
 * @param {string} toolName - Tool name
 * @param {string} service - Service name
 * @param {string} operation - Operation type
 * @param {boolean} allowed - Whether operation was allowed
 */
function logAudit(toolName, service, operation, allowed) {
  const logLine = JSON.stringify({
    type: 'AUDIT',
    timestamp: new Date().toISOString(),
    status: allowed ? 'ALLOWED' : 'DENIED',
    tool: toolName,
    service: service,
    operation: operation,
    project: process.cwd()
  });

  // Always log to stderr
  console.error(logLine);

  // Also log to file if configured
  if (auditLogPath) {
    try {
      appendFileSync(auditLogPath, logLine + '\n');
    } catch (e) {
      console.error(`[AUDIT] Warning: Failed to write to log file: ${e.message}`);
    }
  }
}

/**
 * Start the proxy server
 * @param {string} serviceName - Service name for rule matching
 * @param {string} targetCommand - Command to spawn target MCP server
 * @param {string} rulesPath - Path to rules.json file
 * @param {string} logPath - Path to audit log file (optional override)
 */
function startProxy(serviceName, targetCommand, rulesPath, logPath, targetArgsJson) {
  // Set up audit logging - organize by service
  // Default: ~/.mcp-gov/logs/<service>.log
  if (logPath) {
    auditLogPath = logPath;
  } else {
    const logDir = join(homedir(), '.mcp-gov', 'logs');
    const serviceLogName = serviceName || 'unknown';
    auditLogPath = join(logDir, `${serviceLogName}.log`);
  }

  // Ensure log directory exists
  const logDir = dirname(auditLogPath);
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  // Load rules file and normalize to a single canonical form (handles array,
  // legacy object, and nested-map shapes; carries defaultPolicy).
  const normalizedRules = normalizeRules(loadRules(rulesPath));

  // Determine the command and argv for the target server.
  // Prefer the structured --target-args (a JSON array [command, ...args]) which
  // preserves argument boundaries; fall back to whitespace-splitting --target
  // for configs wrapped by older versions that did not emit --target-args.
  let command;
  let args;
  if (targetArgsJson) {
    let argv;
    try {
      argv = JSON.parse(targetArgsJson);
    } catch (e) {
      console.error(`Error parsing --target-args (expected JSON array): ${e.message}`);
      process.exit(1);
    }
    if (!Array.isArray(argv) || argv.length === 0) {
      console.error('Error: --target-args must be a non-empty JSON array [command, ...args]');
      process.exit(1);
    }
    command = argv[0];
    args = argv.slice(1);
  } else {
    const commandParts = targetCommand.split(/\s+/);
    command = commandParts[0];
    args = commandParts.slice(1);
  }

  // Spawn the target MCP server
  const targetServer = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Log to stderr that proxy is ready
  console.error('Proxy ready');

  // Set up readline interface for line-by-line processing from stdin
  const rl = createInterface({
    input: process.stdin,
    terminal: false
  });

  // Set up readline interface for target server stdout
  const targetRl = createInterface({
    input: targetServer.stdout,
    terminal: false
  });

  // Forward stderr from target server to our stderr
  targetServer.stderr.on('data', (data) => {
    process.stderr.write(data);
  });

  // Forward stdout from target server to our stdout (line by line)
  targetRl.on('line', (line) => {
    // For now, just forward everything (interception logic comes in later tasks)
    console.log(line);
  });

  // Process stdin messages
  rl.on('line', (line) => {
    // Parse JSON-RPC message
    const message = parseJsonRpcMessage(line);

    if (isToolsCallMessage(message)) {
      // Extract tool name from params
      const toolName = message.params?.name;

      if (toolName) {
        // Use provided service name, fallback to extracting from tool name for backward compatibility
        const service = serviceName || extractService(toolName);
        const operation = detectOperation(toolName);

        // Check permissions
        const allowed = isAllowed(normalizedRules, service, operation);

        // Log audit information
        logAudit(toolName, service, operation, allowed);

        if (allowed) {
          // Allowed - forward to target server
          targetServer.stdin.write(line + '\n');
        } else {
          // Denied - send error response
          const errorResponse = createErrorResponse(
            message.id,
            `[MCP-GOV] Permission denied: ${service}.${operation} operation on tool ${toolName}`
          );
          console.log(errorResponse);
        }
      } else {
        // No tool name, forward anyway
        targetServer.stdin.write(line + '\n');
      }
    } else {
      // Forward non-tools/call messages directly
      targetServer.stdin.write(line + '\n');
    }
  });

  // Handle target server exit
  targetServer.on('close', (code) => {
    console.error(`Target server exited with code ${code}`);
    process.exit(code || 0);
  });

  // Handle target server errors
  targetServer.on('error', (error) => {
    console.error(`Error spawning target server: ${error.message}`);
    process.exit(1);
  });

  // Handle proxy termination
  process.on('SIGTERM', () => {
    targetServer.kill('SIGTERM');
  });

  process.on('SIGINT', () => {
    targetServer.kill('SIGINT');
  });
}

/**
 * Main entry point
 */
function main() {
  const args = parseCliArgs();

  if (args.help) {
    showUsage();
    process.exit(0);
  }

  if (!args.target) {
    console.error('Error: --target is required');
    console.error('Run with --help for usage information');
    process.exit(1);
  }

  if (!args.rules) {
    console.error('Error: --rules is required');
    console.error('Run with --help for usage information');
    process.exit(1);
  }

  startProxy(args.service, args.target, args.rules, args.log, args['target-args']);
}

main();
