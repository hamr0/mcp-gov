/**
 * Integration tests for MCP Governance System
 * Tests end-to-end flows with proxy, wrapper, and GitHub example server
 */

import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync, mkdtempSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');
const proxyPath = join(projectRoot, 'bin', 'mcp-gov-proxy.js');
const wrapperPath = join(projectRoot, 'bin', 'mcp-gov-wrap.js');
const githubServerPath = join(projectRoot, 'examples', 'github', 'server.js');
const githubRulesPath = join(projectRoot, 'examples', 'github', 'rules.json');

// The github example server (examples/github/server.js) calls process.exit(1)
// unless GITHUB_TOKEN is set, so without it the proxy's target dies and every
// request times out — which is what failed under the new publish test gate in
// CI. These tests don't exercise the real GitHub API (allow assertions are
// lenient; denied ops are blocked by the proxy before any call), so a
// placeholder token is enough to let the target boot. A real token in the
// environment is preserved if present. Spawned proxy/target inherit this.
process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'test-token-placeholder';

/**
 * Helper to spawn a process and collect stdio
 * @param {string} command - Command to run
 * @param {string[]} args - Arguments
 * @param {object} options - Spawn options
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number, process: object}>}
 */
async function spawnProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (exitCode) => {
      resolve({ stdout, stderr, exitCode, process: child });
    });
  });
}

/**
 * Send JSON-RPC message to a process and wait for response
 * @param {object} childProcess - Spawned process
 * @param {object} message - JSON-RPC message
 * @returns {Promise<string>} Response from server
 */
function sendJsonRpcMessage(childProcess, message) {
  return new Promise((resolve, reject) => {
    let responseData = '';
    let responseReceived = false;

    const timeout = setTimeout(() => {
      if (!responseReceived) {
        reject(new Error('Timeout waiting for JSON-RPC response'));
      }
    }, 5000);

    const dataHandler = (data) => {
      responseData += data.toString();
      // Check if we have a complete JSON-RPC message
      const lines = responseData.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          try {
            JSON.parse(line);
            responseReceived = true;
            clearTimeout(timeout);
            childProcess.stdout.removeListener('data', dataHandler);
            resolve(line);
            return;
          } catch (e) {
            // Not a complete message yet
          }
        }
      }
    };

    childProcess.stdout.on('data', dataHandler);

    // Send message
    childProcess.stdin.write(JSON.stringify(message) + '\n');
  });
}

