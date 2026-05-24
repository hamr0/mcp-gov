# Product Requirements Document: mcp-governance

## 1. Introduction

### 1.1 Overview
**mcp-governance** is an open-source JavaScript middleware library that adds permission controls and audit logging to Model Context Protocol (MCP) servers. It enables developers to enforce governance policies on AI agent operations with minimal code changes.

### 1.2 Problem Statement
MCP servers currently provide AI agents with unrestricted access to integrated tools and services. Developers have no built-in mechanism to:
- Prevent dangerous operations (deletes, writes)
- Audit what AI agents actually do
- Enforce organizational policies before production deployment
- Make services read-only for testing

### 1.3 High-Level Goal
Create a lightweight, developer-friendly library that adds enterprise-grade governance to MCP servers in approximately 5 lines of code, enabling safe AI agent deployment.

### 1.4 Project Context
- **Type:** Open-source JavaScript library (POC/MVP)
- **Target Timeline:** 4-hour initial implementation
- **Market Context:** MCP is new (launched Nov 2024), no existing governance solutions
- **Philosophy:** Extreme simplicity - no build tools, no TypeScript, no database for POC

---

## 2. Goals

### 2.1 Primary Goals
1. **Enable Permission Control:** Developers can block specific operation types (read/write/execute/delete/admin) per service
2. **Provide Audit Trail:** Log all tool invocations with timestamp, args, and result for compliance
3. **Maintain Simplicity:** Add governance in ~5 lines of code with zero build configuration
4. **Demonstrate Value:** Working example that connects to Claude Desktop and blocks operations

### 2.2 Success Metrics

**POC Success (4-hour build):**
- Library runs without errors
- Example GitHub server connects to Claude Desktop
- Read operations execute successfully
- Delete operations blocked with clear error messages
- Audit logs capture all operations
- Published to GitHub with complete documentation

**Open Source Success (2 weeks):**
- 50+ GitHub stars
- 5+ developers try the example
- 2+ developers open issues or ask questions
- Shared on r/ClaudeAI, Hacker News, Twitter

**Community Adoption (3 months):**
- 200+ GitHub stars
- 10+ production users
- 3+ code contributors
- Featured in official MCP community resources

---

## 3. User Stories

### US1: Developer Wants Read-Only Access
**As a** developer building an MCP server for Gmail
**I want to** make it read-only (prevent AI from sending emails)
**So that** I can safely test AI agents without risk of accidental sends

**Acceptance Criteria:**
- Import mcp-governance library
- Configure rule: `{gmail: {read: 'allow', write: 'deny'}}`
- AI can read emails successfully
- AI receives clear error when attempting to send
- All attempts logged to audit trail

### US2: Developer Needs Audit Trail
**As a** team lead deploying AI agents in production
**I want to** log all operations the AI performs
**So that** I can audit what happened if something goes wrong

**Acceptance Criteria:**
- All tool calls logged with timestamp
- Logs include tool name, arguments (truncated), result status
- Output in JSON format for easy parsing
- Can review logs after incident to reconstruct events

### US3: Developer Protects Dangerous Operations
**As a** developer building a GitHub MCP server
**I want to** block delete operations
**So that** AI agents cannot delete repositories or issues

**Acceptance Criteria:**
- Configure rule: `{github: {delete: 'deny'}}`
- AI can create and update resources
- Attempted deletes return clear error message
- Audit logs show all denied operations

### US4: Developer Integrates Governance Quickly
**As a** developer with an existing MCP server
**I want to** add governance with minimal code changes
**So that** I don't have to refactor my entire codebase

**Acceptance Criteria:**
- Replace `new Server()` with `new GovernedMCPServer()`
- Add rules.json file
- No changes to tool handler implementations
- Server functions identically except for permission checks

---

## 4. Functional Requirements

### FR1: GovernedMCPServer Class
**The system must provide a GovernedMCPServer class** that:
1. Wraps the standard MCP SDK Server class
2. Accepts configuration object (name, version) and rules object in constructor
3. Provides `registerTool(toolDefinition, handler)` method for tool registration
4. Provides `start()` method to initialize stdio transport
5. Automatically checks permissions before executing any registered tool
6. Passes through all standard MCP Server functionality unchanged

**API Signature:**
```javascript
const server = new GovernedMCPServer(
  {name: 'my-server', version: '1.0.0'},
  {serviceName: {read: 'allow', write: 'deny', delete: 'deny'}}
);
```

### FR2: Permission Rules System
**The system must support JSON-based permission rules** that:
1. Use service name as top-level key
2. Support operation types: `read`, `write`, `execute`, `delete`, `admin`
3. Accept values: `'allow'` or `'deny'` for each operation type
4. Default to 'allow' if no rule exists for a service/operation
5. Load from JSON file or JavaScript object

