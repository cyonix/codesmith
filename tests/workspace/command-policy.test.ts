import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectProjectProfile, validateCommand } from "../../src/workspace/command-policy.js";
import { hardenedGitArguments, ToolExecutor } from "../../src/workspace/tools.js";

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codesmith-profile-"));
  await Promise.all(Object.entries(files).map(async ([filename, contents]) => writeFile(path.join(root, filename), contents)));
  return root;
}

test("detects exact Swift package commands", async (context) => {
  const root = await project({ "Package.swift": "// swift-tools-version: 6.0" });
  context.after(async () => rm(root, { recursive: true, force: true }));

  const profile = await detectProjectProfile(root);

  assert.deepEqual(profile.kinds, ["swift"]);
  assert.deepEqual(validateCommand("swift test", profile), {
    command: "swift test", executable: "swift", arguments: ["test"],
  });
  assert.throws(() => validateCommand("swift test --filter Agent", profile), /not allowlisted/);
});

test("distinguishes Xcode projects and rejects marker symlinks", async (context) => {
  const root = await project({});
  const outside = await project({ "package.json": JSON.stringify({ scripts: { test: "untrusted" } }) });
  context.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await mkdir(path.join(root, "Sample.xcodeproj"));
  await symlink(path.join(outside, "package.json"), path.join(root, "package.json"));

  const profile = await detectProjectProfile(root);

  assert.deepEqual(profile.kinds, ["xcode"]);
  assert.deepEqual(validateCommand("xcodebuild build", profile).arguments, ["build"]);
  assert.throws(() => validateCommand("npm test", profile), /not allowlisted/);
});

test("uses only declared Node package scripts and identifies TypeScript", async (context) => {
  const root = await project({
    "package.json": JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." } }),
    "tsconfig.json": "{}",
  });
  context.after(async () => rm(root, { recursive: true, force: true }));

  const profile = await detectProjectProfile(root);

  assert.deepEqual(profile.kinds, ["javascript", "typescript"]);
  assert.deepEqual(validateCommand("npm test", profile), {
    command: "npm test", executable: "npm", arguments: ["test"],
  });
  assert.deepEqual(validateCommand("npm run lint", profile), {
    command: "npm run lint", executable: "npm", arguments: ["run", "lint"],
  });
  assert.throws(() => validateCommand("npm run build", profile), /not allowlisted/);
});

test("detects Python, Rust, and Go profiles in mixed projects without enabling arbitrary commands", async (context) => {
  const root = await project({
    "pyproject.toml": "[project]\nname = 'sample'",
    "Cargo.toml": "[package]\nname = 'sample'",
    "go.mod": "module example.com/sample",
  });
  context.after(async () => rm(root, { recursive: true, force: true }));

  const profile = await detectProjectProfile(root);

  assert.deepEqual(profile.kinds, ["python", "rust", "go"]);
  assert.deepEqual(validateCommand("python -m pytest", profile).arguments, ["-m", "pytest"]);
  assert.deepEqual(validateCommand("cargo clippy", profile).arguments, ["clippy"]);
  assert.deepEqual(validateCommand("go test ./...", profile).arguments, ["test", "./..."]);
  for (const command of ["python -c 'import os'", "cargo install foo", "go test; rm -rf /", "git status"]) {
    assert.throws(() => validateCommand(command, profile), /not allowlisted/);
  }
});

test("leaves an unrecognized project without executable commands", async (context) => {
  const root = await project({ "README.txt": "No project marker" });
  context.after(async () => rm(root, { recursive: true, force: true }));

  const profile = await detectProjectProfile(root);

  assert.deepEqual(profile, { kinds: [], commands: [] });
  assert.throws(() => validateCommand("swift build", profile), /Allowed: no commands/);
});

test("exposes run_command only with an enum of detected commands", async (context) => {
  const unknownRoot = await project({ "README.txt": "No project marker" });
  const swiftRoot = await project({ "Package.swift": "// swift-tools-version: 6.0" });
  context.after(async () => Promise.all([rm(unknownRoot, { recursive: true, force: true }), rm(swiftRoot, { recursive: true, force: true })]));

  const unknownTools = await ToolExecutor.create(unknownRoot);
  const swiftTools = await ToolExecutor.create(swiftRoot);
  const runCommand = swiftTools.definitions.find((definition) => definition.function.name === "run_command");

  assert.equal(unknownTools.definitions.some((definition) => definition.function.name === "run_command"), false);
  assert.match(JSON.stringify(runCommand), /"enum":\["swift build","swift test"\]/);
});

test("runs a detected npm command using the trusted executable path", async (context) => {
  const root = await project({
    "package.json": JSON.stringify({ scripts: { test: "node -e \"console.log('profile command ran')\"" } }),
  });
  context.after(async () => rm(root, { recursive: true, force: true }));
  const tools = await ToolExecutor.create(root, true);

  const result = JSON.parse(await tools.execute({
    id: "command-1",
    function: { name: "run_command", arguments: JSON.stringify({ command: "npm test" }) },
  })) as { exit_code: number; output: string };

  assert.equal(result.exit_code, 0);
  assert.match(result.output, /profile command ran/);
});

test("hardens Git inspection against configured helper programs", () => {
  assert.deepEqual(hardenedGitArguments(["diff"]), ["--no-pager", "-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv"]);
});
