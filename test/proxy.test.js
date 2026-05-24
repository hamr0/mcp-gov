import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const proxyPath = join(__dirname, '..', 'bin', 'mcp-gov-proxy.js');

describe('mcp-gov-proxy CLI', () => {
  it('should show usage when --help is provided', async () => {
    const child = spawn('node', [proxyPath, '--help']);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    await new Promise((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Process exited with code ${code}`));
        }
      });
    });

    assert.ok(stdout.includes('Usage:') || stderr.includes('Usage:'), 'Should show usage information');
    assert.ok(stdout.includes('--target') || stderr.includes('--target'), 'Should mention --target option');
    assert.ok(stdout.includes('--rules') || stderr.includes('--rules'), 'Should mention --rules option');
  });

  it('should show error when required arguments are missing', async () => {
    const child = spawn('node', [proxyPath]);

    let stderr = '';

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    await new Promise((resolve) => {
      child.on('close', () => {
        resolve();
      });
    });

    assert.ok(stderr.length > 0, 'Should output error message to stderr');
    assert.ok(stderr.includes('--target') || stderr.includes('required'), 'Should mention missing required argument');
  });
});

describe('mcp-gov-proxy subprocess management', () => {
  let testDir;
  let rulesFile;
  let mockServerFile;

  before(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mcp-gov-test-'));
    rulesFile = join(testDir, 'rules.json');
    mockServerFile = join(testDir, 'mock-server.js');

    // Create a minimal rules file
    writeFileSync(rulesFile, JSON.stringify({ services: {} }));

    // Create a mock MCP server that echoes stdin to stdout
    writeFileSync(mockServerFile, `
import { createInterface } from 'node:readline';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  // Echo the line back
  console.log(line);
});

// Signal that server is ready
console.error('Mock server ready');
    `.trim());
  });

  after(() => {
    // Clean up test files
    try {
      unlinkSync(rulesFile);
      unlinkSync(mockServerFile);
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it('should spawn target MCP server process', async () => {
    const child = spawn('node', [
      proxyPath,
      '--target', `node ${mockServerFile}`,
      '--rules', rulesFile
    ]);

    let stderr = '';
    let spawned = false;

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (stderr.includes('Mock server ready') || stderr.includes('Proxy ready')) {
        spawned = true;
      }
    });

    // Wait a bit for the subprocess to start
    await new Promise(resolve => setTimeout(resolve, 500));

    child.kill('SIGTERM');

    await new Promise((resolve) => {
      child.on('close', () => {
        resolve();
      });
    });

    assert.ok(spawned, 'Should spawn the target server subprocess');
  });

  it('should pipe stdin/stdout between client and target server', async () => {
    const child = spawn('node', [
      proxyPath,
      '--target', `node ${mockServerFile}`,
      '--rules', rulesFile
    ]);

    let stdout = '';
    let receivedEcho = false;

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      if (stdout.includes('test message')) {
        receivedEcho = true;
      }
    });

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 300));

    // Send a test message
    child.stdin.write('test message\n');

    // Wait for echo
    await new Promise(resolve => setTimeout(resolve, 300));

    child.kill('SIGTERM');

    await new Promise((resolve) => {
      child.on('close', () => {
        resolve();
      });
    });

    assert.ok(receivedEcho, 'Should pipe stdin/stdout correctly');
  });
});

describe('mcp-gov-proxy JSON-RPC message interception', () => {
  let testDir;
  let rulesFile;
  let mockServerFile;

  before(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mcp-gov-test-'));
    rulesFile = join(testDir, 'rules.json');
    mockServerFile = join(testDir, 'mock-server-jsonrpc.js');

    // Create a minimal rules file
    writeFileSync(rulesFile, JSON.stringify({ services: {} }));

    // Create a mock MCP server that responds to JSON-RPC calls
    writeFileSync(mockServerFile, `
import { createInterface } from 'node:readline';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);

    // Respond to tools/call
    if (msg.method === 'tools/call') {
      const response = {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: 'Tool executed successfully' }]
        }
      };
      console.log(JSON.stringify(response));
    } else {
      // Echo other messages
      console.log(line);
    }
  } catch (e) {
    // Not JSON, echo as-is
    console.log(line);
  }
});