describe('Integration: Proxy with GitHub Server', () => {
  let tempDir;
  let tempRulesPath;

  beforeEach(() => {
    // Create temp directory for test rules
    tempDir = mkdtempSync(join(tmpdir(), 'mcp-gov-test-'));
    tempRulesPath = join(tempDir, 'rules.json');
  });

  afterEach(() => {
    // Clean up temp directory
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('3.2: proxy blocks github_delete_repo with deny rule', async () => {
    // Create rules with deny for delete operations
    const rules = {
      services: {
        github: {
          operations: {
            read: 'allow',
            write: 'allow',
            delete: 'deny',
            execute: 'allow',
            admin: 'deny'
          }
        }
      }
    };
    writeFileSync(tempRulesPath, JSON.stringify(rules, null, 2));

    // Spawn proxy with GitHub server as target
    const proxy = spawn('node', [
      proxyPath,
      '--target', `node ${githubServerPath}`,
      '--rules', tempRulesPath
    ]);

    let stderrOutput = '';
    proxy.stderr.on('data', (data) => {
      stderrOutput += data.toString();
    });

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 500));

    // Send initialize request
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    };

    await sendJsonRpcMessage(proxy, initRequest);

    // Send delete request (should be denied)
    const deleteRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'github_delete_repo',
        arguments: { repo_name: 'test/repo' }
      }
    };

    const response = await sendJsonRpcMessage(proxy, deleteRequest);
    const responseObj = JSON.parse(response);

    // Verify permission denied
    assert.ok(responseObj.error, 'Response should contain error');
    assert.match(responseObj.error.message, /permission denied/i, 'Error should mention permission denied');

    // Verify audit log
    assert.match(stderrOutput, /github_delete_repo/, 'Audit log should contain tool name');
    assert.match(stderrOutput, /github/, 'Audit log should contain service');
    assert.match(stderrOutput, /delete/, 'Audit log should contain operation');
    assert.match(stderrOutput, /DENIED/, 'Audit log should show DENIED status');

    // Clean up
    proxy.kill();
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  test('3.3: proxy allows github_list_repos with allow rule', async () => {
    // Create rules with allow for read operations
    const rules = {
      services: {
        github: {
          operations: {
            read: 'allow',
            write: 'allow',
            delete: 'deny',
            execute: 'allow',
            admin: 'deny'
          }
        }
      }
    };
    writeFileSync(tempRulesPath, JSON.stringify(rules, null, 2));

    // Spawn proxy with GitHub server as target
    const proxy = spawn('node', [
      proxyPath,
      '--target', `node ${githubServerPath}`,
      '--rules', tempRulesPath
    ]);

    let stderrOutput = '';
    proxy.stderr.on('data', (data) => {
      stderrOutput += data.toString();
    });

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 500));

    // Send initialize request
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    };

    await sendJsonRpcMessage(proxy, initRequest);

    // Send list request (should be allowed)
    const listRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'github_list_repos',
        arguments: { visibility: 'all' }
      }
    };

    const response = await sendJsonRpcMessage(proxy, listRequest);
    const responseObj = JSON.parse(response);

    // Verify no error (operation allowed)
    assert.ok(!responseObj.error || responseObj.result, 'Response should not contain error or should have result');

    // Verify audit log shows ALLOWED
    assert.match(stderrOutput, /github_list_repos/, 'Audit log should contain tool name');
    assert.match(stderrOutput, /github/, 'Audit log should contain service');
    assert.match(stderrOutput, /read|list/, 'Audit log should contain operation');
    assert.match(stderrOutput, /ALLOWED/, 'Audit log should show ALLOWED status');

    // Clean up
    proxy.kill();
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  test('3.5: audit logs appear in stderr with correct format', async () => {
    // Create rules
    const rules = {
      services: {
        github: {
          operations: {
            read: 'allow',
            delete: 'deny'
          }
        }
      }
    };
    writeFileSync(tempRulesPath, JSON.stringify(rules, null, 2));

    // Spawn proxy with GitHub server as target
    const proxy = spawn('node', [
      proxyPath,
      '--target', `node ${githubServerPath}`,
      '--rules', tempRulesPath
    ]);

    let stderrOutput = '';
    proxy.stderr.on('data', (data) => {
      stderrOutput += data.toString();
    });

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 500));

    // Send initialize request
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    };

    await sendJsonRpcMessage(proxy, initRequest);

    // Send a denied request
    const deleteRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'github_delete_repo',
        arguments: { repo_name: 'test/repo' }
      }
    };

    await sendJsonRpcMessage(proxy, deleteRequest);

    // Verify audit log format contains all required fields
    const logLines = stderrOutput.split('\n').filter(line => line.includes('github_delete_repo'));
    assert.ok(logLines.length > 0, 'Should have at least one audit log line');

    const logLine = logLines[0];

    // Check for timestamp (ISO 8601 format or similar)
    assert.match(logLine, /\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/, 'Log should contain timestamp');

    // Check for tool name
    assert.match(logLine, /github_delete_repo/, 'Log should contain tool name');

    // Check for service
    assert.match(logLine, /github/, 'Log should contain service name');

    // Check for operation
    assert.match(logLine, /delete/, 'Log should contain operation type');

    // Check for decision
    assert.match(logLine, /DENIED|ALLOWED/, 'Log should contain decision');

    // Clean up
    proxy.kill();
    await new Promise(resolve => setTimeout(resolve, 100));
  });
});

