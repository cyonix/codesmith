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
import { isReadOnlyWorkspaceTool, ToolExecutor } from "../../src/workspace/tools.js";
import type { ToolCall } from "../../src/shared/types.js";

void test("classifies file and Git inspection as read-only workspace tools", () => {
  for (const toolName of ["list_files", "search_files", "read_file", "git_status", "git_diff"]) {
    assert.equal(isReadOnlyWorkspaceTool(toolName), true);
  }
  for (const toolName of ["create_file", "delete_file", "apply_patch", "run_command"]) {
    assert.equal(isReadOnlyWorkspaceTool(toolName), false);
  }
});

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
void test("creates a root file with content larger than the old fragment limit", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const content = "x".repeat(501);
  const tools = await ToolExecutor.create(root, false, () => Promise.resolve(true));

  const result = await tools.execute(call("create_file", { path: "large.txt", content }));

  assert.deepEqual(JSON.parse(result), { status: "created", path: "large.txt" });
  assert.equal(await readFile(path.join(root, "large.txt"), "utf8"), content);
});
void test("rejects new-file content larger than 10 MB", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "oversized.txt");
  const tools = await ToolExecutor.create(root, true);

  const result = await tools.execute(
    call("create_file", { path: "oversized.txt", content: "x".repeat(10_000_001) }),
  );

  assert.match(resultError(result), /at most 10 MB/);
  await assert.rejects(() => readFile(filePath));
});
void test("reads files in bounded line pages with continuation metadata", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "large.txt"),
    Array.from({ length: 205 }, (_, index) => `line ${index + 1}`).join("\n"),
  );
  const tools = await ToolExecutor.create(root, true);

  const firstPage = JSON.parse(
    await tools.execute(call("read_file", { path: "large.txt" })),
  ) as Record<string, unknown>;
  assert.equal(firstPage.start_line, 1);
  assert.equal(firstPage.end_line, 200);
  assert.equal(firstPage.total_lines, 205);
  assert.equal(firstPage.truncated, true);
  assert.equal(firstPage.next_start_line, 201);
  assert.equal((firstPage.content as string).split("\n").length, 200);
  assert.ok(Buffer.byteLength(firstPage.content as string, "utf8") <= 20_000);

  const secondPage = JSON.parse(
    await tools.execute(call("read_file", { path: "large.txt", start_line: 201 })),
  ) as Record<string, unknown>;
  assert.equal(secondPage.start_line, 201);
  assert.equal(secondPage.end_line, 205);
  assert.equal(secondPage.total_lines, 205);
  assert.equal(secondPage.truncated, false);
  assert.equal(secondPage.next_start_line, undefined);
});
void test("marks an oversized line as incomplete without splitting UTF-8", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "large-line.txt"), "😀".repeat(10_000));
  const tools = await ToolExecutor.create(root, true);

  const result = JSON.parse(
    await tools.execute(call("read_file", { path: "large-line.txt" })),
  ) as Record<string, unknown>;
  const returned = result.content as string;
  assert.equal(result.truncated, true);
  assert.equal(result.truncated_line, true);
  assert.equal(result.total_lines, 1);
  assert.ok(Buffer.byteLength(returned, "utf8") <= 20_000);
  assert.equal(returned.endsWith("\uFFFD"), false);
});
void test("preserves CRLF content returned for an exact multi-line patch", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "crlf.txt");
  await writeFile(filePath, "first\r\nsecond\r\nthird");
  const tools = await ToolExecutor.create(root, true);

  const readResult = JSON.parse(await tools.execute(call("read_file", { path: "crlf.txt" }))) as {
    content: string;
  };
  assert.equal(readResult.content, "first\r\nsecond\r\nthird");

  const patchResult = JSON.parse(
    await tools.execute(
      call("apply_patch", {
        path: "crlf.txt",
        expected_content: "first\r\nsecond",
        replacement: "first\r\nupdated",
      }),
    ),
  ) as { status: string };
  assert.equal(patchResult.status, "applied");
  assert.equal(await readFile(filePath, "utf8"), "first\r\nupdated\r\nthird");
});
void test("keeps the complete escaped read result within the evidence budget", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "escaped.txt"), "\\".repeat(10_000));
  const tools = await ToolExecutor.create(root, true);

  const result = await tools.execute(call("read_file", { path: "escaped.txt" }));
  assert.ok(Buffer.byteLength(result, "utf8") <= 20_000);
  const parsed = JSON.parse(result) as { content: string; truncated: boolean };
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.content.length < 10_000);
});
void test("bounds complete listing and search results after JSON escaping", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await Promise.all(
    Array.from({ length: 200 }, (_, index) =>
      writeFile(
        path.join(root, `escaped-${String(index).padStart(3, "0")}-${"\\".repeat(80)}.txt`),
        `needle${'"'.repeat(300)}`,
      ),
    ),
  );
  const tools = await ToolExecutor.create(root, true);

  const listing = await tools.execute(call("list_files", {}));
  assert.ok(Buffer.byteLength(listing, "utf8") <= 20_000);
  const parsedListing = JSON.parse(listing) as { files: string[]; truncated: boolean };
  assert.equal(parsedListing.truncated, true);

  const search = await tools.execute(call("search_files", { query: "needle" }));
  assert.ok(Buffer.byteLength(search, "utf8") <= 20_000);
  const parsedSearch = JSON.parse(search) as {
    matches: unknown[];
    truncated: boolean;
  };
  assert.equal(parsedSearch.truncated, true);
  assert.ok(parsedSearch.matches.length < 50);
});
void test("paginates directory listings and marks capped searches", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await Promise.all(
    Array.from({ length: 205 }, (_, index) =>
      writeFile(path.join(root, `file-${String(index).padStart(3, "0")}.txt`), "needle"),
    ),
  );
  await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      writeFile(path.join(root, `zz-exact-${String(index).padStart(2, "0")}.txt`), "exact"),
    ),
  );
  const tools = await ToolExecutor.create(root, true);

  const listing = JSON.parse(await tools.execute(call("list_files", { offset: 200 }))) as Record<
    string,
    unknown
  >;
  assert.deepEqual((listing.files as string[]).slice(0, 5), [
    "file-200.txt",
    "file-201.txt",
    "file-202.txt",
    "file-203.txt",
    "file-204.txt",
  ]);
  assert.equal((listing.files as string[]).length, 55);
  assert.equal(listing.total_files, 255);
  assert.equal(listing.truncated, false);

  const search = JSON.parse(
    await tools.execute(call("search_files", { query: "needle" })),
  ) as Record<string, unknown>;
  assert.equal((search.matches as unknown[]).length, 50);
  assert.equal(search.truncated, true);

  const exactSearch = JSON.parse(
    await tools.execute(call("search_files", { query: "exact" })),
  ) as Record<string, unknown>;
  assert.equal((exactSearch.matches as unknown[]).length, 50);
  assert.equal(exactSearch.truncated, false);
});
void test("rejects invalid grounded-context pagination arguments", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "file.txt"), "content");
  const tools = await ToolExecutor.create(root, true);

  assert.match(
    resultError(await tools.execute(call("read_file", { path: "file.txt", start_line: 0 }))),
    /start_line must be a safe integer greater than or equal to 1/,
  );
  assert.match(
    resultError(await tools.execute(call("list_files", { offset: -1 }))),
    /offset must be a safe integer greater than or equal to 0/,
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
void test("applies patch fragments larger than the old fragment limit", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "source.swift");
  const expected = "old".repeat(200);
  const replacement = "new".repeat(200);
  await writeFile(filePath, `prefix ${expected} suffix`);
  const tools = await ToolExecutor.create(root, false, () => Promise.resolve(true));

  const result = await tools.execute(
    call("apply_patch", { path: "source.swift", expected_content: expected, replacement }),
  );

  assert.deepEqual(JSON.parse(result), { status: "applied", path: "source.swift" });
  assert.equal(await readFile(filePath, "utf8"), `prefix ${replacement} suffix`);
});
void test("rejects an oversized patch before approval and preserves the original file", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "source.swift");
  await writeFile(filePath, "original");
  let approvalRequests = 0;
  const tools = await ToolExecutor.create(root, false, () => {
    approvalRequests += 1;
    return Promise.resolve(true);
  });

  const result = await tools.execute(
    call("apply_patch", {
      path: "source.swift",
      expected_content: "original",
      replacement: "x".repeat(10_000_001),
    }),
  );

  assert.match(resultError(result), /exceed 10 MB/);
  assert.equal(approvalRequests, 0);
  assert.equal(await readFile(filePath, "utf8"), "original");
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
function call(name: string, argumentsValue: Record<string, unknown>): ToolCall {
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