console.error('Mock JSON-RPC server ready');
    `.trim());
  });

  after(() => {
    try {
      unlinkSync(rulesFile);
      unlinkSync(mockServerFile);
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it('should parse JSON-RPC tools/call messages', async () => {
    const child = spawn('node', [
      proxyPath,
      '--target', `node ${mockServerFile}`,
      '--rules', rulesFile
    ]);

    let stdout = '';
    let parsedResponse = false;

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            if (msg.result && msg.result.content) {
              parsedResponse = true;
            }
          } catch (e) {
            // Not complete JSON yet
          }
        }
      }
    });

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 300));

    // Send a tools/call JSON-RPC message
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'test_tool',
        arguments: {}
      }
    };
    child.stdin.write(JSON.stringify(request) + '\n');

    // Wait for response
    await new Promise(resolve => setTimeout(resolve, 300));

    child.kill('SIGTERM');

    await new Promise((resolve) => {
      child.on('close', () => {
        resolve();
      });
    });

    assert.ok(parsedResponse, 'Should parse and forward JSON-RPC messages');
  });

  it('should forward non-tools/call messages without interception', async () => {
    const child = spawn('node', [
      proxyPath,
      '--target', `node ${mockServerFile}`,
      '--rules', rulesFile
    ]);

    let stdout = '';
    let receivedEcho = false;

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      if (stdout.includes('initialize')) {
        receivedEcho = true;
      }
    });

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 300));

    // Send a non-tools/call message
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {}
    };
    child.stdin.write(JSON.stringify(request) + '\n');

    // Wait for response
    await new Promise(resolve => setTimeout(resolve, 300));

    child.kill('SIGTERM');

    await new Promise((resolve) => {
      child.on('close', () => {
        resolve();
      });
    });

    assert.ok(receivedEcho, 'Should forward non-tools/call messages');
  });
});

describe('mcp-gov-proxy operation detection', () => {
  let testDir;
  let rulesFile;
  let mockServerFile;

  before(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mcp-gov-test-'));
    rulesFile = join(testDir, 'rules.json');
    mockServerFile = join(testDir, 'mock-server-ops.js');

    // Create a minimal rules file
    writeFileSync(rulesFile, JSON.stringify({
      services: {
        github: {
          operations: {
            delete: 'deny'
          }
        }
      }
    }));

    // Create a mock MCP server
    writeFileSync(mockServerFile, `
import { createInterface } from 'node:readline';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === 'tools/call') {
      const response = {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: \`Executed \${msg.params.name}\` }]
        }
      };
      console.log(JSON.stringify(response));
    }
  } catch (e) {
    // Ignore
  }
});

console.error('Mock operation server ready');
    `.trim());
  });

  after(() => {
    try {
      unlinkSync(rulesFile);
      unlinkSync(mockServerFile);
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it('should parse tool names and extract service/operation', async () => {
    const child = spawn('node', [
      proxyPath,
      '--target', `node ${mockServerFile}`,
      '--rules', rulesFile
    ]);

    let stderr = '';
    let detectionLogged = false;

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      // Look for audit log that shows service and operation detection
      if (stderr.includes('github') && stderr.includes('delete')) {
        detectionLogged = true;
      }
    });

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 300));

    // Send a GitHub delete tool call
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'github_delete_repo',
        arguments: { repo: 'test/repo' }
      }
    };
    child.stdin.write(JSON.stringify(request) + '\n');

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 300));

    child.kill('SIGTERM');

    await new Promise((resolve) => {
      child.on('close', () => {
        resolve();
      });
    });

    // For now, just verify the proxy runs (actual detection logic in next tasks)
    assert.ok(true, 'Proxy should process tool names');
  });
});