**Operation Types:**
- **read**: View, list, get, search, query data (safest)
- **write**: Create, update, modify data (no delete)
- **execute**: Run operations, trigger actions, send (e.g., send email)
- **delete**: Remove, destroy data (dangerous)
- **admin**: Full control, manage settings, users (most dangerous)

**Schema:**
```json
{
  "gmail": {
    "read": "allow",
    "write": "allow",
    "execute": "deny",
    "delete": "deny",
    "admin": "deny"
  },
  "github": {
    "read": "allow",
    "write": "allow",
    "execute": "allow",
    "delete": "deny",
    "admin": "deny"
  }
}
```

### FR3: Operation Type Detection
**The system must automatically detect operation types** by:
1. Parsing tool names to extract operation verbs
2. Mapping verbs to operation types:
   - **read:** list, get, fetch, retrieve, search, query, find, show, view
   - **write:** create, add, update, modify, edit, set, post, put, patch
   - **execute:** send, run, trigger, start, invoke, publish, deploy, execute
   - **delete:** delete, remove, destroy, archive, drop
   - **admin:** admin, configure, manage, settings, permission, grant
3. Extracting service name from tool name prefix (e.g., `github_` → `github`)
4. Handling underscore and hyphen separators
5. Defaulting to 'write' if no verb matches (conservative approach)

**Examples:**
- `github_list_repos` → service: `github`, operation: `read`
- `gmail_send_email` → service: `gmail`, operation: `execute`
- `github_manage_settings` → service: `github`, operation: `admin`
- `github_create_issue` → service: `github`, operation: `write`
- `notion_delete_page` → service: `notion`, operation: `delete`

### FR4: Permission Enforcement
**The system must enforce permissions** by:
1. Checking permission before executing any tool handler
2. Blocking execution if policy is 'deny'
3. Returning MCP-compliant error to AI client with clear message
4. Logging permission check result (allowed/denied)
5. Executing handler and returning result if permission is 'allow'
6. Catching and logging handler errors

**Error Message Format:**
```
Operation denied: [operation_type] operations are not allowed for [service_name]
```

### FR5: Audit Logging
**The system must log all tool invocations** with:
1. ISO 8601 timestamp
2. Tool name
3. Arguments (JSON stringified, truncated to 200 chars)
4. Status: `allowed`, `denied`, `success`, `error`
5. Optional detail message
6. Output to console.error (stderr, separate from MCP stdout protocol)
7. JSON format for structured parsing

**Log Entry Format:**
```json
{
  "timestamp": "2025-01-21T12:34:56.789Z",
  "tool": "github_delete_repo",
  "args": "{\"repo_name\":\"12345\"}",
  "status": "denied",
  "detail": "Operation denied: delete operations are not allowed for github"
}
```

### FR6: Example GitHub Server
**The system must include a working example** that:
1. Implements MCP server using GovernedMCPServer
2. Integrates with GitHub API (requires API key)
3. Provides at least 2 tools:
   - `github_list_repos` (read operation)
   - `github_delete_repo` (delete operation)
4. Includes rules.json with delete operations denied
5. Demonstrates permission blocking when AI attempts delete
6. Can connect to Claude Desktop for end-to-end testing
7. Includes .env.example for API key configuration

### FR7: Documentation
**The system must provide comprehensive README** including:
1. Project description and value proposition
2. Installation instructions (`npm install`)
3. Quick start code example (5-10 lines)
4. Complete API reference for GovernedMCPServer
5. Permission rules schema and examples
6. How to run the GitHub example
7. How to connect to Claude Desktop
8. Architecture diagram (ASCII/text)
9. Contributing guidelines
10. License information (MIT recommended)

---

## 5. Non-Goals (Out of Scope)

### Not in POC:
- TypeScript implementation (JavaScript only for POC)
- Web UI for managing permissions
- Database storage for rules or logs (JSON files sufficient)
- OAuth integration for multi-user scenarios
- Approval workflows (require human approval before execution)
- Time-based permissions (allow operations only during business hours)
- Rate limiting or budget controls
- Rollback/undo features for operations
- Cloud hosting or SaaS deployment
- Complex policy language (DSL, conditional logic)
- Integration with external policy engines
- Multi-tenancy support
- Team/user management features

### Potential Future Features (Post-POC):
- TypeScript version with type definitions
- Approval workflow support (Slack notifications, human-in-the-loop)
- File-based persistent audit log storage
- Web UI for rule management and audit log viewing
- Custom operation classifiers (developer-provided)
- Policy templates for common use cases
- Glob pattern support in tool names (`github_*_task`)
- Fine-grained argument-level permissions
- Integration with secrets managers

### Future Enhancements (post-2.0.0)

