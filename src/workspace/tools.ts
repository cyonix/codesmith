import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir, realpath, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { commandDescription, detectProjectProfile, validateCommand, type ProjectProfile } from "./command-policy.js";
import { CodeSmithError as SwiftCoderAIError } from "../shared/errors.js";
import { isContained, ProjectSandbox } from "./sandbox.js";
import type { JsonValue, ToolCall, ToolDefinition } from "../shared/types.js";

const MAXIMUM_TEXT_BYTES = 10_000_000;
const MAXIMUM_COMMAND_OUTPUT_BYTES = 20_000;
const MAXIMUM_PATCH_FRAGMENT_CHARACTERS = 500;

const trustedCommandDirectories = [
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/local/go/bin",
  path.dirname(process.execPath),
  path.join(os.homedir(), ".cargo", "bin"),
];

const commandPath = [...new Set(trustedCommandDirectories)].join(path.delimiter);

export type ApprovalKind = "edit" | "command";
export interface ApprovalRequest { kind: ApprovalKind; summary: string; }
export type Approval = (request: ApprovalRequest) => Promise<boolean>;

export class ToolExecutor {
  private constructor(
    private readonly sandbox: ProjectSandbox,
    readonly profile: ProjectProfile,
    private readonly autoApprove: boolean,
    private readonly approval: Approval,
    private readonly isCancelled: () => boolean,
  ) {}

  static async create(
    root: string,
    autoApprove = false,
    approval: Approval = async () => false,
    isCancelled: () => boolean = () => false,
  ): Promise<ToolExecutor> {
    const sandbox = await ProjectSandbox.create(root);
    return new ToolExecutor(sandbox, await detectProjectProfile(sandbox.root), autoApprove, approval, isCancelled);
  }

  get definitions(): ToolDefinition[] { return toolDefinitions(this.profile); }

