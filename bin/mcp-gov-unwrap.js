#!/usr/bin/env node

/**
 * mcp-gov-unwrap - MCP Server Unwrapper
 * Unwraps MCP servers by restoring original configuration from _original field
 */

import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * Parse command line arguments
 * @returns {{ config: string, tool: string, help: boolean }}
 */
function parseCliArgs() {
  try {
    const { values } = parseArgs({
      options: {
        config: {
          type: 'string',
          short: 'c',
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
Usage: mcp-gov-unwrap --config <config.json> [--tool <command>]

Options:
  --config, -c    Path to MCP config file (e.g., ~/.config/claude/config.json)
  --tool, -t      Tool command to execute after unwrapping (optional, e.g., "claude chat")
  --help, -h      Show this help message

Description:
  Unwraps MCP servers by restoring original configuration from _original field.
  Creates a timestamped backup of the config file before modification.
  Supports both Claude Code format (projects.mcpServers) and flat format (mcpServers).
  Only unwraps servers that have the _original field (previously wrapped by mcp-gov-wrap).

Examples:
  # Unwrap all wrapped servers
  mcp-gov-unwrap --config ~/.config/claude/config.json

  # Unwrap servers and launch Claude Code
  mcp-gov-unwrap --config ~/.config/claude/config.json --tool "claude chat"
`);
  process.exit(0);
}

/**
 * Validate required arguments
 * @param {{ config?: string, tool?: string }} args
 */
function validateArgs(args) {
  const errors = [];

  if (!args.config) {
    errors.push('--config argument is required');
  }

  // --tool is optional for unwrap

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
 * Check if a server is wrapped (has _original field)
 * @param {Object} serverConfig - Server configuration object
 * @returns {boolean} True if wrapped (has _original field)
 */
function isServerWrapped(serverConfig) {
  return serverConfig._original !== undefined;
}

/**
 * Detect wrapped servers in config
 * @param {Object} mcpServers - MCP servers configuration
 * @returns {{ wrapped: string[], unwrapped: string[], malformed: string[] }} Lists of wrapped, unwrapped, and malformed server names
 */
function detectWrappedServers(mcpServers) {
  const wrapped = [];
  const unwrapped = [];
  const malformed = [];

  for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
    // Check if server looks wrapped (mcp-gov-proxy) but missing _original
    if (serverConfig.command && serverConfig.command.includes('mcp-gov-proxy') && !serverConfig._original) {
      malformed.push(serverName);
    } else if (isServerWrapped(serverConfig)) {
      wrapped.push(serverName);
    } else {
      unwrapped.push(serverName);
    }
  }

  return { wrapped, unwrapped, malformed };
}

/**
 * Unwrap a server configuration by restoring from _original
 * @param {Object} serverConfig - Wrapped server configuration
 * @returns {Object} Unwrapped server configuration
 */
function unwrapServer(serverConfig) {
  if (!serverConfig._original) {
    throw new Error('Server does not have _original field, cannot unwrap');
  }

  // Restore original command and args
  const unwrappedConfig = {
    command: serverConfig._original.command,
    args: serverConfig._original.args || []
  };

  // Preserve environment variables if they exist
  if (serverConfig.env) {
    unwrappedConfig.env = { ...serverConfig.env };
  }

  return unwrappedConfig;
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

  // Detect wrapped servers across ALL projects
  let allWrapped = [];
  let allUnwrapped = [];
  let allMalformed = [];

  for (const { path: projectPath, servers } of config.allMcpServers) {
    const { wrapped, unwrapped, malformed } = detectWrappedServers(servers);
    allWrapped.push(...wrapped.map(name => ({ project: projectPath, name })));
    allUnwrapped.push(...unwrapped.map(name => ({ project: projectPath, name })));
    allMalformed.push(...malformed.map(name => ({ project: projectPath, name })));
  }

  const totalServers = allWrapped.length + allUnwrapped.length + allMalformed.length;

  if (totalServers === 0) {
    console.log('No servers found in config');
  } else {
    console.log(`\nServer status (across all projects):`);
    console.log(`  Total: ${totalServers}`);
    console.log(`  Wrapped (can unwrap): ${allWrapped.length}`);
    console.log(`  Already unwrapped: ${allUnwrapped.length}`);

    if (allMalformed.length > 0) {
      console.log(`  Warning - cannot unwrap (missing _original): ${allMalformed.length}`);
    }

    if (allUnwrapped.length > 0) {
      console.log(`\nAlready unwrapped servers:`);
      allUnwrapped.forEach(({ project, name }) => {
        if (config.format === 'multi-project') {
          console.log(`  - ${name} (${project})`);
        } else {
          console.log(`  - ${name}`);
        }
      });
    }

    if (allMalformed.length > 0) {
      console.log(`\nWarning: These servers appear wrapped but are missing _original field (cannot unwrap):`);
      allMalformed.forEach(({ project, name }) => {
        if (config.format === 'multi-project') {
          console.log(`  - ${name} (${project})`);
        } else {
          console.log(`  - ${name}`);
        }
      });
    }

    if (allWrapped.length > 0) {
      console.log(`\nServers to unwrap:`);
      allWrapped.forEach(({ project, name }) => {
        if (config.format === 'multi-project') {
          console.log(`  - ${name} (${project})`);
        } else {
          console.log(`  - ${name}`);
        }
      });
    } else if (allMalformed.length === 0) {
      console.log(`\nAll servers already unwrapped, no action needed`);
    }
  }

  // Unwrap servers if needed
  if (allWrapped.length > 0) {
    console.log(`\nUnwrapping ${allWrapped.length} server(s)...`);

    // Create backup before modifying
    try {
      const backupPath = createBackup(args.config);
      console.log(`✓ Created backup: ${backupPath}`);
    } catch (error) {
      console.error(`Error creating backup: ${error.message}`);
      process.exit(1);
    }

    // Unwrap servers in each project
    const modifiedConfig = JSON.parse(JSON.stringify(config.rawConfig));

    for (const { path: projectPath, servers } of config.allMcpServers) {
      const { wrapped } = detectWrappedServers(servers);

      if (wrapped.length > 0) {
        // Get reference to this project's mcpServers
        let targetServers;
        if (config.format === 'multi-project') {
          targetServers = modifiedConfig.projects[projectPath].mcpServers;
        } else {
          targetServers = modifiedConfig.mcpServers;
        }

        // Unwrap wrapped servers in this project
        for (const serverName of wrapped) {
          const originalConfig = targetServers[serverName];

          try {
            targetServers[serverName] = unwrapServer(originalConfig);
          } catch (error) {
            console.warn(`Warning: Cannot unwrap ${serverName}: ${error.message}`);
            // Skip this server, leave it as-is
          }
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
    console.log(`\n✓ Unwrapping complete!`);
  }
}

main().catch(error => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