Concrete backlog captured at the 2.0.0 security-hardening release. None are
blocking; recorded here in case the project is picked back up. Scope is
deliberately local-MCP governance (distinct from the autonomous-agent products
that grew out of this).

1. **Upgrade `@modelcontextprotocol/sdk` 0.5 → 1.x (clears the last advisory).**
   - *What:* the pinned `^0.5.0` SDK carries a high-severity ReDoS advisory
     (GHSA-8r9q-7v3j-jr4g) that still reaches library consumers.
   - *Why it was deferred:* the 0.5→1.x API changed substantially, so this is a
     real migration of `src/index.js` (`GovernedMCPServer`) plus re-testing, not
     a version bump. The proxy/CLI path does **not** import the SDK, so the blast
     radius is library (`GovernedMCPServer`) consumers only.
   - *Effort:* medium; deserves its own branch.

2. **Move enforcement beyond name heuristics (the real protection ceiling).**
   - *What:* today operation type is inferred from the tool **name** (keyword
     match) and arguments are never inspected, so a destructive tool named
     without a destructive keyword is classified `write` and allowed. Only
     `tools/call` is mediated — `resources/*`, `prompts/*` pass through
     ungoverned.
   - *Why it matters:* this is the boundary of what the tool actually enforces;
     a fully adversarial MCP server can evade it. Closing it means explicit
     per-tool (exact-name) rules + argument-level constraints (extends the
     "Fine-grained argument-level permissions" / "Custom operation classifiers"
     ideas above) and extending mediation to the other side-effecting methods.
   - *Effort:* large; this is a feature/redesign, not a patch. Documented as a
     known limitation in the README "Security Model & Limitations" section.

3. **De-flake the proxy test suite.**
   - *What:* the proxy tests use fixed `setTimeout` waits and flake under load;
     `npm test` is `&&`-chained, so one flaky proxy failure aborts the whole run
     (including in CI, which gates the publish workflow on `npm test`).
   - *Fix:* convert the fixed-timeout proxy tests to condition-based waiting
     (wait for expected output, not a fixed delay) — the pattern already used by
     the `--target-args` / `defaultPolicy` / log-injection tests added in 2.0.0.
   - *Effort:* small, low-risk, contained to `test/proxy.test.js`.

---

## 6. Technical Architecture

