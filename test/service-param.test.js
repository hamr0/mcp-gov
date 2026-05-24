import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const proxyPath = join(__dirname, '..', 'bin', 'mcp-gov-proxy.js');

describe('mcp-gov-proxy --service parameter', () => {
  let testDir;
  let rulesFile;
  let mockServerFile;

  before(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mcp-gov-service-test-'));
    rulesFile = join(testDir, 'rules.json');
    mockServerFile = join(testDir, 'mock-server.js');

    // Create rules that deny read operations for "filesystem" service
    writeFileSync(rulesFile, JSON.stringify({
      services: {
        filesystem: {
          operations: {
            read: 'deny',
            write: 'allow',
            delete: 'deny'
          }
        }
      }
    }));

    // Create a mock MCP server that echoes JSON-RPC messages
    writeFileSync(mockServerFile, `
import { createInterface } from 'node:readline';

const rl = createInterface({
  input: process.stdin,
  terminal: false
});

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    // Echo back success response
    const response = {
      jsonrpc: '2.0',
      id: msg.id,
      result: { success: true }
    };
    console.log(JSON.stringify(response));
  } catch (e) {
    // Ignore parse errors
  }
});

console.error('Mock server ready');
    `.trim());
  });

  after(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it('should use provided --service parameter for rule matching', async () => {
    // Start proxy WITH --service parameter
    const child = spawn('node', [
      proxyPath,
      '--service', 'filesystem',
      '--target', `node ${mockServerFile}`,
      '--rules', rulesFile
    ]);

    let stdout = '';
    let stderr = '';
    let ready = false;

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (stderr.includes('Mock server ready') || stderr.includes('Proxy ready')) {
        ready = true;
      }
    });

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.ok(ready, 'Proxy should be ready');

    // Send a tools/call with list_directory (read operation)
    const toolsCall = {
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 1,
      params: {
        name: 'list_directory',
        arguments: {}
      }
    };

    child.stdin.write(JSON.stringify(toolsCall) + '\n');

    // Wait for response
    await new Promise(resolve => setTimeout(resolve, 500));

    child.kill('SIGTERM');
    await new Promise(resolve => child.on('close', resolve));

    // Check that operation was DENIED (because service=filesystem, operation=read, permission=deny)
    // Audit lines are structured JSON: {"type":"AUDIT",...,"service":"filesystem",...}
    assert.ok(stderr.includes('DENIED'), 'Should log DENIED in audit');
    assert.ok(stderr.includes('"service":"filesystem"'), 'Should use provided service name "filesystem"');
    assert.ok(stderr.includes('"operation":"read"'), 'Should detect read operation');

    // Response should be an error (permission denied)
    assert.ok(stdout.includes('error') || stdout.includes('Permission denied'),
      'Should return error response when denied');
  });

  it('should fall back to extracting service from tool name when --service not provided', async () => {
    // Start proxy WITHOUT --service parameter
    const child = spawn('node', [
      proxyPath,
      '--target', `node ${mockServerFile}`,
      '--rules', rulesFile
    ]);

    let stdout = '';
    let stderr = '';
    let ready = false;

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (stderr.includes('Mock server ready') || stderr.includes('Proxy ready')) {
        ready = true;
      }
    });

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.ok(ready, 'Proxy should be ready');

    // Send a tools/call with list_directory
    const toolsCall = {
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 1,
      params: {
        name: 'list_directory',
        arguments: {}
      }
    };

    child.stdin.write(JSON.stringify(toolsCall) + '\n');

    // Wait for response
    await new Promise(resolve => setTimeout(resolve, 500));

    child.kill('SIGTERM');
    await new Promise(resolve => child.on('close', resolve));

    // Without --service, it extracts "list" from "list_directory"
    // There's no rule for service="list", so it defaults to ALLOW
    assert.ok(stderr.includes('ALLOWED') || !stderr.includes('DENIED'),
      'Should allow when service not found in rules (default behavior)');
    assert.ok(stderr.includes('"service":"list"'),
      'Should extract service name "list" from tool name prefix');
  });
});