describe('Integration: Wrapper with Config Files', () => {
  let tempDir;
  let tempConfigPath;
  let tempRulesPath;
  let tempBackupDir;

  beforeEach(() => {
    // Create temp directory for test configs
    tempDir = mkdtempSync(join(tmpdir(), 'mcp-gov-wrap-test-'));
    tempConfigPath = join(tempDir, 'config.json');
    tempRulesPath = join(tempDir, 'rules.json');
    tempBackupDir = tempDir; // Backups will be in same dir
  });

  afterEach(() => {
    // Clean up temp directory
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('3.4: wrapper detects and wraps unwrapped GitHub server', async () => {
    // Create unwrapped config
    const config = {
      mcpServers: {
        github: {
          command: 'node',
          args: [githubServerPath],
          env: {
            GITHUB_TOKEN: 'fake-token'
          }
        }
      }
    };
    writeFileSync(tempConfigPath, JSON.stringify(config, null, 2));

    // Create rules file (wrapper format)
    const rules = {
      rules: [
        {
          service: 'github',
          operations: ['delete'],
          permission: 'deny'
        }
      ]
    };
    writeFileSync(tempRulesPath, JSON.stringify(rules, null, 2));

    // Run wrapper
    const result = await spawnProcess('node', [
      wrapperPath,
      '--config', tempConfigPath,
      '--rules', tempRulesPath,
      '--tool', 'echo "wrapped"'
    ]);

    // Debug output if failed
    if (result.exitCode !== 0) {
      console.error('Wrapper failed with stderr:', result.stderr);
      console.error('Wrapper stdout:', result.stdout);
    }

    // Verify wrapper succeeded
    assert.strictEqual(result.exitCode, 0, 'Wrapper should exit successfully');

    // Read modified config
    const modifiedConfig = JSON.parse(readFileSync(tempConfigPath, 'utf-8'));

    // Verify server was wrapped
    assert.ok(modifiedConfig.mcpServers.github, 'GitHub server should still exist');
    assert.match(
      modifiedConfig.mcpServers.github.command,
      /mcp-gov-proxy/,
      'Command should contain mcp-gov-proxy'
    );

    // Verify original command is preserved in args
    const argsString = modifiedConfig.mcpServers.github.args.join(' ');
    assert.match(argsString, /node/, 'Args should preserve original command');
    assert.match(argsString, new RegExp(githubServerPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'Args should preserve server path');

    // Verify env is preserved
    assert.ok(modifiedConfig.mcpServers.github.env, 'Environment should be preserved');

    // Verify backup was created
    const files = readdirSync(tempDir);
    const backupFiles = files.filter(f => f.startsWith('config.json.backup-'));
    assert.ok(backupFiles.length > 0, 'Backup file should be created');
  });

  test('3.6: end-to-end flow (add server → wrap → block delete)', async () => {
    // Step 1: Create initial config with unwrapped server
    const config = {
      mcpServers: {
        github: {
          command: 'node',
          args: [githubServerPath],
          env: {
            GITHUB_TOKEN: 'fake-token'
          }
        }
      }
    };
    writeFileSync(tempConfigPath, JSON.stringify(config, null, 2));

    // Step 2: Create rules with delete denied
    // Wrapper needs wrapper format
    const wrapperRules = {
      rules: [
        {
          service: 'github',
          operations: ['delete'],
          permission: 'deny'
        }
      ]
    };
    writeFileSync(tempRulesPath, JSON.stringify(wrapperRules, null, 2));

    // Create proxy rules file (proxy needs proxy format)
    const proxyRulesPath = join(tempDir, 'proxy-rules.json');
    const proxyRules = {
      services: {
        github: {
          operations: {
            read: 'allow',
            delete: 'deny'
          }
        }
      }
    };
    writeFileSync(proxyRulesPath, JSON.stringify(proxyRules, null, 2));

    // Step 3: Run wrapper to wrap the server
    const wrapResult = await spawnProcess('node', [
      wrapperPath,
      '--config', tempConfigPath,
      '--rules', tempRulesPath,
      '--tool', 'echo "wrapped"'
    ]);

    assert.strictEqual(wrapResult.exitCode, 0, 'Wrapper should succeed');

    // Step 4: Read wrapped config
    const wrappedConfig = JSON.parse(readFileSync(tempConfigPath, 'utf-8'));

    // Verify wrapping
    assert.match(
      wrappedConfig.mcpServers.github.command,
      /mcp-gov-proxy/,
      'Server should be wrapped with proxy'
    );

    // Step 5: Start the wrapped server directly (simulate what would happen in real usage)
    // We'll use the proxy directly with the GitHub server (using proxy rules format)
    const proxy = spawn('node', [
      proxyPath,
      '--target', `node ${githubServerPath}`,
      '--rules', proxyRulesPath
    ]);

    let stderrOutput = '';
    proxy.stderr.on('data', (data) => {
      stderrOutput += data.toString();
    });

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 500));

    // Step 6: Send initialize request
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    };

    await sendJsonRpcMessage(proxy, initRequest);

    // Step 7: Attempt delete (should be blocked)
    const deleteRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'github_delete_repo',
        arguments: { repo_name: 'test/repo' }
      }
    };

    const deleteResponse = await sendJsonRpcMessage(proxy, deleteRequest);
    const deleteResponseObj = JSON.parse(deleteResponse);

    // Verify delete was blocked
    assert.ok(deleteResponseObj.error, 'Delete should return error');
    assert.match(deleteResponseObj.error.message, /permission denied/i, 'Should be permission denied');

    // Verify audit log
    assert.match(stderrOutput, /DENIED/, 'Audit log should show DENIED');
    assert.match(stderrOutput, /delete/, 'Audit log should show delete operation');

    // Step 8: Attempt list (should be allowed)
    const listRequest = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'github_list_repos',
        arguments: { visibility: 'all' }
      }
    };

    const listResponse = await sendJsonRpcMessage(proxy, listRequest);
    const listResponseObj = JSON.parse(listResponse);

    // Verify list was allowed (no error or has result)
    assert.ok(!listResponseObj.error || listResponseObj.result, 'List should succeed');

    // Verify audit log shows allowed
    assert.match(stderrOutput, /ALLOWED/, 'Audit log should show ALLOWED');

    // Clean up
    proxy.kill();
    await new Promise(resolve => setTimeout(resolve, 100));
  });
});