### 6.1 Technology Stack
- **Language:** Pure JavaScript (ESM modules)
- **Runtime:** Node.js 20+
- **Module System:** ES Modules (import/export)
- **Dependencies:**
  - `@modelcontextprotocol/sdk` (Anthropic's official SDK)
  - `axios` (for HTTP requests in examples)
- **Build Tools:** None (direct execution with node)
- **Configuration:** JSON files, environment variables

### 6.2 Architecture Pattern
```
┌─────────────────────────────────┐
│ Developer's MCP Server Code     │
│ (registers tools, handlers)     │
└────────────┬────────────────────┘
             │ uses
             ↓
┌─────────────────────────────────┐
│ mcp-governance Library          │
│ - GovernedMCPServer             │
│ - Permission Checker            │
│ - Operation Detector            │
│ - Audit Logger                  │
└────────────┬────────────────────┘
             │ wraps
             ↓
┌─────────────────────────────────┐
│ @modelcontextprotocol/sdk       │
│ (Anthropic's MCP SDK)           │
└────────────┬────────────────────┘
             │ connects via stdio
             ↓
┌─────────────────────────────────┐
│ Claude Desktop / MCP Clients    │
└─────────────────────────────────┘
```

**Key Design Principle:** The library is middleware that wraps the MCP SDK Server class, intercepting tool calls to inject permission checks and audit logging before delegating to the original handler.

### 6.3 Repository Structure

**Complete file structure:**
```
mcp-governance/
├── package.json                    # Project metadata, dependencies, scripts
├── README.md                       # Project overview, quick start
├── LICENSE                         # MIT License
│
├── src/                            # Library source code
│   ├── index.js                    # Main export: GovernedMCPServer class (~150 lines)
│   ├── operation-detector.js       # Operation detection logic (~100 lines)
│   └── operation-keywords.js       # Keyword mapping constants (~50 lines)
│
├── examples/                       # Example implementations
│   ├── github/
│   │   ├── server.js              # GitHub MCP server with governance (~50 lines)
│   │   ├── rules.json             # Permission rules for GitHub
│   │   ├── .env.example           # API key template
│   │   └── README.md              # How to run this example
│   └── github/                    # (Future: GitHub example)
│
├── docs/                          # Documentation
│   ├── operation-keywords.md      # Comprehensive keyword reference
│   ├── permission-levels.md       # Permission levels guide
│   └── api-reference.md           # (Future: API documentation)
│
├── tasks/                         # Project management
│   └── 0001-prd-mcp-governance.md # This document (PRD)
│
├── tests/                         # (Future: Automated tests)
│   └── operation-detector.test.js
│
├── .gitignore                     # Git ignore rules
└── .npmignore                     # (Future: NPM publish ignore rules)
```

**File Responsibilities:**

**src/index.js:**
- Export `GovernedMCPServer` class
- Tool registration and MCP server orchestration
- Permission enforcement integration
- Audit logging coordination

**src/operation-detector.js:**
- Export `detectOperation(toolName)` function
- Export `parseToolName(toolName)` function
- Service name extraction logic
- Encapsulates all text parsing logic

**src/operation-keywords.js:**
- Export `OPERATION_KEYWORDS` constant (exhaustive list)
- ~160 keywords across 5 operation types
- Single source of truth for keyword mapping

**examples/github/server.js:**
- Concrete implementation using the library
- Demonstrates real-world usage
- Can be copied and modified by users
- Connects to GitHub API

**examples/github/rules.json:**
- Example permission configuration
- Shows all 5 permission levels
- Documented with inline comments

**docs/operation-keywords.md:**
- Complete reference of all keywords
- Detection algorithm explanation
- Edge cases and ambiguous keywords
- Testing examples

**docs/permission-levels.md:**
- User-facing guide to permission levels
- Real-world scenarios (Gmail, Database, CI/CD)
- Best practices and security considerations

### 6.4 Core Components

**Component 1: GovernedMCPServer**
- Extends or wraps MCP SDK Server
- Constructor: accepts config and rules
- Methods: registerTool(), start()
- Responsibility: Orchestrate permission checking and tool execution

**Component 2: PermissionChecker**
- Input: tool name, rules object
- Output: {allowed: boolean, service: string, operation: string}
- Logic: Parse tool name, lookup rule, return decision

**Component 3: OperationDetector**
- Input: tool name
- Output: {service: string, operation: 'read'|'write'|'execute'|'delete'|'admin'}
- Logic: Extract service prefix, detect operation verb, map to type
- Default: 'write' if no verb matches (conservative)

**Component 4: AuditLogger**
- Input: log entry object
- Output: JSON to console.error
- Logic: Format timestamp, truncate args, stringify to JSON

### 6.5 Operation Detection Keywords (Exhaustive List)

**Purpose:** The library uses text parsing to detect operation types from tool names. This requires a comprehensive, well-maintained keyword list that covers common API verbs across different domains.

**Total Keywords:** ~160 across 5 operation types

#### READ Keywords (~35 keywords)
**Intent:** View, query, retrieve data without modification

```
Primary: read, get, fetch, retrieve, list, show, view, display
Query: query, search, find, lookup, select, scan, index, count
Inspect: check, validate, verify, inspect, examine, test, peek, preview
Download: download, dump, export, extract, pull, clone
Status: status, info, describe, details, summary, stat
```

**Examples:**
- `github_list_repos` → read
- `github_get_user` → read
- `api_search_records` → read

#### WRITE Keywords (~30 keywords)
**Intent:** Create new data or modify existing (no delete)

```
Create: create, add, new, insert, post, put, make, build, generate, initialize, setup, register
Update: update, modify, edit, change, set, patch, alter, amend, revise, replace
Append: append, push, attach, extend, increment
Configure: configure, adjust, tune, customize
```

**Examples:**
- `github_create_issue` → write
- `github_update_issue` → write
- `api_patch_resource` → write

#### EXECUTE Keywords (~35 keywords)
**Intent:** Perform operations with external effects

```
Send: send, notify, broadcast, transmit
Execute: execute, run, invoke, call, trigger, fire, launch, start, begin
Process: process, compile, build, deploy, render, convert, transform
Workflow: schedule, queue, enqueue, dispatch, submit, publish
```

**Examples:**
- `gmail_send_email` → execute
- `jenkins_trigger_build` → execute
- `lambda_invoke_function` → execute

**Note:** Ambiguous words like "email" and "message" as standalone nouns are NOT included to avoid false positives. Only action verbs are included.

#### DELETE Keywords (~25 keywords)
**Intent:** Remove, destroy, or permanently modify data

```
Delete: delete, remove, destroy, drop, purge, clear, erase
Archive: archive, trash, discard, abandon
Cancel: cancel, abort, terminate, kill, stop, halt
Reset: reset, wipe, flush, clean, prune
```

**Examples:**
- `github_delete_repo` → delete
- `db_drop_table` → delete
- `cache_clear_all` → delete

#### ADMIN Keywords (~35 keywords)
**Intent:** Manage system, users, permissions, infrastructure

```
Admin: admin, administer, administrate
Manage: manage, grant, revoke, assign, unassign
Users: invite, approve, reject, block, unblock, ban, unban, promote, demote
Permissions: permission, authorize, authenticate, allow, deny, enable, disable
System: restart, reboot, upgrade, downgrade, scale, provision, install, uninstall, migrate
```

**Examples:**
- `github_manage_settings` → admin
- `salesforce_grant_permission` → admin
- `aws_provision_server` → admin

#### Detection Algorithm

```
1. Normalize tool name to lowercase
2. Split by underscore (_) or hyphen (-)
3. Check each word against keyword lists in priority order:
   a. admin (most restrictive)
   b. delete
   c. execute
   d. write
   e. read (least restrictive)
4. Return first match
5. Default to "write" if no match (conservative)
```

**Priority Example:**
```
Tool: "admin_create_user"
Words: ["admin", "create", "user"]
Check: admin keywords → MATCH "admin" → return "admin"
(Skips checking "create" since admin already matched)
```

#### Edge Cases & Ambiguous Keywords

**Words with multiple meanings:**

| Word | As Verb | As Noun | Resolution |
|------|---------|---------|------------|
| publish | execute | - | Include (verb form common) |
| archive | delete | write | Include in delete (destructive assumption) |
| test | read/execute | - | Include in read (safer default) |
| reset | delete | write | Include in delete (destructive assumption) |

**Compound actions:**
- `"fork_and_clone"` → Contains "clone" (read), but creates new resource → Manual override needed
- `"sync_data"` → Ambiguous → Defaults to write

**Handling ambiguity:** When in doubt, choose the MORE restrictive classification to err on the side of caution.

#### Maintenance & Extensibility

**Future additions** (based on user feedback):
- Domain-specific verbs (e.g., "subscribe", "unsubscribe" for messaging)
- Regional variants (e.g., British vs American spelling)
- Acronyms (e.g., "CRUD" operations)

**Extension mechanism** (Post-POC):
```javascript
// Allow custom keyword additions
server.addOperationKeywords('execute', ['blast', 'yeet']);

// Manual operation override
server.registerTool(
  { name: 'weird_action', operation: 'delete' },
  handler
);
```

**Keyword List Location:**
- Documented: `docs/operation-keywords.md` (comprehensive reference)
- Implemented: `src/operation-keywords.js` (code constants)
- Tested: `tests/operation-detector.test.js` (~60 test cases)

**Accuracy Target:** 90-95% for well-named tools, 100% with manual overrides

---

## 7. Design Considerations

### 7.1 API Design Philosophy
- **Minimal API Surface:** Only 3 public methods (constructor, registerTool, start)
- **Drop-in Replacement:** GovernedMCPServer should be nearly identical to Server in usage
- **Configuration Over Code:** Rules in JSON files, not hardcoded in JavaScript
- **Fail Secure:** Default to deny if rules are ambiguous or missing (OPEN QUESTION)

### 7.2 Error Handling
- Permission denials return MCP-compliant error responses
- Handler errors caught and logged, then returned to client
- Invalid rules.json causes startup failure with clear error message
- Missing service/operation in rules follows `defaultPolicy` (`allow` by default for backward compatibility; set `deny` for fail-closed) — see Q1

### 7.3 Performance Considerations
- Permission check is synchronous (JSON lookup + string parsing)
- No network calls in governance layer
- Audit logging is fire-and-forget (console.error)
- Minimal overhead: <1ms per tool call

### 7.4 Security Considerations
- Rules stored in plain JSON (no encryption in POC)
- API keys in .env files (standard practice for examples)
- No authentication/authorization between library and MCP client
- Audit logs may contain sensitive data (arguments logged)

---

## 8. Implementation Specifications

### 8.1 GovernedMCPServer API

**Constructor:**
```javascript
constructor(config, rules)
```
- **config:** `{name: string, version: string}` - MCP server metadata
- **rules:** `{[service: string]: {read?: 'allow'|'deny', write?: 'allow'|'deny', execute?: 'allow'|'deny', delete?: 'allow'|'deny', admin?: 'allow'|'deny'}}` - Permission rules

**registerTool Method:**
```javascript
registerTool(toolDefinition, handler)
```
- **toolDefinition:** `{name: string, description: string, inputSchema: object}` - MCP tool definition
- **handler:** `async (args) => {content: [{type: 'text', text: string}]}` - Tool implementation
- **Returns:** void
- **Side Effect:** Registers wrapped handler that checks permissions before execution

**start Method:**
```javascript
async start()
```
- **Returns:** `Promise<void>`
- **Side Effect:** Connects MCP server via stdio transport, begins listening for requests

### 8.2 Permission Rules Schema
```typescript
// Conceptual schema (not TypeScript in implementation)
type PermissionRules = {
  [serviceName: string]: {
    read?: 'allow' | 'deny',
    write?: 'allow' | 'deny',
    delete?: 'allow' | 'deny'
  }
}
```

**Example rules.json:**
```json
{
  "github": {
    "read": "allow",
    "write": "allow",
    "delete": "deny"
  },
  "github": {
    "read": "allow",
    "write": "allow",
    "delete": "deny"
  },
  "gmail": {
    "read": "allow",
    "write": "deny",
    "delete": "deny"
  }
}
```

### 8.3 Audit Log Entry Schema
```typescript
// Conceptual schema
type AuditLogEntry = {
  timestamp: string,      // ISO 8601 format
  tool: string,           // Tool name
  args: string,           // JSON stringified args (truncated to 200 chars)
  status: 'allowed' | 'denied' | 'success' | 'error',
  detail?: string         // Optional detail message
}
```

**Example log entries:**
```json
{"timestamp":"2025-01-21T12:34:56.789Z","tool":"github_list_repos","args":"{}","status":"allowed"}
{"timestamp":"2025-01-21T12:35:01.234Z","tool":"github_list_repos","args":"{}","status":"success","detail":"Returned 5 repos"}
{"timestamp":"2025-01-21T12:35:10.567Z","tool":"github_delete_repo","args":"{\"repo_name\":\"12345\"}","status":"denied","detail":"Operation denied: delete operations are not allowed for github"}
```

### 8.4 Operation Detection Logic

**Verb Mappings:**
```javascript
const OPERATION_VERBS = {
  read: ['list', 'get', 'fetch', 'retrieve', 'search', 'query', 'find', 'show', 'view', 'read'],
  write: ['create', 'add', 'update', 'modify', 'edit', 'set', 'post', 'put', 'patch', 'write'],
  delete: ['delete', 'remove', 'destroy', 'archive']
};
```

**Parsing Algorithm:**
1. Extract service name: everything before first underscore/hyphen
2. Extract operation verb: first word after service prefix matching verb list
3. Map verb to operation type using OPERATION_VERBS
4. Default to 'read' if no verb matches

**Examples:**
- `github_list_repos` → service=`github`, verb=`list`, operation=`read`
- `github-create-issue` → service=`github`, verb=`create`, operation=`write`
- `notion_delete_page` → service=`notion`, verb=`delete`, operation=`delete`
- `slack_custom_action` → service=`slack`, verb=`custom`, operation=`read` (default)

---

## 9. Testing Strategy

### 9.1 Manual Testing (POC Scope)
1. **Unit Testing:** Run example server in isolation, verify logs
2. **Integration Testing:** Connect to Claude Desktop, issue commands to AI
3. **Permission Testing:** Verify read operations succeed, delete operations blocked
4. **Audit Testing:** Verify all operations logged correctly
5. **Error Testing:** Verify clear error messages on denial

### 9.2 Test Scenarios

**Scenario 1: Read Operation Allowed**
- Setup: Rule `{github: {read: 'allow'}}`
- Action: Ask Claude "List my GitHub tasks"
- Expected: Tasks returned, log shows "allowed" and "success"

**Scenario 2: Delete Operation Denied**
- Setup: Rule `{github: {delete: 'deny'}}`
- Action: Ask Claude "Delete task 12345 from GitHub"
- Expected: Error message returned, log shows "denied"

**Scenario 3: Missing Rule Defaults**
- Setup: Rule `{}` (empty)
- Action: Ask Claude "List tasks"
- Expected: Operation allowed (default behavior - OPEN QUESTION)

**Scenario 4: Handler Error**
- Setup: Invalid API key
- Action: Ask Claude "List tasks"
- Expected: Error returned to Claude, log shows "error"

### 9.3 Future Testing (Post-POC)
- Automated unit tests with Jest
- Integration tests with mock MCP clients
- Performance benchmarks
- Load testing for concurrent requests

---

## 10. Dependencies & Prerequisites

### 10.1 Development Environment
- Node.js 20+ installed
- Claude Desktop installed (for end-to-end testing)
- Text editor (VS Code recommended)
- Git for version control
- npm or yarn package manager

### 10.2 External Services (for examples)
- GitHub account with API key
- (Future examples: GitHub, Notion, Gmail APIs)

### 10.3 NPM Dependencies
```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^0.5.0"
  },
  "devDependencies": {
    "axios": "^1.12.0",
    "dotenv": "^16.0.0"
  }
}
```

> `axios` and `dotenv` are used only by the bundled example
> (`examples/github/server.js`), not by the CLI or the library, so they are
> `devDependencies` — this keeps their advisories out of the consumer install tree.

### 10.4 Runtime Requirements
- ES Modules support (Node.js 14+)
- Stdio transport support (built into MCP SDK)
- Environment variable support (dotenv for examples; dev-only)

---

## 11. Risks & Mitigations

### Risk 1: MCP SDK Breaking Changes
- **Impact:** High (entire library depends on SDK)
- **Likelihood:** Medium (SDK is new, API may evolve)
- **Mitigation:** Pin to specific SDK version, monitor release notes, version library alongside SDK

### Risk 2: Operation Detection Inaccuracy
- **Impact:** Medium (incorrect categorization could allow/deny wrong operations)
- **Likelihood:** Medium (heuristics-based, edge cases exist)
- **Mitigation:** Use conservative verb list, log all decisions, allow custom classifiers in future

### Risk 3: Low Community Adoption
- **Impact:** Low (personal learning project)
- **Likelihood:** Medium (MCP ecosystem is early, small audience)
- **Mitigation:** Excellent documentation, share widely, engage with MCP community

### Risk 4: Scope Creep / Complexity Creep
- **Impact:** High (past projects abandoned due to over-engineering)
- **Likelihood:** High (natural tendency to add features)
- **Mitigation:** Strict adherence to POC scope, finish MVP before adding features, time-box to 4 hours

### Risk 5: Performance Bottleneck
- **Impact:** Low (permission check is simple)
- **Likelihood:** Low (no network calls, just JSON lookup)
- **Mitigation:** Profile if issues arise, optimize operation detection if needed

### Risk 6: Security Vulnerabilities
- **Impact:** Medium (OSS library used in production)
- **Likelihood:** Low (minimal attack surface)
- **Mitigation:** Follow security best practices, document security considerations, add security policy file

---

## 12. Open Questions

### Q1: Default Permission Policy — RESOLVED
**Question:** Should default policy be "allow" or "deny" when no rule exists for a service/operation?

**Options:**
- A) **Allow by default** (fail open) - Less friction, matches current MCP behavior
- B) **Deny by default** (fail closed) - More secure, requires explicit permissions

