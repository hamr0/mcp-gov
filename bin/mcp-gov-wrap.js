#!/usr/bin/env node

/**
 * mcp-gov-wrap - Generic MCP Server Wrapper
 * Auto-discovers MCP servers and wraps them with governance proxy
 */

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, chmodSync } from 'node:fs';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { extractService, detectOperation } from '../src/operation-detector.js';

const execAsync = promisify(exec);

/**
 * Parse command line arguments
 * @returns {{ config: string, rules: string, tool: string, help: boolean }}
 */
function parseCliArgs() {
  try {
    const { values } = parseArgs({
      options: {
        config: {
          type: 'string',
          short: 'c',
        },
        rules: {
          type: 'string',
          short: 'r',
        },
        tool: {
          type: 'string',
          short: 't',
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
Usage: mcp-gov-wrap --config <config.json> [--rules <rules.json>] [--tool <command>]

Options:
  --config, -c    Path to MCP config file (e.g., ~/.config/claude/config.json)
  --rules, -r     Path to governance rules file (optional, defaults to ~/.mcp-gov/rules.json)
  --tool, -t      Tool command to execute after wrapping (optional, e.g., "claude chat")
  --help, -h      Show this help message

Description:
  Auto-discovers unwrapped MCP servers in config and wraps them with governance proxy.
  If rules file doesn't exist, generates one with safe defaults (allow read/write, deny delete/admin/execute).
  On subsequent runs, detects new servers and adds rules for them (delta approach).
  Creates a timestamped backup of the config file before modification.
  Supports both Claude Code format (projects.mcpServers) and flat format (mcpServers).

Examples:
  # Wrap servers (minimal - uses defaults)
  mcp-gov-wrap --config ~/.config/claude/config.json

  # Wrap servers and launch Claude Code
  mcp-gov-wrap --config ~/.config/claude/config.json --tool "claude chat"

  # Wrap servers with custom rules
  mcp-gov-wrap --config ~/.config/claude/config.json --rules ~/custom-rules.json
`);
  process.exit(0);
}

/**
 * Validate required arguments
 * @param {{ config?: string, rules?: string, tool?: string }} args
 */
function validateArgs(args) {
  const errors = [];

  if (!args.config) {
    errors.push('--config argument is required');
  }

  // --rules is now optional, will default to ~/.mcp-gov/rules.json
  // --tool is now optional

  if (errors.length > 0) {
    console.error('Error: Missing required arguments\n');
    errors.forEach(err => console.error(`  ${err}`));
    console.error('\nUse --help for usage information');
    process.exit(1);
  }
}

/**
 * Load and parse config file with format detection
 * @param {string} configPath - Path to config.json
 * @returns {{ allMcpServers: Array<{path: string, servers: Object}>, format: string, rawConfig: Object }} Config data and detected format
 */
function loadConfig(configPath) {
  // Check if file exists
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  // Read and parse JSON
  let configData;
  try {
    const content = readFileSync(configPath, 'utf8');
    configData = JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${error.message}`);
    }
    throw new Error(`Failed to read config file: ${error.message}`);
  }

  // Detect format and extract ALL mcpServers sections
  let allMcpServers = [];
  let format;

  if (configData.projects && typeof configData.projects === 'object') {
    // Multi-project format: { projects: { "/path1": { mcpServers: {...} }, "/path2": { mcpServers: {...} } } }
    format = 'multi-project';
    for (const [projectPath, projectConfig] of Object.entries(configData.projects)) {
      if (projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        allMcpServers.push({
          path: projectPath,
          servers: projectConfig.mcpServers
        });
      }
    }
  } else if (configData.mcpServers) {
    // Flat format: { mcpServers: {...} }
    format = 'flat';
    allMcpServers.push({
      path: 'root',
      servers: configData.mcpServers
    });
  }

  if (allMcpServers.length === 0) {
    throw new Error('No mcpServers found in config. Config must contain "mcpServers" (flat) or "projects[*].mcpServers" (multi-project)');
  }

  return { allMcpServers, format, rawConfig: configData };
}

/**
 * Load and validate rules file
 * @param {string} rulesPath - Path to rules.json
 * @returns {Object} Parsed rules object
 */
function loadAndValidateRules(rulesPath) {
  // Check if file exists
  if (!existsSync(rulesPath)) {
    throw new Error(`Rules file not found: ${rulesPath}`);
  }

  // Read and parse JSON
  let rulesData;
  try {
    const content = readFileSync(rulesPath, 'utf8');
    rulesData = JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in rules file: ${error.message}`);
    }
    throw new Error(`Failed to read rules file: ${error.message}`);
  }

  // Validate rules structure
  if (!rulesData.rules || !Array.isArray(rulesData.rules)) {
    throw new Error('Rules file must contain a "rules" array');
  }

  // Validate each rule
  rulesData.rules.forEach((rule, index) => {
    if (!rule.service) {
      throw new Error(`Rule at index ${index}: "service" field is required`);
    }

    if (!rule.operations || !Array.isArray(rule.operations)) {
      throw new Error(`Rule at index ${index}: "operations" field is required and must be an array`);
    }

    if (!rule.permission) {
      throw new Error(`Rule at index ${index}: "permission" field is required`);
    }

    if (rule.permission !== 'allow' && rule.permission !== 'deny') {
      throw new Error(`Rule at index ${index}: "permission" must be "allow" or "deny", got "${rule.permission}"`);
    }
  });

  return rulesData;
}

/**
 * Check if a server is already wrapped with mcp-gov-proxy
 * @param {Object} serverConfig - Server configuration object
 * @returns {boolean} True if already wrapped
 */
function isServerWrapped(serverConfig) {
  if (!serverConfig.command) {
    return false;
  }
  return serverConfig.command.includes('mcp-gov-proxy');
}

/**
 * Detect unwrapped servers in config
 * @param {Object} mcpServers - MCP servers configuration
 * @returns {{ wrapped: string[], unwrapped: string[] }} Lists of wrapped and unwrapped server names
 */
function detectUnwrappedServers(mcpServers) {
  const wrapped = [];
  const unwrapped = [];

  for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
    if (isServerWrapped(serverConfig)) {
      wrapped.push(serverName);
    } else {
      unwrapped.push(serverName);
    }
  }

  return { wrapped, unwrapped };
}

/**
 * Wrap a server configuration with mcp-gov-proxy
 * @param {string} serverName - Name of the server (key in mcpServers)
 * @param {Object} serverConfig - Original server configuration
 * @param {string} rulesPath - Absolute path to rules.json
 * @returns {Object} Wrapped server configuration
 */
function wrapServer(serverName, serverConfig, rulesPath) {
  const originalArgs = Array.isArray(serverConfig.args) ? serverConfig.args : [];

  // Build the human-readable target string (command + args). Kept for backward
  // compatibility and display; the proxy uses --target-args for execution.
  let targetCommand = serverConfig.command || '';
  if (originalArgs.length > 0) {
    targetCommand += ' ' + originalArgs.join(' ');
  }
  targetCommand = targetCommand.trim();

  // Authoritative argv passed to the proxy as a JSON array: [command, ...args].
  // This preserves argument boundaries (e.g. paths containing spaces) that the
  // whitespace-joined --target string cannot represent.
  const targetArgv = [serverConfig.command || '', ...originalArgs];

  // Create wrapped configuration
  const wrappedConfig = {
    command: 'mcp-gov-proxy',
    args: [
      '--service', serverName,
      '--target', targetCommand,
      '--target-args', JSON.stringify(targetArgv),
      '--rules', rulesPath
    ],
    _original: {
      command: serverConfig.command,
      args: originalArgs
    }
  };

  // Preserve environment variables if they exist
  if (serverConfig.env) {
    wrappedConfig.env = { ...serverConfig.env };
  }

  return wrappedConfig;
}

/**
 * Create a timestamped backup of the config file
 * @param {string} configPath - Path to config file
 * @returns {string} Path to backup file
 */
function createBackup(configPath) {
  const now = new Date();

  // Format: YYYYMMDD-HHMMSS
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const second = String(now.getSeconds()).padStart(2, '0');

  const timestamp = `${year}${month}${day}-${hour}${minute}${second}`;
  const backupPath = `${configPath}.backup-${timestamp}`;

  copyFileSync(configPath, backupPath);
  // MCP configs frequently embed secrets (API tokens in `env`). Restrict the
  // backup to owner-only so the copy does not widen exposure beyond the original.
  try {
    chmodSync(backupPath, 0o600);
  } catch {
    // Non-POSIX filesystems may not support chmod; the copy still succeeded.
  }

  return backupPath;
}

/**
 * Discover tools from an MCP server by spawning it and querying tools/list
 * @param {Object} serverConfig - Server configuration {command, args}
 * @param {string} serverName - Name of the server
 * @returns {Promise<string[]>} Array of tool names
 */
async function discoverServerTools(serverConfig, serverName) {
  return new Promise((resolve, reject) => {
    // Build command
    const command = serverConfig.command || '';
    const args = serverConfig.args || [];

    // Spawn the server
    const child = spawn(command, args, {
      env: { ...process.env, ...serverConfig.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let toolsList = [];
    let responseBuffer = '';
    let timeout;

    // Set timeout for discovery (5 seconds)
    timeout = setTimeout(() => {
      child.kill();
      console.error(`  Warning: Discovery timeout for ${serverName}, using service-level defaults`);
      resolve([]);
    }, 5000);

    // Send tools/list request
    const listRequest = JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 1
    }) + '\n';

    child.stdin.write(listRequest);

    // Read response
    child.stdout.on('data', (data) => {
      responseBuffer += data.toString();

      // Try to parse JSON-RPC response
      const lines = responseBuffer.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const response = JSON.parse(line);
          if (response.id === 1 && response.result && response.result.tools) {
            toolsList = response.result.tools.map(t => t.name);
            clearTimeout(timeout);
            child.kill();
            resolve(toolsList);
            return;
          }
        } catch (e) {
          // Not valid JSON yet, continue buffering
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      console.error(`  Warning: Failed to discover tools from ${serverName}: ${err.message}`);
      resolve([]);
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (toolsList.length === 0) {
        console.error(`  Warning: No tools discovered from ${serverName}, using service-level defaults`);
      }
      resolve(toolsList);
    });
  });
}

/**
 * Generate default rules for a service with safe defaults
 * @param {string} serviceName - Service name
 * @param {string[]} tools - Array of tool names
 * @returns {Object[]} Array of rule objects
 */
function generateDefaultRules(serviceName, tools) {
  const rules = [];
  const safeDefaults = {
    read: 'allow',
    write: 'allow',
    delete: 'deny',
    execute: 'deny',
    admin: 'deny'
  };

  // Always emit an explicit rule for every operation type, regardless of which
  // tools were discovered. This keeps the generated rule set complete so a
  // `defaultPolicy: "deny"` file never accidentally blocks ordinary read/write
  // traffic, and it states the intended posture explicitly rather than relying
  // on a fallthrough default. Discovered tool names are still used (below, by
  // the caller's logging) but do not change the safe-default policy.
  void tools;
  for (const [operation, permission] of Object.entries(safeDefaults)) {
    const rule = {
      service: serviceName,
      operations: [operation],
      permission: permission
    };

    if (permission === 'deny') {
      rule.reason = `${operation.charAt(0).toUpperCase() + operation.slice(1)} operations denied by default for safety`;
    }

    rules.push(rule);
  }

  return rules;
}

/**
 * Ensure rules file exists, generate with safe defaults if needed
 * @param {string} rulesPath - Path to rules.json
 * @param {Object} mcpServers - MCP servers configuration
 * @returns {Promise<Object>} Loaded or generated rules
 */
async function ensureRulesExist(rulesPath, mcpServers) {
  // Ensure directory exists
  const rulesDir = dirname(rulesPath);
  if (!existsSync(rulesDir)) {
    mkdirSync(rulesDir, { recursive: true });
  }

  // Check if rules file exists
  if (existsSync(rulesPath)) {
    // Load existing rules and check for new servers
    const existingRules = loadAndValidateRules(rulesPath);
    const existingServices = new Set(existingRules.rules.map(r => r.service));

    // Find new servers not in rules
    const allServers = Object.keys(mcpServers);
    const newServers = allServers.filter(serverName => !existingServices.has(serverName));

    if (newServers.length === 0) {
      console.log(`Using rules from: ${rulesPath}`);
      return existingRules;
    }

    // Discover and add rules for new servers
    console.log(`\nDiscovered ${newServers.length} new server(s) not in rules:`);
    newServers.forEach(name => console.log(`  - ${name}`));
    console.log('\nGenerating safe defaults for new servers...');

    const newRules = [];
    for (const serverName of newServers) {
      const serverConfig = mcpServers[serverName];
      console.log(`  Discovering tools from ${serverName}...`);

      const tools = await discoverServerTools(serverConfig, serverName);
      const rules = generateDefaultRules(serverName, tools);
      newRules.push(...rules);

      console.log(`  ✓ Added ${rules.length} rule(s) for ${serverName}`);
    }

    // Merge with existing rules. Preserve the existing file's defaultPolicy
    // verbatim (including its absence) so updating an existing install never
    // silently changes its fail-open/fail-closed posture.
    const mergedRules = {
      _comment: 'Auto-generated governance rules. Edit as needed.',
      _location: rulesPath,
      ...(existingRules.defaultPolicy ? { defaultPolicy: existingRules.defaultPolicy } : {}),
      rules: [...existingRules.rules, ...newRules]
    };

    // Save merged rules
    writeFileSync(rulesPath, JSON.stringify(mergedRules, null, 2) + '\n');
    console.log(`\n✓ Updated rules file: ${rulesPath}`);
    console.log('\nTo customize governance rules, edit: ' + rulesPath);

    return mergedRules;
  } else {
    // First run - generate rules for all servers
    console.log('\nNo rules file found - generating with safe defaults...');

    const allRules = [];
    const serverNames = Object.keys(mcpServers);

    if (serverNames.length === 0) {
      console.log('No MCP servers found in config');
      const emptyRules = {
        _comment: 'Auto-generated governance rules. Add servers and run again.',
        _location: rulesPath,
        defaultPolicy: 'deny',
        rules: []
      };
      writeFileSync(rulesPath, JSON.stringify(emptyRules, null, 2) + '\n');
      return emptyRules;
    }

    console.log(`Discovering tools from ${serverNames.length} server(s)...`);

    for (const serverName of serverNames) {
      const serverConfig = mcpServers[serverName];
      console.log(`  Discovering ${serverName}...`);

      const tools = await discoverServerTools(serverConfig, serverName);
      const rules = generateDefaultRules(serverName, tools);
      allRules.push(...rules);

      if (tools.length > 0) {
        console.log(`  ✓ Found ${tools.length} tool(s), generated ${rules.length} rule(s)`);
      } else {
        console.log(`  ✓ Generated ${rules.length} service-level rule(s)`);
      }
    }

    // Create rules file. New installs are fail-closed by default: anything not
    // matched by an explicit rule below is denied (the generated rules cover
    // read/write/delete/execute/admin for every service, so normal traffic is
    // unaffected). Set "defaultPolicy": "allow" to restore the permissive mode.
    const rulesData = {
      _comment: 'Auto-generated governance rules. Edit as needed.',
      _location: rulesPath,
      defaultPolicy: 'deny',
      rules: allRules
    };

    writeFileSync(rulesPath, JSON.stringify(rulesData, null, 2) + '\n');
    console.log(`\n✓ Generated rules file: ${rulesPath}`);

    // Show summary
    const deniedOps = allRules.filter(r => r.permission === 'deny');
    const allowedOps = allRules.filter(r => r.permission === 'allow');
    console.log(`\nSafe defaults applied:`);
    console.log(`  ✓ Allow: ${allowedOps.map(r => r.operations).flat().join(', ')}`);
    console.log(`  ✗ Deny: ${deniedOps.map(r => r.operations).flat().join(', ')}`);
    console.log('\nTo customize governance rules, edit: ' + rulesPath);

    return rulesData;
  }
}

/**
 * Main entry point
 */
async function main() {
  const args = parseCliArgs();

  if (args.help) {
    showUsage();
  }

  validateArgs(args);

  // Load config file
  let config;
  try {
    config = loadConfig(args.config);
    console.log(`Loaded config in ${config.format} format`);

    // Count total servers across all projects
    const totalServersCount = config.allMcpServers.reduce((sum, item) =>
      sum + Object.keys(item.servers).length, 0);

    if (config.format === 'multi-project') {
      console.log(`Found ${config.allMcpServers.length} project(s) with ${totalServersCount} total MCP servers`);
    } else {
      console.log(`Found ${totalServersCount} MCP servers`);
    }
  } catch (error) {
    console.error(`Error loading config: ${error.message}`);
    process.exit(1);
  }

  // Determine rules path (use provided or default to ~/.mcp-gov/rules.json)
  const rulesPath = args.rules || join(homedir(), '.mcp-gov', 'rules.json');

  // Collect all servers from all projects for rules generation
  const allServers = {};
  for (const { servers } of config.allMcpServers) {
    Object.assign(allServers, servers);
  }

  // Ensure rules file exists (generate if needed with delta approach)
  let rules;
  try {
    rules = await ensureRulesExist(rulesPath, allServers);
  } catch (error) {
    console.error(`Error with rules: ${error.message}`);
    process.exit(1);
  }

  // Detect unwrapped servers across ALL projects
  let allWrapped = [];
  let allUnwrapped = [];

  for (const { path: projectPath, servers } of config.allMcpServers) {
    const { wrapped, unwrapped } = detectUnwrappedServers(servers);
    allWrapped.push(...wrapped.map(name => ({ project: projectPath, name })));
    allUnwrapped.push(...unwrapped.map(name => ({ project: projectPath, name })));
  }

  const totalServers = allWrapped.length + allUnwrapped.length;

  if (totalServers === 0) {
    console.log('No servers found in config');
  } else {
    console.log(`\nServer status (across all projects):`);
    console.log(`  Total: ${totalServers}`);
    console.log(`  Already wrapped: ${allWrapped.length}`);
    console.log(`  Need wrapping: ${allUnwrapped.length}`);

    if (allWrapped.length > 0) {
      console.log(`\nAlready wrapped servers:`);
      allWrapped.forEach(({ project, name }) => {
        if (config.format === 'multi-project') {
          console.log(`  - ${name} (${project})`);
        } else {
          console.log(`  - ${name}`);
        }
      });
    }

    if (allUnwrapped.length > 0) {
      console.log(`\nServers to wrap:`);
      allUnwrapped.forEach(({ project, name }) => {
        if (config.format === 'multi-project') {
          console.log(`  - ${name} (${project})`);
        } else {
          console.log(`  - ${name}`);
        }
      });
    } else {
      console.log(`\nAll servers already wrapped, no action needed`);
    }
  }

  // Wrap servers if needed
  if (allUnwrapped.length > 0) {
    console.log(`\nWrapping ${allUnwrapped.length} server(s)...`);

    // Create backup before modifying
    try {
      const backupPath = createBackup(args.config);
      console.log(`✓ Created backup: ${backupPath}`);
    } catch (error) {
      console.error(`Error creating backup: ${error.message}`);
      process.exit(1);
    }

    // Get absolute path for rules
    const absoluteRulesPath = resolve(rulesPath);

    // Wrap servers in each project
    const modifiedConfig = JSON.parse(JSON.stringify(config.rawConfig));

    for (const { path: projectPath, servers } of config.allMcpServers) {
      const { unwrapped } = detectUnwrappedServers(servers);

      if (unwrapped.length > 0) {
        // Get reference to this project's mcpServers
        let targetServers;
        if (config.format === 'multi-project') {
          targetServers = modifiedConfig.projects[projectPath].mcpServers;
        } else {
          targetServers = modifiedConfig.mcpServers;
        }

        // Wrap unwrapped servers in this project
        for (const serverName of unwrapped) {
          const originalConfig = targetServers[serverName];
          targetServers[serverName] = wrapServer(serverName, originalConfig, absoluteRulesPath);
        }
      }
    }

    // Write updated config
    try {
      writeFileSync(args.config, JSON.stringify(modifiedConfig, null, 2) + '\n');
      console.log(`✓ Updated config file: ${args.config}`);
    } catch (error) {
      console.error(`Error writing config file: ${error.message}`);
      process.exit(1);
    }
  }

  // Execute tool command if provided
  if (args.tool) {
    console.log(`\nExecuting tool command: ${args.tool}`);
    try {
      const { stdout, stderr } = await execAsync(args.tool, {
        shell: true,
        encoding: 'utf8'
      });

      if (stdout) {
        console.log(stdout);
      }
      if (stderr) {
        console.error(stderr);
      }
    } catch (error) {
      // exec throws on non-zero exit codes, but we still want to show output
      if (error.stdout) {
        console.log(error.stdout);
      }
      if (error.stderr) {
        console.error(error.stderr);
      }
      console.error(`\nTool command exited with code ${error.code || 'unknown'}`);
      process.exit(error.code || 1);
    }
  } else {
    console.log(`\n✓ Wrapping complete!`);
  }
}

main().catch(error => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