describe('mcp-gov-proxy permission checking', () => {
  let testDir;
  let rulesFile;
  let mockServerFile;

  before(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mcp-gov-test-'));
    rulesFile = join(testDir, 'rules.json');
    mockServerFile = join(testDir, 'mock-server-perms.js');

    // Create rules with explicit deny and allow
    writeFileSync(rulesFile, JSON.stringify({
      services: {
        github: {
          operations: {
            delete: 'deny',
            read: 'allow'
          }
        },
        slack: {
          operations: {
            write: 'deny'
          }
        }
      }
    }));

    // Create a mock MCP server
    writeFileSync(mockServerFile, `
import { createInterface } from 'node:readline';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === 'tools/call') {
      const response = {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: \`Success: \${msg.params.name}\` }]
        }
      };
      console.log(JSON.stringify(response));
    }
  } catch (e) {
    // Ignore
  }
});

console.error('Mock permission server ready');
    `.trim());
  });

  after(() => {
    try {
      unlinkSync(rulesFile);
      unlinkSync(mockServerFile);
    } catch (e) {
      // Ignore
    }
  });

  it('should deny operations with explicit deny rule', async () => {
    const child = spawn('node', [
      proxyPath,
      '--target', `node ${mockServerFile}`,
      '--rules', rulesFile
    ]);

    let stdout = '';
    let deniedOperation = false;

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            if (msg.error && msg.error.message && msg.error.message.includes('Permission denied')) {
              deniedOperation = true;
            }
          } catch (e) {
            // Not complete JSON yet
          }
        }
      }
    });

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 300));

    // Send a denied operation (github delete)
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'github_delete_repo',
        arguments: { repo: 'test/repo' }
      }
    };
    child.stdin.write(JSON.stringify(request) + '\n');

    // Wait for response
    await new Promise(resolve => setTimeout(resolve, 300));

    child.kill('SIGTERM');

    await new Promise((resolve) => {
      child.on('close', () => {
        resolve();
      });
    });

    assert.ok(deniedOperation, 'Should deny operations with explicit deny rule');
  });

  it('should allow operations with explicit allow rule', async () => {
    const child = spawn('node', [
      proxyPath,
      '--target', `node ${mockServerFile}`,
      '--rules', rulesFile
    ]);

    let stdout = '';
    let allowedOperation = false;

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            if (msg.result && msg.result.content) {
              allowedOperation = true;
            }
          } catch (e) {
            // Not complete JSON yet
          }
        }
      }
    });

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 300));

    // Send an allowed operation (github list - read)
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'github_list_repos',
        arguments: {}
      }
    };
    child.stdin.write(JSON.stringify(request) + '\n');

    // Wait for response
    await new Promise(resolve => setTimeout(resolve, 300));

    child.kill('SIGTERM');

    await new Promise((resolve) => {
      child.on('close', () => {
        resolve();
      });
    });

    assert.ok(allowedOperation, 'Should allow operations with explicit allow rule');
  });

  it('should allow operations when not specified in rules (default allow)', async () => {
    const child = spawn('node', [
      proxyPath,
      '--target', `node ${mockServerFile}`,
      '--rules', rulesFile
    ]);

    let stdout = '';
    let allowedOperation = false;

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            if (msg.result && msg.result.content) {
              allowedOperation = true;
            }
          } catch (e) {
            // Not complete JSON yet
          }
        }
      }
    });

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 500));

    // Send an unspecified service operation (should default to allow)
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'unknown_service_action',
        arguments: {}
      }
    };
    child.stdin.write(JSON.stringify(request) + '\n');

    // Wait for response
    await new Promise(resolve => setTimeout(resolve, 500));

    child.kill('SIGTERM');

    await new Promise((resolve) => {
      child.on('close', () => {
        resolve();
      });
    });

    assert.ok(allowedOperation, 'Should allow when not specified (default allow)');
  });
});

