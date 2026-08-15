import { realpath, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import { CodeSmithError } from "../shared/errors.js";

export class ProjectSandbox {
  readonly root: string;

  private constructor(
    root: string,
    private readonly device: number,
    private readonly inode: number,
  ) {
    this.root = root;
  }

  static async create(root: string): Promise<ProjectSandbox> {
    try {
      const canonical = await realpath(root);
      const rootStat = statSync(canonical);

      if (!rootStat.isDirectory()) throw new Error("not a directory");

      return new ProjectSandbox(canonical, rootStat.dev, rootStat.ino);
    } catch {
      throw new CodeSmithError("sandbox", `Project root is not an existing directory: ${root}`);
    }
  }

  async resolve(relativePath: string): Promise<string> {
    if (!relativePath) throw new CodeSmithError("sandbox", "Paths must not be empty.");

    const candidate = path.resolve(this.root, relativePath);
    const canonical = await realpath(candidate).catch(() => candidate);

    if (!isContained(this.root, canonical)) {
      throw new CodeSmithError(
        "sandbox",
        `Path escapes the selected project root: ${relativePath}`,
      );
    }

    return canonical;
  }

  relative(filePath: string): string {
    return path.relative(this.root, filePath);
  }

  async assertUnchanged(): Promise<void> {
    const canonical = await realpath(this.root);
    const current = await stat(canonical);

    if (canonical !== this.root || current.dev !== this.device || current.ino !== this.inode) {
      throw new CodeSmithError("sandbox", "The selected project root changed during this session.");
    }
  }
}

export function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);

  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
