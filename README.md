<div align="center">

```
███╗   ███╗  ██████╗ ██████╗     ██████╗  ██████╗ ██╗   ██╗
████╗ ████║ ██╔════╝ ██╔══██╗   ██╔════╝ ██╔═══██╗██║   ██║
██╔████╔██║ ██║      ██████╔╝   ██║  ███╗██║   ██║██║   ██║
██║╚██╔╝██║ ██║      ██╔═══╝    ██║   ██║██║   ██║╚██╗ ██╔╝
██║ ╚═╝ ██║ ╚██████╗ ██║        ╚██████╔╝╚██████╔╝ ╚████╔╝
╚═╝     ╚═╝  ╚═════╝ ╚═╝         ╚═════╝  ╚═════╝   ╚═══╝
```

# MCP Governance System

</div>

Permission control and audit logging for Model Context Protocol (MCP) servers.

## What is MCP-GOV?

MCP-GOV adds a security layer between your AI assistant (Claude, etc.) and MCP tool servers. It:

- **Controls permissions** - Block dangerous operations like delete, execute, admin
- **Logs everything** - Audit trail of all tool calls with timestamps
- **Works transparently** - No changes needed to your MCP servers

## Install

```bash
# Using npm
npm install -g mcp-gov

# Or run directly with npx
npx mcp-gov
```

## Usage

```bash
mcp-gov
```

```
███╗   ███╗  ██████╗ ██████╗     ██████╗  ██████╗ ██╗   ██╗
████╗ ████║ ██╔════╝ ██╔══██╗   ██╔════╝ ██╔═══██╗██║   ██║
██╔████╔██║ ██║      ██████╔╝   ██║  ███╗██║   ██║██║   ██║
██║╚██╔╝██║ ██║      ██╔═══╝    ██║   ██║██║   ██║╚██╗ ██╔╝
██║ ╚═╝ ██║ ╚██████╗ ██║        ╚██████╔╝╚██████╔╝ ╚████╔╝
╚═╝     ╚═╝  ╚═════╝ ╚═╝         ╚═════╝  ╚═════╝   ╚═══╝
                                                   v1.3.0

Select action:
  1) Wrap MCP servers
  2) Unwrap MCP servers
  3) View audit logs
  4) Edit rules
  5) Exit

Enter choice [1-5]:
```

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                     WITHOUT MCP-GOV                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   Claude ──────────────────────────────► MCP Server         │
│           (all operations allowed)       (filesystem,       │
│                                           github, etc.)     │
│                                                             │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                      WITH MCP-GOV                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   Claude ────► mcp-gov-proxy ────► MCP Server               │
│                     │                                       │
│                     ├── Check rules.json                    │
│                     │   ├── read: ✅ allow                  │
│                     │   ├── write: ✅ allow                 │
│                     │   ├── delete: ❌ deny                 │
│                     │   └── admin: ❌ deny                  │
│                     │                                       │
│                     └── Log to audit.log                    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Workflow

```
1. Install         npm install -g mcp-gov
                            │
                            ▼
2. Run             mcp-gov
                            │
                            ▼
3. Select          1) Wrap MCP servers
                            │
                            ▼
4. Enter path      ~/.claude.json
                            │
                            ▼
5. Done!           ✓ Servers wrapped
                   ✓ Rules generated at ~/.mcp-gov/rules.json
                   ✓ Audit logs at ~/.mcp-gov/logs/
```

## Default Rules

Rules are auto-generated at `~/.mcp-gov/rules.json`:

| Operation | Default | Examples |
|-----------|---------|----------|
| **read** | ✅ Allow | get, list, search, fetch |
| **write** | ✅ Allow | create, update, add, save |
| **delete** | ❌ Deny | delete, remove, drop, purge |
| **execute** | ❌ Deny | run, exec, invoke, trigger |
| **admin** | ❌ Deny | admin, configure, grant |

## Files

| Path | Description |
|------|-------------|
| `~/.mcp-gov/rules.json` | Governance rules |
| `~/.mcp-gov/logs/*.log` | Audit logs by service |

## Rules Format

```json
{
  "rules": [
    {
      "service": "github",
      "operations": ["delete"],
      "permission": "deny",
      "reason": "Block destructive operations"
    },
    {
      "service": "github",
      "operations": ["read", "write"],
      "permission": "allow"
    }
  ]
}
```

## Audit Log Format

```
[AUDIT] 2026-01-24T10:30:45.123Z | DENIED | tool=delete_repo | service=github | operation=delete | project=/home/user/myproject
```

## CLI Commands

The interactive menu is recommended, but you can also use commands directly:

```bash
# Wrap servers
mcp-gov-wrap --config ~/.claude.json

# Unwrap servers
mcp-gov-unwrap --config ~/.claude.json

# Low-level proxy (used internally)
mcp-gov-proxy --service github --target "npx server" --rules ~/.mcp-gov/rules.json
```

## License

Apache-2.0 — see [LICENSE](LICENSE).