  async execute(call: ToolCall): Promise<string> {
    try {
      switch (call.function.name) {
        case "list_files": return await this.listFiles(parseArguments(call));
        case "search_files": return await this.searchFiles(parseArguments(call));
        case "read_file": return await this.readFile(parseArguments(call));
        case "create_file": return await this.createFile(parseArguments(call));
        case "delete_file": return await this.deleteFile(parseArguments(call));
        case "apply_patch": return await this.applyPatch(parseArguments(call));
        case "git_status": return await this.runGit(["status", "--short"]);
        case "git_diff": return await this.runGit(["diff"]);
        case "run_command": return await this.runCommand(parseArguments(call));
        default: throw new SwiftCoderAIError("arguments", `Unknown tool: ${call.function.name}`);
      }
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : "Tool execution failed." });
    }
  }

  private async listFiles(argumentsValue: Record<string, unknown>): Promise<string> {
    await this.sandbox.assertUnchanged();
    const directory = await this.permitted(await this.sandbox.resolve(optionalString(argumentsValue.path, "path") ?? "."));
    const files = (await readVerifiedDirectory(this.sandbox.root, directory)).map((entry) => entry.name).filter((entry) => entry !== ".git").sort();
    await this.sandbox.assertUnchanged();
    return JSON.stringify({ files });
  }

  private async searchFiles(argumentsValue: Record<string, unknown>): Promise<string> {
    await this.sandbox.assertUnchanged();
    const query = requiredString(argumentsValue.query, "query");
    const directory = await this.permitted(await this.sandbox.resolve(optionalString(argumentsValue.path, "path") ?? "."));
    const matches: Array<{ path: string; line: number; text: string }> = [];
    await this.searchDirectory(directory, query, matches);
    await this.sandbox.assertUnchanged();
    return JSON.stringify({ matches });
  }

  private async searchDirectory(directory: string, query: string, matches: Array<{ path: string; line: number; text: string }>): Promise<void> {
    for (const entry of await readVerifiedDirectory(this.sandbox.root, directory)) {
      if (matches.length >= 50 || entry.name === ".git") continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) { await this.searchDirectory(entryPath, query, matches); continue; }
      if (!entry.isFile() || (await stat(entryPath)).size > 512_000) continue;
      const content = await this.readTextSafely(entryPath, 512_000);
      if (content === undefined) continue;
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        if (line.toLocaleLowerCase().includes(query.toLocaleLowerCase())) {
          matches.push({ path: this.sandbox.relative(entryPath), line: index + 1, text: line.slice(0, 300) });
          if (matches.length === 50) return;
        }
      }
    }
  }

  private async readFile(argumentsValue: Record<string, unknown>): Promise<string> {
    await this.sandbox.assertUnchanged();
    const filePath = await this.permitted(await this.sandbox.resolve(requiredString(argumentsValue.path, "path")));
    const content = await this.readTextSafely(filePath, MAXIMUM_TEXT_BYTES);
    await this.sandbox.assertUnchanged();
    if (content === undefined) throw new SwiftCoderAIError("arguments", "File is not valid UTF-8 text.");
    return JSON.stringify({ path: this.sandbox.relative(filePath), content });
  }

  private async createFile(argumentsValue: Record<string, unknown>): Promise<string> {
    const requestedPath = requiredString(argumentsValue.path, "path");
    const content = requiredString(argumentsValue.content, "content");

    assertRootFilePath(requestedPath, "create_file");

    if (content.length > MAXIMUM_PATCH_FRAGMENT_CHARACTERS || Buffer.byteLength(content, "utf8") > MAXIMUM_TEXT_BYTES) {
      throw new SwiftCoderAIError("arguments", "New-file content must be at most 500 characters and 1 MB.");
    }

    const filePath = await this.permitted(await this.sandbox.resolve(requestedPath));

    try {
      await stat(filePath);
      throw new SwiftCoderAIError("arguments", `File already exists: ${requestedPath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const summary = `Create ${safePreview(requestedPath)}:\n+ ${safePreview(content)}`;
    if (!(await this.isApproved({ kind: "edit", summary }))) return JSON.stringify({ status: "declined" });

    this.assertActive();
    await this.sandbox.assertUnchanged();

    let handle;

    try {
      handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const fileStat = await handle.stat();
      await this.sandbox.assertUnchanged();
      await validateOpenedTarget(handle, fileStat, this.sandbox.root, filePath);
      await handle.writeFile(content, "utf8");
    } catch (error) {
      if (error instanceof SwiftCoderAIError) throw error;
      throw new SwiftCoderAIError("arguments", `Could not create ${requestedPath}; it may already exist.`);
    } finally {
      await handle?.close();
    }

    return JSON.stringify({ status: "created", path: requestedPath });
  }

  private async deleteFile(argumentsValue: Record<string, unknown>): Promise<string> {
    const requestedPath = requiredString(argumentsValue.path, "path");

    assertRootFilePath(requestedPath, "delete_file");

    if (requestedPath === ".git") throw new SwiftCoderAIError("sandbox", "Access to .git internals is not permitted.");

    const filePath = path.join(this.sandbox.root, requestedPath);
    const original = await lstat(filePath);

    if (!original.isFile()) throw new SwiftCoderAIError("arguments", "delete_file only supports existing regular files.");

    if (!(await this.isApproved({ kind: "edit", summary: `Delete ${safePreview(requestedPath)}.` }))) return JSON.stringify({ status: "declined" });

    this.assertActive();
    await this.sandbox.assertUnchanged();

    const current = await lstat(filePath);
    if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino) {
      throw new SwiftCoderAIError("arguments", "Delete target changed while awaiting approval.");
    }

    const stagedPath = path.join(this.sandbox.root, `.codesmith-delete-${randomUUID()}`);

    try {
      await rename(filePath, stagedPath);
      const staged = await lstat(stagedPath);
      if (!staged.isFile() || staged.dev !== original.dev || staged.ino !== original.ino) {
        await restoreStagedEntry(stagedPath, filePath, staged);
        throw new SwiftCoderAIError("arguments", "Delete target changed while awaiting approval.");
      }
      await unlink(stagedPath);
    } catch (error) {
      if (error instanceof SwiftCoderAIError) throw error;
      throw new SwiftCoderAIError("arguments", "Delete target changed while awaiting approval.");
    }

    return JSON.stringify({ status: "deleted", path: requestedPath });
  }

  private async applyPatch(argumentsValue: Record<string, unknown>): Promise<string> {
    const requestedPath = requiredString(argumentsValue.path, "path");
    const expected = requiredString(argumentsValue.expected_content, "expected_content");
    const replacement = requiredString(argumentsValue.replacement, "replacement");

    if (expected.length > MAXIMUM_PATCH_FRAGMENT_CHARACTERS || replacement.length > MAXIMUM_PATCH_FRAGMENT_CHARACTERS) throw new SwiftCoderAIError("arguments", "Patch fragments must be at most 500 characters so the full change can be approved.");

    const filePath = await this.permitted(await this.sandbox.resolve(requestedPath));
    await assertPatchableText(filePath);

    const initialContent = await this.readTextSafely(filePath, MAXIMUM_TEXT_BYTES);
    if (!initialContent || occurrences(initialContent, expected) !== 1) throw new SwiftCoderAIError("arguments", "expected_content must occur exactly once.");

    const summary = `Apply patch to ${safePreview(this.sandbox.relative(filePath))}:\n- ${safePreview(expected)}\n+ ${safePreview(replacement)}`;
    if (!(await this.isApproved({ kind: "edit", summary }))) return JSON.stringify({ status: "declined" });

    this.assertActive();
    await this.sandbox.assertUnchanged();

    const finalPath = await this.permitted(await this.sandbox.resolve(requestedPath));
    await replaceVerifiedText(this.sandbox, finalPath, expected, replacement);
    return JSON.stringify({ status: "applied", path: this.sandbox.relative(finalPath) });
  }

  private async runGit(argumentsValue: string[]): Promise<string> {
    const argumentsList = hardenedGitArguments(argumentsValue);

    if (!(await this.isApproved({ kind: "command", summary: `git ${argumentsValue.join(" ")}` }))) return JSON.stringify({ status: "declined" });

    this.assertActive();
    await this.sandbox.assertUnchanged();

    return JSON.stringify(await runProcess("git", argumentsList, this.sandbox.root, this.isCancelled));
  }

  private async runCommand(argumentsValue: Record<string, unknown>): Promise<string> {
    const command = requiredString(argumentsValue.command, "command");
    const commandDefinition = validateCommand(command, this.profile);

    if (!(await this.isApproved({ kind: "command", summary: command }))) return JSON.stringify({ status: "declined" });

    this.assertActive();
    await this.sandbox.assertUnchanged();

    const executable = await resolveApprovedExecutable(commandDefinition.executable);
    return JSON.stringify(await runProcess(executable, commandDefinition.arguments, this.sandbox.root, this.isCancelled));
  }

  private async isApproved(request: ApprovalRequest): Promise<boolean> { return this.autoApprove || this.approval(request); }

  private assertActive(): void {
    if (this.isCancelled()) throw new SwiftCoderAIError("loop", "This agent session is closed.");
  }

  private async permitted(filePath: string): Promise<string> {
    assertNoGitInternals(this.sandbox.root, filePath);
    return filePath;
  }

  private async readTextSafely(filePath: string, maximumBytes: number): Promise<string | undefined> {
    let handle;

    try {
      handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return undefined;
    }

    try {
      const fileStat = await handle.stat();
      await validateOpenedTarget(handle, fileStat, this.sandbox.root, filePath);
      if (!fileStat.isFile() || fileStat.nlink !== 1 || fileStat.size > maximumBytes) return undefined;
      const bytes = await handle.readFile();
      try {
        const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return content.includes("\0") ? undefined : content;
      } catch {
        return undefined;
      }
    } finally {
      await handle.close();
    }
  }
}

function definition(name: string, description: string, properties: Record<string, JsonValue>, required: string[] = []): ToolDefinition {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, additionalProperties: false, ...(required.length > 0 ? { required } : {}) } } };
}

function toolDefinitions(profile: ProjectProfile): ToolDefinition[] {
  const definitions = [
    definition("list_files", "List direct children of a project-relative directory. Omit path for the project root.", { path: stringSchema() }),
    definition("search_files", "Search UTF-8 text files under the project root for a literal query.", { query: stringSchema(), path: stringSchema() }, ["query"]),
    definition("read_file", "Read a UTF-8 text file within the project root.", { path: stringSchema() }, ["path"]),
    definition("create_file", "Create a new UTF-8 text file directly in the project root. The file must not already exist. Requires user approval unless --yes is set.", { path: stringSchema(), content: stringSchema() }, ["path", "content"]),
    definition("delete_file", "Delete an existing regular file directly in the project root. Requires user approval unless --yes is set.", { path: stringSchema() }, ["path"]),
    definition("apply_patch", "Replace one unique exact text fragment in an existing UTF-8 text file. Requires user approval unless --yes is set.", { path: stringSchema(), expected_content: stringSchema(), replacement: stringSchema() }, ["path", "expected_content", "replacement"]),
    definition("git_status", "Run git status --short inside the project. Requires user approval unless --yes is set.", {}),
    definition("git_diff", "Run git diff inside the project. Requires user approval unless --yes is set.", {}),
  ];

  if (profile.commands.length > 0) {
    definitions.push(definition("run_command", commandDescription(profile), { command: stringSchema(profile.commands.map((command) => command.command)) }, ["command"]));
  }

  return definitions;
}

function stringSchema(values?: string[]): JsonValue { return { type: "string", ...(values ? { enum: values } : {}) }; }

function parseArguments(call: ToolCall): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(call.function.arguments); } catch { throw new SwiftCoderAIError("arguments", `Invalid arguments for ${call.function.name}.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SwiftCoderAIError("arguments", `Arguments for ${call.function.name} must be an object.`);

  return parsed as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new SwiftCoderAIError("arguments", `${field} must be a non-empty string.`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined { return value === undefined ? undefined : requiredString(value, field); }

function occurrences(content: string, expected: string): number { return content.split(expected).length - 1; }

function assertRootFilePath(requestedPath: string, toolName: string): void {
  if (path.dirname(requestedPath) !== "." || path.basename(requestedPath) !== requestedPath) {
    throw new SwiftCoderAIError("arguments", `${toolName} only supports a file directly in the project root.`);
  }
}

async function restoreStagedEntry(stagedPath: string, originalPath: string, staged: Awaited<ReturnType<typeof lstat>>): Promise<void> {
  try {
    if (staged.isFile()) {
      await link(stagedPath, originalPath);
      await unlink(stagedPath);
      return;
    }
    await lstat(originalPath);
  } catch {
    try {
      await rename(stagedPath, originalPath);
    } catch {
      // Never overwrite a concurrent replacement; retaining the staged entry is safer than deletion.
    }
  }
}

async function readVerifiedDirectory(root: string, directory: string): Promise<import("node:fs").Dirent[]> {
  const canonicalBefore = await realpath(directory);
  if (!isContained(root, canonicalBefore)) throw new SwiftCoderAIError("sandbox", "Directory changed outside the selected project root.");

  const before = await stat(canonicalBefore);
  if (!before.isDirectory()) throw new SwiftCoderAIError("sandbox", "Not a directory.");

  const entries = await readdir(canonicalBefore, { withFileTypes: true });
  const canonicalAfter = await realpath(directory);
  const after = await stat(canonicalAfter);

  if (
    canonicalAfter !== canonicalBefore ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    !isContained(root, canonicalAfter)
  ) {
    throw new SwiftCoderAIError("sandbox", "Directory changed while it was being read.");
  }

  return entries;
}

async function assertPatchableText(filePath: string): Promise<void> {
  const fileStat = await stat(filePath);

  if (!fileStat.isFile() || fileStat.size > MAXIMUM_TEXT_BYTES) throw new SwiftCoderAIError("sandbox", "Patches require an existing UTF-8 file up to 1 MB.");
  if (fileStat.nlink !== 1) throw new SwiftCoderAIError("sandbox", "Patches cannot modify files with multiple hard links.");
}
async function replaceVerifiedText(sandbox: ProjectSandbox, filePath: string, expected: string, replacement: string): Promise<void> {
  let fileHandle;

  try { fileHandle = await open(filePath, constants.O_RDWR | constants.O_NOFOLLOW); } catch { throw new SwiftCoderAIError("sandbox", "Patch target changed or is not a permitted project file."); }

  try {
    const fileStat = await fileHandle.stat();

    await sandbox.assertUnchanged();
    await validateOpenedTarget(fileHandle, fileStat, sandbox.root, filePath);

    if (!fileStat.isFile() || fileStat.size > MAXIMUM_TEXT_BYTES) throw new SwiftCoderAIError("sandbox", "Patches require an existing UTF-8 file up to 1 MB.");
    if (fileStat.nlink !== 1) throw new SwiftCoderAIError("sandbox", "Patches cannot modify files with multiple hard links.");

    const content = await fileHandle.readFile({ encoding: "utf8" });
    if (content.includes("\0") || occurrences(content, expected) !== 1) throw new SwiftCoderAIError("arguments", "expected_content changed while awaiting approval.");

    const output = content.replace(expected, replacement);
    if (Buffer.byteLength(output, "utf8") > MAXIMUM_TEXT_BYTES) throw new SwiftCoderAIError("sandbox", "Patched file would exceed 1 MB.");

    await fileHandle.truncate(0);

    let offset = 0;
    const data = Buffer.from(output, "utf8");

    while (offset < data.length) {
      const { bytesWritten } = await fileHandle.write(data, offset, data.length - offset, offset);
      offset += bytesWritten;
    }

  } finally { await fileHandle.close(); }
}

async function runProcess(
  executable: string,
  argumentsValue: string[],
  cwd: string,
  isCancelled: () => boolean,
): Promise<{ exit_code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argumentsValue, { cwd, shell: false, detached: true, env: { PATH: commandPath } });

    let output = ""; let outputBytes = 0; let truncated = false; let timedOut = false; let cancelled = false; let settled = false; let stopping = false;
    let forceKill: NodeJS.Timeout | undefined; let deadline: NodeJS.Timeout | undefined;

    const finish = (code: number): void => {
      if (settled) return; settled = true; clearTimeout(timeout); clearInterval(cancellationMonitor); if (forceKill) clearTimeout(forceKill); if (deadline) clearTimeout(deadline);
      resolve({ exit_code: code, output: output + (truncated ? "\n[Output truncated at 20,000 bytes.]" : "") + (timedOut ? "\n[Command timed out after 10 minutes.]" : "") + (cancelled ? "\n[Command cancelled because the agent session closed.]" : "") });
    };

    const terminate = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
    };

    const stop = (reason: "timeout" | "output" | "cancelled"): void => {
      if (stopping) return; stopping = true; timedOut ||= reason === "timeout"; truncated ||= reason === "output"; cancelled ||= reason === "cancelled";
      terminate("SIGTERM"); forceKill = setTimeout(() => terminate("SIGKILL"), 5_000); deadline = setTimeout(() => finish(1), 6_000);
    };

    const timeout = setTimeout(() => stop("timeout"), 10 * 60_000);
    const cancellationMonitor = setInterval(() => { if (isCancelled()) stop("cancelled"); }, 100);

    const collect = (chunk: Buffer): void => {
      const remaining = MAXIMUM_COMMAND_OUTPUT_BYTES - outputBytes;
      if (remaining > 0) { const included = chunk.subarray(0, remaining); output += included.toString(); outputBytes += included.length; }
      if (chunk.length > remaining) stop("output");
    };

    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.once("error", () => { if (!settled) { clearTimeout(timeout); clearInterval(cancellationMonitor); reject(new SwiftCoderAIError("command", `Could not start ${executable}.`)); } });
    child.once("close", (code) => finish(code ?? 1));
  });
}

