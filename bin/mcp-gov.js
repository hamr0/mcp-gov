#!/usr/bin/env node
/**
 * mcp-gov - Interactive CLI for MCP Governance System
 */

import * as readline from 'node:readline';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get version from package.json
let version = '1.1.0';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  version = pkg.version;
} catch (e) {
  // ignore
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

const logo = `
███╗   ███╗  ██████╗ ██████╗     ██████╗  ██████╗ ██╗   ██╗
████╗ ████║ ██╔════╝ ██╔══██╗   ██╔════╝ ██╔═══██╗██║   ██║
██╔████╔██║ ██║      ██████╔╝   ██║  ███╗██║   ██║██║   ██║
██║╚██╔╝██║ ██║      ██╔═══╝    ██║   ██║██║   ██║╚██╗ ██╔╝
██║ ╚═╝ ██║ ╚██████╗ ██║        ╚██████╔╝╚██████╔╝ ╚████╔╝
╚═╝     ╚═╝  ╚═════╝ ╚═╝         ╚═════╝  ╚═════╝   ╚═══╝
`;

async function main() {
  console.log(logo);
  console.log(`                                                    v${version}`);
  console.log('');
  console.log('Select action:');
  console.log('  1) Wrap MCP servers');
  console.log('  2) Unwrap MCP servers');
  console.log('  3) View audit logs');
  console.log('  4) Edit rules');
  console.log('  5) Exit');
  console.log('');

  const choice = await ask('Enter choice [1-5]: ');

  switch (choice.trim()) {
    case '1':
      await handleWrap();
      break;
    case '2':
      await handleUnwrap();
      break;
    case '3':
      await handleLogs();
      break;
    case '4':
      await handleRules();
      break;
    case '5':
      console.log('\nGoodbye!');
      rl.close();
      process.exit(0);
      break;
    default:
      console.log('Invalid choice');
      rl.close();
      process.exit(1);
  }
}

async function handleWrap() {
  let path;
  while (true) {
    const configPath = await ask('Enter config path (e.g. ~/.claude.json): ');
    const input = configPath.trim();

    if (!input) {
      console.log('Path required. Please try again.\n');
      continue;
    }

    // Expand a leading ~ or ~/ only; do not touch a ~ elsewhere in the path.
    path = input.replace(/^~(?=$|\/)/, homedir());

    if (existsSync(path)) {
      break;
    }
    console.log(`\nFile not found: ${path}`);
    console.log('Please try again.\n');
  }
  rl.close();

  console.log(`\nWrapping servers...\n`);

  const child = spawn('node', [join(__dirname, 'mcp-gov-wrap.js'), '--config', path], {
    stdio: 'inherit'
  });

  child.on('close', (code) => {
    process.exit(code);
  });
}

async function handleUnwrap() {
  let path;
  while (true) {
    const configPath = await ask('Enter config path (e.g. ~/.claude.json): ');
    const input = configPath.trim();

    if (!input) {
      console.log('Path required. Please try again.\n');
      continue;
    }

    // Expand a leading ~ or ~/ only; do not touch a ~ elsewhere in the path.
    path = input.replace(/^~(?=$|\/)/, homedir());

    if (existsSync(path)) {
      break;
    }
    console.log(`\nFile not found: ${path}`);
    console.log('Please try again.\n');
  }
  rl.close();

  console.log(`\nUnwrapping servers...\n`);

  const child = spawn('node', [join(__dirname, 'mcp-gov-unwrap.js'), '--config', path], {
    stdio: 'inherit'
  });

  child.on('close', (code) => {
    process.exit(code);
  });
}

async function handleLogs() {
  const logsDir = join(homedir(), '.mcp-gov', 'logs');
  rl.close();

  if (!existsSync(logsDir)) {
    console.log('\nNo audit logs found yet.');
    console.log(`Logs will appear in: ${logsDir}`);
    return;
  }

  const logFiles = readdirSync(logsDir).filter(f => f.endsWith('.log'));

  if (logFiles.length === 0) {
    console.log('\nNo audit logs found yet.');
    return;
  }

  // Show all log files
  for (const logFile of logFiles) {
    const logPath = join(logsDir, logFile);
    const content = readFileSync(logPath, 'utf8');
    const lines = content.trim().split('\n');
    const lastLines = lines.slice(-20);

    console.log(`\n--- ${logFile} (last ${lastLines.length} entries) ---\n`);
    console.log(lastLines.join('\n'));
  }
  console.log(`\n--- End of logs ---\n`);
}

async function handleRules() {
  const rulesPath = join(homedir(), '.mcp-gov', 'rules.json');
  rl.close();

  if (!existsSync(rulesPath)) {
    console.log(`\nRules file not found: ${rulesPath}`);
    console.log('Run "Wrap MCP servers" first to generate default rules.');
    return;
  }

  const editor = process.env.EDITOR || process.env.VISUAL || 'nano';

  console.log(`\nOpening ${rulesPath} in ${editor}...\n`);

  const child = spawn(editor, [rulesPath], {
    stdio: 'inherit'
  });

  child.on('close', (code) => {
    if (code === 0) {
      console.log('\nRules saved.');
    }
    process.exit(code);
  });
}

main().catch((err) => {
  rl.close();
  console.error('Error:', err.message);
  process.exit(1);
});
