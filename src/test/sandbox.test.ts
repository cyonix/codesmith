import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectSandbox } from "../sandbox.js";

test("sandbox resolves paths inside the selected root", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-")); context.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "inside.txt"), "safe"); const sandbox = await ProjectSandbox.create(root);
  assert.equal(sandbox.relative(await sandbox.resolve("inside.txt")), "inside.txt");
});
test("sandbox rejects traversal outside the root", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-")); context.after(async () => rm(root, { recursive: true, force: true }));
  const sandbox = await ProjectSandbox.create(root);
  await assert.rejects(() => sandbox.resolve("../outside.txt"), /escapes the selected project root/);
});
test("sandbox rejects a symlink that escapes the root", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "swiftcoderai-")); const outside = path.join(tmpdir(), `swiftcoderai-outside-${crypto.randomUUID()}`);
  context.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { force: true })]));
  await writeFile(outside, "outside"); await symlink(outside, path.join(root, "escape"));
  const sandbox = await ProjectSandbox.create(root);
  await assert.rejects(() => sandbox.resolve("escape"), /escapes the selected project root/);
});
