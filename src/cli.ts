#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stderr, stdin, stdout } from "node:process";
import { AgentSession } from "./agent-session.js";
import type { AgentEvent } from "./agent-events.js";
import { CodeSmithError } from "./errors.js";
import { OpenAICompatibleProvider } from "./provider.js";

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) { stdout.write(`${help}\n`); return; }
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const provider = new OpenAICompatibleProvider();
    const session = await AgentSession.create({ projectRoot: options.project, provider, autoApprove: options.yes });
    session.subscribe((event) => { void handleEvent(event, session, readline); });
    stdout.write(`CodeSmith is ready for ${options.project}. Type /exit to quit.\n`);
    while (true) {
      const prompt = await readline.question("\ncodesmith> ");
      if (prompt === "/exit" || prompt === "/quit") break;
      if (!prompt.trim()) continue;
      const answer = await session.submit(prompt);
      if (answer) stdout.write(`\n${answer}\n`);
    }
    session.close();
  } finally { readline.close(); }
}
async function handleEvent(event: AgentEvent, session: AgentSession, readline: ReturnType<typeof createInterface>): Promise<void> {
  if (event.type !== "approval_requested") return;
  const answer = await readline.question(`\n${event.kind[0].toUpperCase()}${event.kind.slice(1)} approval required:\n${event.summary}\nAllow? [y/N] `);
  session.approve(event.requestId, answer.trim().toLowerCase() === "y");
}
function parseOptions(argumentsValue: string[]): { project: string; yes: boolean; help: boolean } {
  let project: string | undefined; let yes = false;
  for (let index = 0; index < argumentsValue.length; index += 1) {
    const argument = argumentsValue[index];
    if (argument === "--help" || argument === "-h") return { project: "", yes: false, help: true };
    if (argument === "--yes") { yes = true; continue; }
    if (argument === "--project") { project = argumentsValue[++index]; if (!project) throw new CodeSmithError("configuration", "--project requires a directory path."); continue; }
    throw new CodeSmithError("configuration", `Unknown option: ${argument}`);
  }
  if (!project) throw new CodeSmithError("configuration", "--project is required to select a project root.");
  return { project, yes, help: false };
}
const help = `codesmith — a local coding agent for Swift, JavaScript, TypeScript, Python, Rust, and Go projects
Usage: codesmith --project <directory> [--yes]
Required environment: CODESMITH_API_KEY, CODESMITH_BASE_URL, CODESMITH_MODEL
All file paths are constrained to --project. Every edit, Git inspection, and detected project command requires confirmation unless --yes is supplied.
Commands are detected from project manifests and are always executed without a shell.`;
main().catch((error: unknown) => { stderr.write(`codesmith: ${error instanceof Error ? error.message : "Unexpected failure."}\n`); process.exitCode = 1; });
