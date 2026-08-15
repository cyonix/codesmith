import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { CodeSmithError } from "../shared/errors.js";
import { isContained } from "./sandbox.js";

export type ProjectKind = "swift" | "xcode" | "javascript" | "typescript" | "python" | "rust" | "go";

export interface ProjectCommand {
  command: string;
  executable: string;
  arguments: string[];
}

export interface ProjectProfile {
  kinds: ProjectKind[];
  commands: ProjectCommand[];
}

export async function detectProjectProfile(root: string): Promise<ProjectProfile> {
  const kinds = new Set<ProjectKind>();
  const commands: ProjectCommand[] = [];

  const addCommand = (command: string, executable: string, commandArguments: string[]): void => {
    if (!commands.some((candidate) => candidate.command === command)) {
      commands.push({ command, executable, arguments: commandArguments });
    }
  };

  if (await isFile(root, "Package.swift")) {
    kinds.add("swift");
    addCommand("swift build", "swift", ["build"]);
    addCommand("swift test", "swift", ["test"]);
  }

  if ((await directoryEntries(root)).some((entry) => entry.name.endsWith(".xcodeproj") && entry.isDirectory())) {
    kinds.add("xcode");
    addCommand("xcodebuild build", "xcodebuild", ["build"]);
    addCommand("xcodebuild test", "xcodebuild", ["test"]);
  }

  const packageJSON = await packageScripts(root);
  if (packageJSON) {
    kinds.add("javascript");
    if (await isFile(root, "tsconfig.json")) kinds.add("typescript");
    for (const script of ["test", "build", "lint"]) {
      if (packageJSON.has(script)) {
        addCommand(script === "test" ? "npm test" : `npm run ${script}`, "npm", script === "test" ? ["test"] : ["run", script]);
      }
    }
  } else if (await isFile(root, "tsconfig.json")) {
    kinds.add("typescript");
  }

  if (await hasAnyFile(root, ["pyproject.toml", "requirements.txt", "setup.py"])) {
    kinds.add("python");
    addCommand("python -m pytest", "python", ["-m", "pytest"]);
    addCommand("python -m compileall .", "python", ["-m", "compileall", "."]);
  }

  if (await isFile(root, "Cargo.toml")) {
    kinds.add("rust");
    addCommand("cargo build", "cargo", ["build"]);
    addCommand("cargo test", "cargo", ["test"]);
    addCommand("cargo clippy", "cargo", ["clippy"]);
  }

  if (await isFile(root, "go.mod")) {
    kinds.add("go");
    addCommand("go build ./...", "go", ["build", "./..."]);
    addCommand("go test ./...", "go", ["test", "./..."]);
  }

  return { kinds: [...kinds], commands };
}

export function validateCommand(command: string, profile: ProjectProfile): ProjectCommand {
  const allowed = profile.commands.find((candidate) => candidate.command === command);

  if (!allowed) {
    const expected = profile.commands.map((candidate) => candidate.command).join(", ") || "no commands";
    throw new CodeSmithError("command", `Command is not allowlisted for this project: ${command}. Allowed: ${expected}.`);
  }

  return { ...allowed, arguments: [...allowed.arguments] };
}

export function commandDescription(profile: ProjectProfile): string {
  const commands = profile.commands.map((candidate) => candidate.command);
  return commands.length > 0
    ? `Run exactly one detected project command: ${commands.join(", ")}. Requires user approval unless --yes is set.`
    : "No build or test commands were detected for this project. Requires user approval unless --yes is set.";
}

async function isFile(root: string, filename: string): Promise<boolean> {
  try {
    return (await lstat(path.join(root, filename))).isFile();
  } catch {
    return false;
  }
}

async function hasAnyFile(root: string, filenames: string[]): Promise<boolean> {
  for (const filename of filenames) {
    if (await isFile(root, filename)) return true;
  }

  return false;
}

async function directoryEntries(root: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function packageScripts(root: string): Promise<Set<string> | undefined> {
  try {
    const manifestPath = path.join(root, "package.json");
    if (!(await lstat(manifestPath)).isFile() || !isContained(root, manifestPath)) return undefined;

    const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.scripts)) return new Set();
    return new Set(Object.entries(parsed.scripts).flatMap(([name, value]) => typeof value === "string" ? [name] : []));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