**Resolution:** Made configurable via a top-level `"defaultPolicy"` field in
rules.json (`"allow"` | `"deny"`). The engine defaults to `allow` when the field
is absent (backward compatible). `mcp-gov-wrap` now writes `"defaultPolicy": "deny"`
into newly-generated rules and emits a complete rule set (allow read/write, deny
delete/execute/admin) per service, so new installs are fail-closed without
breaking normal traffic. Existing rules files are left untouched.

### Q2: Audit Log Persistence
**Question:** Should audit logs write to file, or console.error only?

**Options:**
- A) **Console.error only** - Simpler, users can redirect stderr to file
- B) **Write to file** - More convenient, requires file path configuration
- C) **Both** - Most flexible, slightly more complex

**Recommendation:** A for POC, add B as optional feature if requested

### Q3: Tool Name Pattern Matching
**Question:** Should we support glob patterns in rules (e.g., `github_*_task`)?

**Options:**
- A) **Exact service name only** - Simpler, sufficient for POC
- B) **Support glob patterns** - More flexible, adds complexity

**Recommendation:** A for POC, B as future feature if users request

### Q4: Permission Error Messages
**Question:** Should error messages include suggestions for fixing the rule?

**Example:** "Operation denied: delete operations are not allowed for github. To allow, set {github: {delete: 'allow'}} in rules.json"

