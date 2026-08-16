# CodeSmith

CodeSmith is a local coding agent for projects that use TypeScript, Node.js,
Swift, JavaScript, Python, Rust, or Go. It supports selected models from
OpenAI, Anthropic, and Google Gemini. It keeps workspace access, approvals, and
command execution on your local machine.

## Why CodeSmith

CodeSmith separates the model connection from actions that can change a
project. A model can request file changes, Git inspection, and project
commands. The local client controls where these actions run and whether it
approves them.

CodeSmith provides Agent Core without a user interface. You can use it from a
CLI, desktop client, or web client. The `codesmith` command uses Agent Core.

## Capabilities

- Use projects in Swift, JavaScript, TypeScript, Python, Rust, and Go.
- Select reviewed models that can use tools.
- Keep your API key only in process memory for the current session. CodeSmith
  does not read or write the key to environment variables, files, or a
  keychain.
- Approve proposed edits, Git operations, and project commands by default.

## Running the CLI

### Requirements

- Install Node.js 22 or later.
- Get an API key for a supported model from OpenAI, Anthropic, or Google
  Gemini.

### Setup

Install the dependencies. Then start CodeSmith with the project path.

```sh
npm install

npm start -- --project /absolute/path/to/project
```

CodeSmith shows a numbered list of models when it starts. Select a model
number. Then enter its API key in the hidden prompt. The key exists only for
the current process.

Use `--yes` only to approve all proposed edits, Git inspections, and allowed
commands automatically.

```sh
npm start -- --project /absolute/path/to/project --yes
```

### Semantic episodic memory

Pass `--semantic-memory` to retain bounded, in-process records of tool outcomes
and final answers for the current session. Before its first use, CodeSmith asks
for a separate approval to download a reviewed local embedding model. `--yes`
does not approve this network download.

The model is stored outside projects in `~/Library/Caches/codesmith` on macOS,
`$XDG_CACHE_HOME/codesmith` (or `~/.cache/codesmith`) on Linux, and
`%LOCALAPPDATA%\CodeSmith\Cache` on Windows. The cache contains only the
reviewed model; session episodes are discarded when the session closes. Enter
`/clear-memory` to discard the current session's episodes sooner.

To end the session, enter `/exit` or `/quit`.

## Documentation

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the Agent Core API, system design,
local tool policy, safety limits, and development commands.