async function resolveApprovedExecutable(executable: string): Promise<string> {
  const names = executable === "python" ? ["python", "python3"] : [executable];

  for (const directory of trustedCommandDirectories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        const canonical = await realpath(candidate);
        const executableStat = await stat(canonical);
        if (executableStat.isFile() && (executableStat.mode & 0o111) !== 0) return canonical;
      } catch {
        // Try the next fixed location; never consult the user's ambient PATH.
      }
    }
  }

  throw new SwiftCoderAIError("command", `No trusted executable was found for ${executable}.`);
}

export function hardenedGitArguments(argumentsValue: string[]): string[] {
  return argumentsValue[0] === "diff"
    ? ["--no-pager", "-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv"]
    : ["--no-pager", "-c", "core.fsmonitor=false", ...argumentsValue];
}

function safePreview(value: string): string {
  const escaped = [...value].map((character) => {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint <= 0x1F ||
      (codePoint >= 0x7F && codePoint <= 0x9F) ||
      (codePoint >= 0x202A && codePoint <= 0x202E) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return `\\u${codePoint.toString(16).padStart(4, "0")}`;
    }
    if (character === "\\") return "\\\\";
    if (character === "\"") return "\\\"";
    return character;
  }).join("");

  return `"${escaped}"`;
}

async function validateOpenedTarget(handle: FileHandle, handleStat: Awaited<ReturnType<FileHandle["stat"]>>, root: string, filePath: string): Promise<void> {
  const canonicalPath = await realpath(filePath);
  if (!isContained(root, canonicalPath)) throw new SwiftCoderAIError("sandbox", "File changed outside the selected project root.");

  assertNoGitInternals(root, canonicalPath);

  const pathStat = await stat(canonicalPath);
  if (handleStat.dev !== pathStat.dev || handleStat.ino !== pathStat.ino) {
    throw new SwiftCoderAIError("sandbox", "File changed while it was being opened.");
  }
}

function assertNoGitInternals(root: string, filePath: string): void {
  if (path.relative(root, filePath).split(path.sep).includes(".git")) {
    throw new SwiftCoderAIError("sandbox", "Access to .git internals is not permitted.");
  }
}
