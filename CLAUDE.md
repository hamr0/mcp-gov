# MCP-GOV

Security layer for Model Context Protocol servers - adds permission control and audit logging between AI assistants and MCP tool servers.

## Tech Stack

- Node.js (ES modules)
- @modelcontextprotocol/sdk ^0.5.0
- axios, dotenv

## Project Structure

```
bin/              CLI entry points (mcp-gov, mcp-gov-proxy, mcp-gov-wrap, mcp-gov-unwrap)
src/              Core logic (operation detection, keywords)
test/             Test suites
examples/         Example MCP servers
docs/             Architecture and design docs
scripts/          Build and publish scripts
```

## Essential Commands

```bash
# Run tests
npm test

# Run specific test
npm run test:proxy
npm run test:wrapper
npm run test:integration

# Install globally for development
npm link

# Publish to npm
./scripts/publish.sh
```

## Key Patterns

**Operation Detection:** Tools are classified as read/write/delete/execute/admin based on keyword matching (src/operation-keywords.js)

**Wrapping Flow:** mcp-gov-wrap modifies MCP config to insert mcp-gov-proxy between client and server, stores original config in _original field

**Rules Engine:** ~/.mcp-gov/rules.json contains per-service permission rules, checked on every tools/call JSON-RPC message

## Default File Locations

- Rules: ~/.mcp-gov/rules.json (auto-generated)
- Logs: ~/.mcp-gov/logs/*.log (per-service)
- Config backups: {config}.backup-{timestamp}

## Quick Development Flow

1. Make changes to src/ or bin/
2. Run npm test to verify
3. Test with npm link (makes CLI commands available globally)
4. Version in package.json, update CHANGELOG.md
5. Publish with ./scripts/publish.sh

## More Documentation

See docs/ for detailed architecture, flow diagrams, and testing guides.

For full development and testing standards, see `/home/hamr/Documents/PycharmProjects/gitdone/.claude/memory/AGENT_RULES.md`.