**Options:**
- A) **Simple error only** - Cleaner, less verbose
- B) **Include suggestion** - More helpful for developers

**Recommendation:** B (include suggestion) - improves developer experience

### Q5: Rules Schema Validation
**Question:** Should we validate rules.json schema on startup?

**Options:**
- A) **No validation** - Simpler, fail at runtime if invalid
- B) **Validate on startup** - Fail fast, better errors

**Recommendation:** B (validate on startup) - prevents runtime surprises

---

## 13. Success Definition

### POC Success Criteria
The POC is successful if:
1. Completed in one 4-hour weekend session
2. Works with Claude Desktop end-to-end
3. Permission blocking demonstrably works in live test
4. Code is clean and maintainable
5. You enjoy building it (not a frustrating slog)
6. You'd be proud to share with other developers

### Project Success Criteria
The project is successful if:
1. 3+ developers outside your network use it in real projects
2. Featured in official MCP community resources or Anthropic blog
3. You learn MCP protocol deeply through implementation
4. Opens doors to consulting opportunities or future projects
5. Generates meaningful discussions about AI governance

### Personal Success Criteria
This is a successful learning experience if:
1. You finish the POC without abandoning due to complexity
2. You gain confidence in building open-source libraries
3. You establish presence in the MCP community
4. You practice disciplined scope management
5. You create something genuinely useful, not just a portfolio piece

