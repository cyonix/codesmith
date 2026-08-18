#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { realpathSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { AgentSession } from "../agent/session.js";
import type { AgentEvent } from "../agent/events.js";
import { formatDebugEvent } from "./debug.js";
import {
  createFileLogWriter,
  createLogger,
  resolveLogFilePath,
  resolveLogLevel,
  type LogLevel,
} from "./logger.js";
import { promptForApiKey, selectModel } from "./setup.js";
import { CodeSmithError } from "../shared/errors.js";
import { ModelProvider } from "../providers/provider.js";

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    stdout.write(`${help}\n`);
    return;
  }

  const logFile = resolveLogFilePath(options.logFile);
  const logger = createLogger({
    level: options.logLevel,
    ...(logFile ? { write: createFileLogWriter(logFile) } : {}),
  });
  if (logFile) stdout.write(`Writing logs to ${logFile}\n`);

  const selectionReadline = createInterface({ input: stdin, output: stdout });
  let readline: ReturnType<typeof createInterface> | undefined;
  let session: AgentSession | undefined;

  try {
    const model = await selectModel(
      (prompt) => selectionReadline.question(prompt),
      (output) => stdout.write(output),
    );

    selectionReadline.close();

    const apiKey = await promptForApiKey();
    const commandReadline = createInterface({ input: stdin, output: stdout });
    readline = commandReadline;

    const provider = new ModelProvider({ model, apiKey });
    const activeSession = await AgentSession.create({
      projectRoot: options.project,
      provider,
      autoApprove: options.yes,
      ...(options.semanticMemory ? { semanticMemory: true } : {}),
    });
    session = activeSession;

    activeSession.subscribe((event) => {
      const line = formatDebugEvent(event);
      if (line) logger.debug(line);
      void handleEvent(event, activeSession, commandReadline);
    });
    stdout.write(`CodeSmith is ready for ${options.project}. Type /exit to quit.\n`);

    while (true) {
      const prompt = await commandReadline.question("\ncodesmith> ");
      if (prompt === "/exit" || prompt === "/quit") break;
      if (prompt === "/clear-memory") {
        activeSession.clearEpisodicMemory();
        stdout.write("\nEpisodic memory cleared.\n");
        continue;
      }
      if (!prompt.trim()) continue;

      const answer = await activeSession.submit(prompt);
      if (answer) stdout.write(`\n${answer}\n`);
    }
  } finally {
    session?.close();
    readline?.close();
    selectionReadline.close();
  }
}

async function handleEvent(
  event: AgentEvent,
  session: AgentSession,
  readline: ReturnType<typeof createInterface>,
): Promise<void> {
  if (event.type !== "approval_requested") return;

  const label =
    event.kind === "model_download"
      ? "Model download"
      : `${event.kind[0]?.toUpperCase()}${event.kind.slice(1)}`;
  const answer = await readline.question(
    `\n${label} approval required:\n${event.summary}\nAllow? [y/N] `,
  );
  session.approve(event.requestId, answer.trim().toLowerCase() === "y");
}

export function parseOptions(
  argumentsValue: string[],
  environmentLevel = process.env.CODESMITH_LOG_LEVEL,
  environmentLogFile = process.env.CODESMITH_LOG_FILE,
): {
  project: string;
  yes: boolean;
  semanticMemory: boolean;
  help: boolean;
  logLevel: LogLevel;
  logFile: string | undefined;
} {
  let project: string | undefined;
  let yes = false;
  let semanticMemory = false;
  let logLevelFlag: string | undefined;
  let logFileFlag: string | undefined;

  for (let index = 0; index < argumentsValue.length; index += 1) {
    const argument = argumentsValue[index];
    if (argument === "--help" || argument === "-h")
      return {
        project: "",
        yes: false,
        semanticMemory: false,
        help: true,
        logLevel: resolveLogLevel(undefined, undefined),
        logFile: undefined,
      };
    if (argument === "--yes") {
      yes = true;
      continue;
    }
    if (argument === "--semantic-memory") {
      semanticMemory = true;
      continue;
    }
    if (argument === "--log-level") {
      logLevelFlag = argumentsValue[++index];
      if (!logLevelFlag)
        throw new CodeSmithError("configuration", "--log-level requires a level name.");
      continue;
    }
    if (argument === "--log-file") {
      logFileFlag = argumentsValue[++index];
      if (!logFileFlag)
        throw new CodeSmithError("configuration", "--log-file requires a file path.");
      continue;
    }
    if (argument === "--project") {
      project = argumentsValue[++index];
      if (!project)
        throw new CodeSmithError("configuration", "--project requires a directory path.");
      continue;
    }
    throw new CodeSmithError("configuration", `Unknown option: ${argument}`);
  }

  if (!project)
    throw new CodeSmithError("configuration", "--project is required to select a project root.");
  return {
    project,
    yes,
    semanticMemory,
    help: false,
    logLevel: resolveLogLevel(logLevelFlag, environmentLevel),
    logFile: logFileFlag ?? environmentLogFile,
  };
}

const help = `codesmith — a local coding agent for Swift, JavaScript, TypeScript, Python, Rust, and Go projects
Usage: codesmith --project <directory> [--yes] [--semantic-memory] [--log-level <level>] [--log-file <path>]
Prompts for a model selection and API key at startup.
All file paths are constrained to --project. Every edit, Git inspection, and detected project command requires confirmation unless --yes is supplied.
Commands are detected from project manifests and are always executed without a shell.
--semantic-memory enables local episodic retrieval and asks for one explicit model-download approval.
--log-level sets the logger level: debug, info, warn, or error. The default is debug. CODESMITH_LOG_LEVEL is used when the flag is omitted.
--log-file writes logger output to a file. The default is a new file in the user log directory. Use - to write to stderr. CODESMITH_LOG_FILE is used when the flag is omitted.`;
if (isEntrypoint(process.argv[1])) {
  void main().catch((error: unknown) => {
    createLogger({ level: "error" }).error(
      `codesmith: ${error instanceof Error ? error.message : "Unexpected failure."}`,
    );
    process.exitCode = 1;
  });
}

function isEntrypoint(entryPath: string | undefined): boolean {
  if (!entryPath) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entryPath)).href;
  } catch {
    return false;
  }
}
