# CodeSmith

CodeSmith is a local TypeScript/Node.js coding agent for Swift, JavaScript,
TypeScript, Python, Rust, and Go projects. It supports selected OpenAI,
Anthropic, and Google Gemini models while keeping workspace access, approvals,
and command execution on the local machine.

## Why CodeSmith

CodeSmith separates the agent's model connection from the side effects it can
perform. The model can propose file changes, Git inspection, and project
commands, but the local client retains control over where they run and whether
they are approved.

The package exposes a UI-neutral Agent Core for CLI, desktop, or web clients.
The bundled `codesmith` command is one client of that core.

## Capabilities

- Work with projects in Swift, JavaScript, TypeScript, Python, Rust, and Go.
- Select from reviewed, tool-capable models from OpenAI, Anthropic, and Google
  Gemini.
- Keep API keys in process memory for the current session rather than reading
  or writing them to environment variables, files, or a keychain.
- Require approval for proposed edits, Git operations, and project commands by
  default.

## Running the CLI

### Requirements

- Node.js 22 or newer
- An API key for a supported OpenAI, Anthropic, or Google Gemini model

### Setup

```sh
npm install

npm start -- --project /absolute/path/to/project
```

At startup, CodeSmith displays a grouped, numbered catalog of current
tool-capable models from OpenAI, Anthropic, and Google Gemini. Choose a model
number, then enter that provider's API key in a masked prompt. The key exists
only for the current process and is never read from or written to environment
variables, files, or a keychain.

Use `--yes` only when you want to automatically approve every proposed edit,
Git inspection, and allowlisted command:

```sh
npm start -- --project /absolute/path/to/project --yes
```

Type `/exit` or `/quit` to end an interactive CLI session.

## Documentation

See [ARCHITECTURE.md](ARCHITECTURE.md) for the Agent Core API, internal design,
local tool policy, safety boundaries, and development commands.