---

## 14. Timeline & Milestones

### Hour 1: Core Library Implementation
- Create project structure (package.json, src/, examples/)
- Implement GovernedMCPServer class
- Implement PermissionChecker logic
- Implement OperationDetector logic
- Implement AuditLogger
- Write basic unit tests (manual console verification)

### Hour 2: Example Implementation
- Create examples/github/ directory
- Implement GitHub API client wrapper
- Create github_list_repos tool
- Create github_delete_repo tool
- Create rules.json with delete denied
- Add .env.example and environment loading

### Hour 3: Testing & Integration
- Configure Claude Desktop to use example server
- Test read operations (list tasks)
- Test delete operations (verify blocking)
- Review audit logs for completeness
- Fix bugs and edge cases discovered during testing

### Hour 4: Documentation & Publishing
- Write comprehensive README.md
- Document API with code examples
- Add architecture diagram (ASCII art)
- Create LICENSE file (MIT)
- Create CONTRIBUTING.md
- Initial git commit and push to GitHub
- Write announcement post draft

### Week 1: Community Engagement
- Post to r/ClaudeAI subreddit
- Share on Twitter/X with relevant hashtags
- Post to Hacker News "Show HN"
- Engage with comments and questions
- Create GitHub issues for feature requests

### Week 2: Iteration & Second Example
- Address feedback from Week 1
- Fix bugs reported by early users
- Add second example (GitHub or Gmail)
- Improve documentation based on confusion points