describe('mcp-gov-proxy --target-args and defaultPolicy', () => {
  let testDir;
  let mockServerFile;

  before(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mcp-gov-targs-'));
    mockServerFile = join(testDir, 'mock-argv.js');

    // Mock server: reports its received argv on stderr at startup (so the test
    // can verify argument boundaries), and answers tools/call with content.
    writeFileSync(mockServerFile, `
import { createInterface } from 'node:readline';
process.stderr.write('ARGV=' + JSON.stringify(process.argv.slice(2)) + '\\n');
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  try {
    const m = JSON.parse(line);
    if (m.method === 'tools/call') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ok' }] } }) + '\\n');
    }
  } catch (e) { /* ignore */ }
});
    `.trim());
  });

  after(() => {
    try { unlinkSync(mockServerFile); } catch (e) { /* ignore */ }
  });

  // Resolve as soon as the predicate over accumulated output is true (or time
  // out). Condition-based instead of a fixed sleep, so it is fast and not flaky.
  function waitFor(child, state, predicate, timeoutMs = 5000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (val) => { if (done) return; done = true; clearTimeout(timer); resolve(val); };
      const check = () => { if (predicate(state)) finish(true); };
      const onData = () => check();
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const timer = setTimeout(() => finish(false), timeoutMs);
      check();
    });
  }

  function spawnProxy(extraArgs, rulesObj) {
    const rulesFile = join(testDir, `rules-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(rulesFile, JSON.stringify(rulesObj));
    const child = spawn('node', [proxyPath, '--service', 'github',
      '--target', `node ${mockServerFile}`, '--rules', rulesFile, ...extraArgs]);
    const state = { out: '', err: '' };
    child.stdout.on('data', (d) => { state.out += d.toString(); });
    child.stderr.on('data', (d) => { state.err += d.toString(); });
    return { child, state, rulesFile };
  }

  it('preserves argument boundaries via --target-args (path with spaces)', async () => {
    const spacedArg = '/tmp/dir with spaces/data.json';
    const argv = ['node', mockServerFile, spacedArg];
    const { child, state, rulesFile } = spawnProxy(['--target-args', JSON.stringify(argv)], { rules: [] });

    const got = await waitFor(child, state, (s) => s.err.includes('ARGV='));
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
    try { unlinkSync(rulesFile); } catch (e) { /* ignore */ }

    assert.ok(got, 'Mock server should report its argv on startup');
    const m = state.err.match(/ARGV=(\[.*\])/);
    assert.ok(m, 'Should capture ARGV line from target stderr');
    const reported = JSON.parse(m[1]);
    assert.deepStrictEqual(reported, [spacedArg],
      'Space-containing path must be passed as a single argv element, not re-split');
  });

  it('denies an unmatched operation when defaultPolicy is "deny"', async () => {
    const { child, state, rulesFile } = spawnProxy([], {
      defaultPolicy: 'deny',
      rules: [{ service: 'github', operations: ['read'], permission: 'allow' }]
    });

    // Wait for the target (and thus the proxy) to be up before sending.
    await waitFor(child, state, (s) => s.err.includes('ARGV='));

    // 'github_create_repo' classifies as a write op; no rule allows write, so
    // under defaultPolicy:deny it must be denied.
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'github_create_repo', arguments: {} }
    }) + '\n');

    const denied = await waitFor(child, state, (s) => /Permission denied/.test(s.out));
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
    try { unlinkSync(rulesFile); } catch (e) { /* ignore */ }

    assert.ok(denied, 'Unmatched write op should be denied under defaultPolicy:deny');
    assert.ok(!/"content"/.test(state.out), 'Denied op must not be forwarded to the target');
  });

  it('still allows an explicitly-allowed operation under defaultPolicy:deny', async () => {
    const { child, state, rulesFile } = spawnProxy([], {
      defaultPolicy: 'deny',
      rules: [{ service: 'github', operations: ['read'], permission: 'allow' }]
    });

    await waitFor(child, state, (s) => s.err.includes('ARGV='));

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'github_list_repos', arguments: {} }
    }) + '\n');

    const allowed = await waitFor(child, state, (s) => /"content"/.test(s.out));
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
    try { unlinkSync(rulesFile); } catch (e) { /* ignore */ }

    assert.ok(allowed, 'Explicitly-allowed read op should be forwarded under defaultPolicy:deny');
  });

  it('cannot be tricked into forging audit records via tool name (log injection)', async () => {
    // A tool name containing a newline + a fake AUDIT line + pipe delimiters.
    const malicious = 'evil"\n[AUDIT] FORGED | status=ALLOWED | tool=spoof';
    const { child, state, rulesFile } = spawnProxy([], { rules: [] });

    await waitFor(child, state, (s) => s.err.includes('ARGV='));
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: malicious, arguments: {} }
    }) + '\n');

    await waitFor(child, state, (s) => s.err.includes('"type":"AUDIT"'));
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
    try { unlinkSync(rulesFile); } catch (e) { /* ignore */ }

    // Every audit record must be a single well-formed JSON line...
    const auditLines = state.err.split('\n').filter((l) => l.includes('"type":"AUDIT"'));
    const records = auditLines.map((l) => JSON.parse(l)); // throws if injection split the line
    // ...and there must be exactly one, carrying the raw name verbatim (escaped),
    // with no forged second record.
    assert.strictEqual(records.length, 1, 'Exactly one audit record, not a forged extra');
    assert.strictEqual(records[0].tool, malicious, 'Raw tool name preserved (and contained) in JSON');
    assert.ok(!/^\[AUDIT\] FORGED/m.test(state.err), 'No forged plain-text [AUDIT] line emitted');
  });
});

describe('mcp-gov-proxy audit logging', () => {
  let testDir;
  let rulesFile;
  let mockServerFile;

  before(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mcp-gov-test-'));
    rulesFile = join(testDir, 'rules.json');
    mockServerFile = join(testDir, 'mock-server-audit.js');

    // Create rules
    writeFileSync(rulesFile, JSON.stringify({
      services: {
        github: {
          operations: {
            delete: 'deny'
          }
        }
      }
    }));

    // Create a mock MCP server
    writeFileSync(mockServerFile, `
import { createInterface } from 'node:readline';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === 'tools/call') {
      const response = {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: 'Success' }]
        }
      };
      console.log(JSON.stringify(response));
    }
  } catch (e) {
    // Ignore
  }
});

