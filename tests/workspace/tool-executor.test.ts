import assert from "node:assert/strict";
import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolExecutor } from "../../src/workspace/tools.js";
import type { ToolCall } from "../../src/shared/types.js";

void test("does not patch a file when approval is denied", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "source.swift");
  await writeFile(filePath, "let value = 1");
  const result = await (
    await ToolExecutor.create(root, false, () => Promise.resolve(false))
  ).execute(call("apply_patch", { path: "source.swift", expected_content: "1", replacement: "2" }));
  assert.deepEqual(JSON.parse(result), { status: "declined" });
  assert.equal(await readFile(filePath, "utf8"), "let value = 1");
});
void test("creates a root file after approval", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const tools = await ToolExecutor.create(root, false, () => Promise.resolve(true));

  const result = await tools.execute(
    call("create_file", { path: "HelloWorld.swift", content: 'print("Hello, World!")\n' }),
  );

  assert.deepEqual(JSON.parse(result), { status: "created", path: "HelloWorld.swift" });
  assert.equal(
    await readFile(path.join(root, "HelloWorld.swift"), "utf8"),
    'print("Hello, World!")\n',
  );
});
void test("deletes a root file after approval", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "HelloWorld.swift");
  await writeFile(filePath, 'print("Hello, World!")\n');

  const result = await (
    await ToolExecutor.create(root, false, () => Promise.resolve(true))
  ).execute(call("delete_file", { path: "HelloWorld.swift" }));

  assert.deepEqual(JSON.parse(result), { status: "deleted", path: "HelloWorld.swift" });
  await assert.rejects(() => readFile(filePath));
});
void test("rejects deletion of a worktree .git file", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".git"), "gitdir: /tmp/real-git\n");

  const result = await (
    await ToolExecutor.create(root, true)
  ).execute(call("delete_file", { path: ".git" }));

  assert.match(resultError(result), /not permitted/);
  assert.equal(await readFile(path.join(root, ".git"), "utf8"), "gitdir: /tmp/real-git\n");
});
void test("does not perform an approved edit after cancellation", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  let cancelled = false;
  const tools = await ToolExecutor.create(
    root,
    false,
    () => {
      cancelled = true;
      return Promise.resolve(true);
    },
    () => cancelled,
  );

  const result = await tools.execute(
    call("create_file", { path: "HelloWorld.swift", content: 'print("Hello, World!")\n' }),
  );

  assert.match(resultError(result), /session is closed/);
  await assert.rejects(() => readFile(path.join(root, "HelloWorld.swift")));
});
void test("preserves a file replaced while deletion approval is pending", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "HelloWorld.swift");
  await writeFile(filePath, 'print("Original")\n');
  const tools = await ToolExecutor.create(root, false, async () => {
    await rm(filePath);
    await writeFile(filePath, 'print("Replacement")\n');
    return true;
  });

  const result = await tools.execute(call("delete_file", { path: "HelloWorld.swift" }));

  assert.match(resultError(result), /changed while awaiting approval/);
  assert.equal(await readFile(filePath, "utf8"), 'print("Replacement")\n');
});
void test("preserves a directory replacing a delete target during approval", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "HelloWorld.swift");
  await writeFile(filePath, 'print("Original")\n');
  const tools = await ToolExecutor.create(root, false, async () => {
    await rm(filePath);
    await mkdir(filePath);
    return true;
  });

  const result = await tools.execute(call("delete_file", { path: "HelloWorld.swift" }));

  assert.match(resultError(result), /changed while awaiting approval/);
  assert.equal((await stat(filePath)).isDirectory(), true);
});
void test("rejects a root symlink deletion and preserves its nested target", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "Sources"));
  const target = path.join(root, "Sources", "main.swift");
  await writeFile(target, 'print("Hello, World!")\n');
  await symlink(target, path.join(root, "HelloWorld.swift"));

  const result = await (
    await ToolExecutor.create(root, true)
  ).execute(call("delete_file", { path: "HelloWorld.swift" }));

  assert.match(resultError(result), /regular files/);
  assert.equal(await readFile(target, "utf8"), 'print("Hello, World!")\n');
});
void test("rejects nested create_file paths", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const result = await (
    await ToolExecutor.create(root, true)
  ).execute(
    call("create_file", {
      path: "Sources/HelloWorld/main.swift",
      content: 'print("Hello, World!")\n',
    }),
  );

  assert.match(resultError(result), /project root/);
});
void test("rejects create_file traversal paths", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const result = await (
    await ToolExecutor.create(root, true)
  ).execute(call("create_file", { path: "../outside.swift", content: "print(1)" }));

  assert.match(resultError(result), /project root/);
});
void test("writes an approved patch through the constrained descriptor", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "Sources"));
  const filePath = path.join(root, "Sources", "source.swift");
  await writeFile(filePath, "let value = 1");
  const result = await (
    await ToolExecutor.create(root, false, () => Promise.resolve(true))
  ).execute(
    call("apply_patch", { path: "Sources/source.swift", expected_content: "1", replacement: "2" }),
  );
  assert.deepEqual(JSON.parse(result), { status: "applied", path: "Sources/source.swift" });
  assert.equal(await readFile(filePath, "utf8"), "let value = 2");
});
void test("rejects a hard-linked patch target and preserves its external source", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  const outside = await mkdtemp(path.join(tmpdir(), "swiftcoderai-outside-"));
  context.after(async () =>
    Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]),
  );
  const externalFile = path.join(outside, "external.swift");
  await writeFile(externalFile, "let value = 1");
  await link(externalFile, path.join(root, "shared.swift"));

  const result = await (
    await ToolExecutor.create(root, true)
  ).execute(call("apply_patch", { path: "shared.swift", expected_content: "1", replacement: "2" }));

  assert.match(resultError(result), /multiple hard links/);
  assert.equal(await readFile(externalFile, "utf8"), "let value = 1");
});
void test("blocks direct access to .git internals", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, ".git", "config"), "[core]");
  const result = await (
    await ToolExecutor.create(root, true)
  ).execute(call("read_file", { path: ".git/config" }));
  assert.match(resultError(result), /not permitted/);
});
void test("rejects reads after the selected project root is replaced", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  const movedRoot = `${root}-moved`;
  context.after(async () =>
    Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(movedRoot, { recursive: true, force: true }),
    ]),
  );
  await writeFile(path.join(root, "source.swift"), "let value = 1");
  const tools = await ToolExecutor.create(root, true);
  await rename(root, movedRoot);
  await mkdir(root);
  await writeFile(path.join(root, "source.swift"), "let replacement = 2");

  const result = await tools.execute(call("read_file", { path: "source.swift" }));

  assert.match(resultError(result), /project root changed/);
});
void test("renders patch approval text without terminal control sequences", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "source.swift"), "let value = 1");
  let approvalSummary = "";
  const tools = await ToolExecutor.create(root, false, (request) => {
    approvalSummary = request.summary;
    return Promise.resolve(false);
  });

  await tools.execute(
    call("apply_patch", { path: "source.swift", expected_content: "1", replacement: "\u001b[2J2" }),
  );

  assert.match(approvalSummary, /"\\u001b\[2J2"/);
  assert.doesNotMatch(approvalSummary, new RegExp(String.fromCharCode(0x1b)));
});
void test("escapes C1 and bidirectional terminal controls in patch approval text", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "source.swift"), "let value = 1");
  let approvalSummary = "";
  const tools = await ToolExecutor.create(root, false, (request) => {
    approvalSummary = request.summary;
    return Promise.resolve(false);
  });

  await tools.execute(
    call("apply_patch", {
      path: "source.swift",
      expected_content: "1",
      replacement: "\u009b2J\u202e2",
    }),
  );

  assert.match(approvalSummary, /\\u009b2J\\u202e2/);
  assert.doesNotMatch(approvalSummary, /[\u009b\u202e]/);
});
void test("escapes terminal controls in patch target paths", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const filename = "evil\u001b[2J.swift";
  await writeFile(path.join(root, filename), "let value = 1");
  let approvalSummary = "";
  const tools = await ToolExecutor.create(root, false, (request) => {
    approvalSummary = request.summary;
    return Promise.resolve(false);
  });

  await tools.execute(
    call("apply_patch", { path: filename, expected_content: "1", replacement: "2" }),
  );

  assert.match(approvalSummary, /evil\\u001b\[2J\.swift/);
  assert.doesNotMatch(approvalSummary, new RegExp(String.fromCharCode(0x1b)));
});
function call(name: string, argumentsValue: Record<string, string>): ToolCall {
  return { id: "test", function: { name, arguments: JSON.stringify(argumentsValue) } };
}

function resultError(result: string): string {
  const parsed: unknown = JSON.parse(result);
  assert.ok(
    typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "string",
  );
  return parsed.error;
}
