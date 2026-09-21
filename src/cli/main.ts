#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { realpathSync } from "node:fs";
import { stderr, stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { AgentSession } from "../agent/session.js";
import type { AgentEvent } from "../agent/events.js";
import { formatDebugEvent } from "./debug.js";
import {
  assertFileLoggingSupported,
  assertLogFileOutsideProject,
  createFileLogWriter,
  createLogger,
  defaultLogDirectory,
  defaultLogFilePath,
  type FileLogWriter,
} from "./logger.js";
import { promptForApiKey, selectModel } from "./setup.js";
import { CodeSmithError } from "../shared/errors.js";
import { ModelProvider } from "../providers/provider.js";
import { formatPlanRevision, formatTaskContract } from "./render.js";
import { escapeTerminalText } from "../shared/terminal-text.js";

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    stdout.write(`${help}\n`);
    return;
  }

  assertFileLoggingSupported();
  const logDirectory = defaultLogDirectory();
  const logFile = defaultLogFilePath({ directory: logDirectory });
  assertLogFileOutsideProject(logFile, options.project);
  const fileLog: FileLogWriter = createFileLogWriter(logFile, undefined, {
    ownedDirectory: logDirectory,
    projectRoot: options.project,
  });
  let selectionReadline: ReturnType<typeof createInterface> | undefined;
  let readline: ReturnType<typeof createInterface> | undefined;
  let session: AgentSession | undefined;

  try {
    const logger = createLogger({ write: fileLog.write });

    const modelSelection = createInterface({ input: stdin, output: stdout });
    selectionReadline = modelSelection;
    const model = await selectModel(
      (prompt) => modelSelection.question(prompt),
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
      logger.debug(formatDebugEvent(event));
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
      if (answer) stdout.write(`\n${escapeTerminalText(answer)}\n`);
    }
  } finally {
    session?.close();
    fileLog.close();
    readline?.close();
    selectionReadline?.close();
  }
}

async function handleEvent(
  event: AgentEvent,
  session: AgentSession,
  readline: ReturnType<typeof createInterface>,
): Promise<void> {
  if (event.type === "task_declared") {
    stdout.write(`\n${formatTaskContract(event.contract)}\n`);
    return;
  }
  if (event.type === "plan_revised") {
    stdout.write(`\n${formatPlanRevision(event.plan, event.reason)}\n`);
    return;
  }
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

export function parseOptions(argumentsValue: string[]): {
  project: string;
  yes: boolean;
  semanticMemory: boolean;
  help: boolean;
} {
  let project: string | undefined;
  let yes = false;
  let semanticMemory = false;

  for (let index = 0; index < argumentsValue.length; index += 1) {
    const argument = argumentsValue[index];
    if (argument === "--help" || argument === "-h")
      return { project: "", yes: false, semanticMemory: false, help: true };
    if (argument === "--yes") {
      yes = true;
      continue;
    }
    if (argument === "--semantic-memory") {
      semanticMemory = true;
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
  return { project, yes, semanticMemory, help: false };
}

const help = `codesmith — a local coding agent for Swift, JavaScript, TypeScript, Python, Rust, and Go projects
Usage: codesmith --project <directory> [--yes] [--semantic-memory]
Prompts for a model selection and API key at startup.
All file paths are constrained to --project. Every edit, Git inspection, and detected project command requires confirmation unless --yes is supplied.
Commands are detected from project manifests and are always executed without a shell.
--semantic-memory enables local episodic retrieval and asks for one explicit model-download approval.
Each session writes a debug log outside --project. File logs are supported on macOS only. The default directory is ~/Library/Logs/codesmith. Previews are limited to 4 KiB. The current session log stops at 16 MiB. CodeSmith does not delete old log files.`;
if (isEntrypoint(process.argv[1])) {
  void main().catch((error: unknown) => {
    stderr.write(`codesmith: ${error instanceof Error ? error.message : "Unexpected failure."}\n`);
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