### Week 3-4: Polish & Growth
- Add badges to README (stars, license, npm version if published)
- Consider publishing to npm if 5+ users request
- Write blog post about building it
- Consider adding TypeScript if strongly requested

---

## 15. Stakeholders & Communication

### Primary Stakeholder: You (Project Owner)
- **Role:** Developer, architect, maintainer
- **Goals:** Learn MCP, build portfolio, establish OSS presence
- **Success Criteria:** Finish POC, get community adoption

### Secondary Stakeholders: MCP Developers
- **Role:** Early adopters, users, potential contributors
- **Goals:** Add governance to their MCP servers easily
- **Communication:** GitHub issues, discussions, Twitter

### Tertiary Stakeholders: Anthropic / MCP Team
- **Role:** Protocol maintainers, potential promoters
- **Goals:** Build ecosystem of MCP tools
- **Communication:** Share via official channels, request feedback

### Communication Plan
- **Documentation:** Comprehensive README on GitHub
- **Support:** GitHub issues for questions and bugs
- **Updates:** GitHub releases for version milestones
- **Community:** Engage in MCP Discord/forums if they exist

---

## 16. Appendix

### A. Reference Links
- MCP Protocol Specification: https://modelcontextprotocol.io/
- MCP SDK Documentation: https://github.com/anthropic-ai/modelcontextprotocol
- GitHub API: https://developer.github.com/rest/v2/
- Claude Desktop: https://claude.ai/download

### B. Glossary
- **MCP:** Model Context Protocol - Anthropic's protocol for connecting AI to external tools
- **MCP Server:** Backend service that exposes tools to AI agents via MCP
- **Tool:** A function that AI can invoke (e.g., "list_tasks", "delete_task")
- **Governance:** Policies and controls for what operations are allowed
- **Audit Log:** Record of all operations attempted and their outcomes
- **Permission Rule:** Configuration that allows or denies specific operation types
- **Operation Type:** Category of operation (read, write, execute, delete, admin)
- **Stdio Transport:** Communication method using stdin/stdout streams

### C. Example Usage Code

**Basic Usage:**
```javascript
import { GovernedMCPServer } from 'mcp-governance';
import fs from 'fs';

const rules = JSON.parse(fs.readFileSync('rules.json', 'utf-8'));

const server = new GovernedMCPServer(
  { name: 'my-service', version: '1.0.0' },
  rules
);

server.registerTool(
  {
    name: 'github_list_repos',
    description: 'List all tasks',
    inputSchema: { type: 'object', properties: {} }
  },
  async (args) => {
    // Implementation
    return { content: [{ type: 'text', text: 'Task list...' }] };
  }
);

await server.start();
```

**Rules Configuration:**
```json
{
  "github": {
    "read": "allow",
    "write": "allow",
    "delete": "deny"
  }
}
```

**Expected Audit Log Output:**
```
{"timestamp":"2025-01-21T12:34:56.789Z","tool":"github_list_repos","args":"{}","status":"allowed"}
{"timestamp":"2025-01-21T12:34:57.123Z","tool":"github_list_repos","args":"{}","status":"success","detail":"Returned 5 repos"}
{"timestamp":"2025-01-21T12:35:10.456Z","tool":"github_delete_repo","args":"{\"repo_name\":\"12345\"}","status":"denied","detail":"Operation denied: delete operations are not allowed for github"}
```

---

## Document Metadata
- **Version:** 1.0
- **Created:** 2025-01-21
- **Author:** Product Manager (Claude Code Agent 1-create-prd)
- **Status:** Ready for Implementation
- **Next Step:** Invoke agent 2-generate-tasks to create detailed task breakdown
