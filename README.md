# claude-telegram-relay

Self-hosted Telegram relay that connects Telegram chats to a local **Claude Code CLI** and returns responses — no cloud API keys needed, just the CLI on your PATH.

> **Inspired by** [godagoo/claude-telegram-relay](https://github.com/godagoo/claude-telegram-relay). This repository is an original, from-scratch implementation.

## Features

- **Telegram ↔ Claude Code CLI** — messages flow through your local `claude` binary
- **Conversation memory** — per-chat history stored in SQLite (configurable turn limit)
- **User allowlist** — only approved Telegram user IDs can interact
- **Rate limiting** — per-user token bucket (burst of 3, configurable cooldown)
- **Sandboxed tools** — built-in skill system with `help`, `notes.*`, `files.*`
- **Tool allowlist** — only permitted tools can be invoked; no arbitrary shell
- **Secret redaction** — bot token and sensitive values are stripped from logs
- **Windows-first** — tested on PowerShell; works on Linux/macOS too

## Prerequisites

- **Bun** ≥ 1.1 (preferred) or **Node.js** ≥ 20
- **Claude Code CLI** installed and on your PATH (`claude --version` should work)
- A **Telegram Bot Token** from [@BotFather](https://t.me/BotFather)

## Quickstart

### 1. Clone & install

```bash
git clone https://github.com/YOUR_USER/claude-telegram-relay.git
cd claude-telegram-relay

# Bun (preferred)
bun install

# Node.js alternative
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token from BotFather |
| `TELEGRAM_ALLOWED_USERS` | Comma-separated Telegram user IDs (get yours from [@userinfobot](https://t.me/userinfobot)) |
| `SANDBOX_DIR` | Directory for sandboxed file tools (default `./sandbox`) |
| `CLAUDE_BIN` | Path to Claude CLI binary (default `claude`) |
| `CLAUDE_ALLOWED_TOOLS` | Allowed tool patterns (default `help,notes.*,files.*`) |
| `MEMORY_TURNS` | Max conversation turns to keep per chat (default `12`) |
| `RATE_LIMIT_MS` | Minimum ms between messages per user (default `2000`) |

### 3. Run

```bash
# Bun
bun run dev      # watch mode
bun run start    # production

# Node.js
npm run dev:node
npm run start:node
```

### 4. Test

```bash
# Bun
bun test

# Node.js
npm run test:node
```

## How It Works

```
Telegram message
  → grammY bot (long polling)
    → allowlist + rate limit check
      → orchestrator builds prompt (system policy + tool catalog + history + message)
        → claude -p - --output-format json (prompt via stdin)
          → parse JSON response
            → if tool_call: validate → execute skill → optional 2nd pass
            → if message: send back to Telegram
```

## Bot Commands

| Command | Description |
|---|---|
| `/start` | Welcome message |
| `/clear` | Reset conversation history |
| `/help` | List available tools |
| `/admin <passphrase>` | Enable admin mode (if configured) |

## Built-in Skills

| Tool | Description |
|---|---|
| `help` | Lists all available tools |
| `notes.add` | Save a note |
| `notes.list` | List all saved notes |
| `notes.search` | Search notes by keyword |
| `files.list` | List files in the sandbox |
| `files.read` | Read a file from the sandbox (max 10 KB) |

## Security

- **No arbitrary shell execution** — tools are validated against an allowlist
- **User allowlist** — unapproved Telegram user IDs are rejected
- **Sandboxed files** — `files.*` tools are restricted to `SANDBOX_DIR` with path-escape prevention
- **Rate limiting** — prevents abuse via token-bucket rate limiter
- **No plaintext secrets** — all configuration via `.env`
- **Log redaction** — bot token is automatically stripped from log output

## Troubleshooting

### "claude not found"

The Claude Code CLI must be on your PATH.

```bash
# Verify it works
claude --version

# If installed but not on PATH, set the full path in .env:
CLAUDE_BIN=C:\Users\YourName\.claude\claude.exe   # Windows
CLAUDE_BIN=/usr/local/bin/claude                    # Linux/macOS
```

### PATH issues on Windows

PowerShell may not inherit PATH changes from a new installation. Try:

1. Close and reopen your terminal
2. Run `refreshenv` (if using Chocolatey)
3. Set the full path in `CLAUDE_BIN` as shown above

### Telegram polling conflicts

If you see "409 Conflict" errors, another instance of the bot is running with the same token. Stop the other instance before starting a new one.

### SQLite errors on Node.js

`better-sqlite3` requires native compilation. If `npm install` fails:

```bash
# Windows: install build tools
npm install -g windows-build-tools

# Linux: install build essentials
sudo apt-get install build-essential python3

# macOS: install Xcode command line tools
xcode-select --install
```

With Bun, the native SQLite bindings are built-in and this is not an issue.

## Project Structure

```
.
├── README.md
├── package.json
├── bunfig.toml
├── tsconfig.json
├── .env.example
├── src/
│   ├── index.ts              # Entry point
│   ├── config/env.ts         # Environment config loader
│   ├── bot/telegram.ts       # grammY bot setup
│   ├── orchestrator/router.ts # Tool router & message handler
│   ├── llm/claudeCli.ts      # Claude CLI spawn & prompt builder
│   ├── llm/protocol.ts       # JSON protocol parser
│   ├── security/policy.ts    # User & tool allowlists
│   ├── security/rateLimit.ts # Token-bucket rate limiter
│   ├── storage/store.ts      # SQLite conversation store
│   ├── skills/loader.ts      # Skill registry & catalog
│   ├── skills/builtin/help.ts
│   ├── skills/builtin/notes.ts
│   ├── skills/builtin/files.ts
│   └── utils/log.ts          # Levelled logger with redaction
├── tests/
│   ├── setup.ts
│   └── protocol.test.ts
└── sandbox/                   # Created at runtime
```

## License

MIT