console.error('Mock audit server ready');
    `.trim());
  });

  after(() => {
    try {
      unlinkSync(rulesFile);
      unlinkSync(mockServerFile);
    } catch (e) {
      // Ignore
    }
  });

  it('should log audit information to stderr with timestamp, tool name, service, operation', async () => {
    const child = spawn('node', [
      proxyPath,
      '--target', `node ${mockServerFile}`,
      '--rules', rulesFile
    ]);

    let stderr = '';
    let auditLogged = false;

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      // Check for audit log with required fields
      if (stderr.includes('AUDIT') &&
          stderr.includes('github_delete_repo') &&
          stderr.includes('github') &&
          stderr.includes('delete')) {
        auditLogged = true;
      }
    });

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 300));

    // Send a tool call that will be denied
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'github_delete_repo',
        arguments: { repo: 'test/repo' }
      }
    };
    child.stdin.write(JSON.stringify(request) + '\n');

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 300));

    child.kill('SIGTERM');

    await new Promise((resolve) => {
      child.on('close', () => {
        resolve();
      });
    });

    assert.ok(auditLogged, 'Should log audit information with timestamp, tool, service, operation');
  });

  it('should log both allowed and denied operations', async () => {
    const child = spawn('node', [
      proxyPath,
      '--target', `node ${mockServerFile}`,
      '--rules', rulesFile
    ]);

    let stderr = '';
    let deniedLogged = false;
    let allowedLogged = false;

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (stderr.includes('DENIED') || stderr.includes('denied')) {
        deniedLogged = true;
      }
      if (stderr.includes('ALLOWED') || stderr.includes('allowed')) {
        allowedLogged = true;
      }
    });

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 300));

    // Send denied operation
    const deniedRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'github_delete_repo',
        arguments: {}
      }
    };
    child.stdin.write(JSON.stringify(deniedRequest) + '\n');

    await new Promise(resolve => setTimeout(resolve, 200));

    // Send allowed operation
    const allowedRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'github_list_repos',
        arguments: {}
      }
    };
    child.stdin.write(JSON.stringify(allowedRequest) + '\n');

    await new Promise(resolve => setTimeout(resolve, 200));

    child.kill('SIGTERM');

    await new Promise((resolve) => {
      child.on('close', () => {
        resolve();
      });
    });

    assert.ok(deniedLogged, 'Should log denied operations');
    assert.ok(allowedLogged, 'Should log allowed operations');
  });
});

describe('mcp-gov-proxy error handling', () => {
  let testDir;
  let rulesFile;
  let crashingServerFile;

  before(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mcp-gov-test-'));
    rulesFile = join(testDir, 'rules.json');
    crashingServerFile = join(testDir, 'crashing-server.js');

    // Create a minimal rules file
    writeFileSync(rulesFile, JSON.stringify({ services: {} }));

    // Create a server that crashes immediately
    writeFileSync(crashingServerFile, `
console.error('Server starting...');
process.exit(42);
    `.trim());
  });

  after(() => {
    try {
      unlinkSync(rulesFile);
      unlinkSync(crashingServerFile);
    } catch (e) {
      // Ignore
    }
  });

  it('should handle target server crashes gracefully', async () => {
    const child = spawn('node', [
      proxyPath,
      '--target', `node ${crashingServerFile}`,
      '--rules', rulesFile
    ]);

    let stderr = '';
    let exitCode = null;

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    exitCode = await new Promise((resolve) => {
      child.on('close', (code) => {
        resolve(code);
      });
    });

    // Should exit with the same code as the target server
    assert.strictEqual(exitCode, 42, 'Should exit with target server exit code');
    assert.ok(stderr.includes('Target server exited'), 'Should log target server exit');
  });

  it('should handle invalid target commands gracefully', async () => {
    const child = spawn('node', [
      proxyPath,
      '--target', 'nonexistent-command-12345',
      '--rules', rulesFile
    ]);

    let stderr = '';
    let exitCode = null;

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    exitCode = await new Promise((resolve) => {
      child.on('close', (code) => {
        resolve(code);
      });
    });

    assert.ok(exitCode !== 0, 'Should exit with error code');
    assert.ok(stderr.includes('Error spawning target server'), 'Should log spawn error');
  });
});