describe('Integration: Wrapper Idempotency', () => {
  let tempDir;
  let tempConfigPath;
  let tempRulesPath;

  beforeEach(() => {
    // Create temp directory
    tempDir = mkdtempSync(join(tmpdir(), 'mcp-gov-idempotent-test-'));
    tempConfigPath = join(tempDir, 'config.json');
    tempRulesPath = join(tempDir, 'rules.json');
  });

  afterEach(() => {
    // Clean up
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('wrapper should not double-wrap already wrapped servers', async () => {
    // Create config with unwrapped server
    const config = {
      mcpServers: {
        github: {
          command: 'node',
          args: [githubServerPath]
        }
      }
    };
    writeFileSync(tempConfigPath, JSON.stringify(config, null, 2));

    // Create rules (wrapper format)
    const rules = {
      rules: [
        {
          service: 'github',
          operations: ['read'],
          permission: 'allow'
        }
      ]
    };
    writeFileSync(tempRulesPath, JSON.stringify(rules, null, 2));

    // Run wrapper first time
    const firstRun = await spawnProcess('node', [
      wrapperPath,
      '--config', tempConfigPath,
      '--rules', tempRulesPath,
      '--tool', 'echo "done"'
    ]);

    assert.strictEqual(firstRun.exitCode, 0, 'First wrap should succeed');

    const afterFirstWrap = readFileSync(tempConfigPath, 'utf-8');

    // Run wrapper second time
    const secondRun = await spawnProcess('node', [
      wrapperPath,
      '--config', tempConfigPath,
      '--rules', tempRulesPath,
      '--tool', 'echo "done"'
    ]);

    assert.strictEqual(secondRun.exitCode, 0, 'Second wrap should succeed');

    const afterSecondWrap = readFileSync(tempConfigPath, 'utf-8');

    // Verify config is identical after second wrap (idempotent)
    assert.strictEqual(afterFirstWrap, afterSecondWrap, 'Config should be unchanged on second wrap');
  });
});
