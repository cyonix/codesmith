import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EpisodicMemory,
  ReviewedModelInstaller,
  configureSemanticMemory,
  reviewedEmbeddingModel,
  type EmbeddingModel,
  type EmbeddingModelFactory,
  type EmbeddingModelInstaller,
  type MemoryEventSink,
} from "../../src/agent/episodic-memory.js";

void test("retrieves bounded relevant tool episodes and emits lifecycle events", async () => {
  const events = new EventSink();
  const memory = new EpisodicMemory(
    configureSemanticMemory(true),
    events,
    new FakeFactory(),
    new FakeInstaller(),
  );
  await memory.initialize(() => Promise.resolve(true));

  await memory.recordTool(
    { id: "read", function: { name: "read_file", arguments: '{"path":"README.md"}' } },
    '{"content":"semantic memory needle"}',
  );
  await memory.recordAssistant("The README contains the semantic memory needle.");

  const retrieved = await memory.retrieve("Where is the semantic memory needle?");

  assert.match(retrieved ?? "", /semantic memory needle/);
  assert.equal(events.recordedEvents.length, 2);
  assert.equal(events.retrievedEvents.at(-1)?.length, 2);
  assert.equal(events.failedEvents.length, 0);
});

void test("omits conventional secret-file episodes and redacts token-shaped values", async () => {
  const events = new EventSink();
  const memory = new EpisodicMemory(
    configureSemanticMemory(true),
    events,
    new FakeFactory(),
    new FakeInstaller(),
  );
  await memory.initialize(() => Promise.resolve(true));

  await memory.recordTool(
    { id: "env", function: { name: "read_file", arguments: '{"path":".env.production"}' } },
    '{"content":"token=super-secret"}',
  );
  await memory.recordTool(
    { id: "read", function: { name: "read_file", arguments: '{"path":"README.md"}' } },
    '{"content":"token=super-secret"}',
  );

  const retrieved = await memory.retrieve("README token");

  assert.equal(events.recordedEvents.length, 1);
  assert.doesNotMatch(retrieved ?? "", /super-secret/);
  assert.match(retrieved ?? "", /\[REDACTED\]/);
});

void test("omits search results that reference conventional secret files", async () => {
  const events = new EventSink();
  const memory = new EpisodicMemory(
    configureSemanticMemory(true),
    events,
    new FakeFactory(),
    new FakeInstaller(),
  );
  await memory.initialize(() => Promise.resolve(true));

  await memory.recordTool(
    { id: "search", function: { name: "search_files", arguments: '{"query":"token"}' } },
    '{"matches":[{"path":".env","line":1,"text":"TOKEN=private"}]}',
  );

  assert.equal(events.recordedEvents.length, 0);
});

void test("omits Git diffs that reference conventional secret files", async () => {
  const events = new EventSink();
  const memory = new EpisodicMemory(
    configureSemanticMemory(true),
    events,
    new FakeFactory(),
    new FakeInstaller(),
  );
  await memory.initialize(() => Promise.resolve(true));

  await memory.recordTool(
    { id: "diff", function: { name: "git_diff", arguments: "{}" } },
    '{"stdout":"diff --git a/.env b/.env\\n+DATABASE_URL=postgres://private"}',
  );

  assert.equal(events.recordedEvents.length, 0);
});

void test("does not record an assistant answer after secret-file access", async () => {
  const events = new EventSink();
  const memory = new EpisodicMemory(
    configureSemanticMemory(true),
    events,
    new FakeFactory(),
    new FakeInstaller(),
  );
  await memory.initialize(() => Promise.resolve(true));

  await memory.recordTool(
    { id: "env", function: { name: "read_file", arguments: '{"path":".env"}' } },
    '{"content":"TOKEN=private"}',
  );
  await memory.recordAssistant("The token is private.");

  assert.equal(events.recordedEvents.length, 0);
});

void test("omits service-account credential files", async () => {
  const events = new EventSink();
  const memory = new EpisodicMemory(
    configureSemanticMemory(true),
    events,
    new FakeFactory(),
    new FakeInstaller(),
  );
  await memory.initialize(() => Promise.resolve(true));

  await memory.recordTool(
    {
      id: "service-account",
      function: { name: "read_file", arguments: '{"path":"service-account.json"}' },
    },
    '{"private_key":"private-value"}',
  );

  assert.equal(events.recordedEvents.length, 0);
});

void test("evicts the oldest episode at the configured bound and clears memory", async () => {
  const events = new EventSink();
  const memory = new EpisodicMemory(
    configureSemanticMemory(true),
    events,
    new FakeFactory(),
    new FakeInstaller(),
  );
  await memory.initialize(() => Promise.resolve(true));

  for (let index = 0; index < 129; index += 1) await memory.recordAssistant(`Episode ${index}`);
  memory.clear();

  assert.equal(events.recordedEvents.length, 129);
  assert.deepEqual(events.clearedEvents, [128]);
});

void test("blocks future submissions after a recording failure", async () => {
  const events = new EventSink();
  const model = new FakeEmbeddingModel();
  const memory = new EpisodicMemory(
    configureSemanticMemory(true),
    events,
    { create: () => Promise.resolve(model) },
    new FakeInstaller(),
  );
  await memory.initialize(() => Promise.resolve(true));
  model.fail = true;

  await memory.recordAssistant("This record cannot be embedded.");

  await assert.rejects(
    () => memory.initialize(() => Promise.resolve(true)),
    /must be cleared before another submission/,
  );
  assert.deepEqual(
    events.failedEvents.map((event) => event.phase),
    ["recording"],
  );
});

void test("rejects invalid semantic-memory thresholds", () => {
  assert.throws(
    () => configureSemanticMemory({ similarityThreshold: 1.1 }),
    /must be a finite number from 0 to 1/,
  );
  assert.deepEqual(configureSemanticMemory({ similarityThreshold: 0.4 }), {
    similarityThreshold: 0.4,
  });
});

void test("rejects an unverified model artifact without populating its cache", async (context) => {
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), "codesmith-memory-cache-"));
  context.after(async () => rm(cacheDirectory, { recursive: true, force: true }));
  const installer = new ReviewedModelInstaller(cacheDirectory, () =>
    Promise.resolve(new Response(new Uint8Array(683), { headers: { "content-length": "683" } })),
  );

  await assert.rejects(() => installer.install(() => Promise.resolve(true)), /SHA-256 check/);
  assert.deepEqual(await readdir(cacheDirectory), []);
});

void test("reclaims a stale embedding-model installation lock", async (context) => {
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), "codesmith-memory-cache-"));
  context.after(async () => rm(cacheDirectory, { recursive: true, force: true }));
  const lockPath = path.join(cacheDirectory, `${reviewedEmbeddingModel.revision}.lock`);
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(lockPath, "interrupted installation");
  const staleDate = new Date(Date.now() - 11 * 60_000);
  await utimes(lockPath, staleDate, staleDate);
  const installer = new ReviewedModelInstaller(cacheDirectory, () =>
    Promise.resolve(new Response(new Uint8Array(683), { headers: { "content-length": "683" } })),
  );

  await assert.rejects(() => installer.install(() => Promise.resolve(true)), /SHA-256 check/);
  assert.deepEqual(await readdir(cacheDirectory), []);
});

void test("removes interrupted staging directories before installation", async (context) => {
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), "codesmith-memory-cache-"));
  context.after(async () => rm(cacheDirectory, { recursive: true, force: true }));
  const stagingDirectory = path.join(
    cacheDirectory,
    `${reviewedEmbeddingModel.revision}.tmp-interrupted`,
  );
  await mkdir(stagingDirectory, { recursive: true });
  await writeFile(path.join(stagingDirectory, "partial"), "partial artifact");
  const installer = new ReviewedModelInstaller(cacheDirectory, () =>
    Promise.resolve(new Response(new Uint8Array(683), { headers: { "content-length": "683" } })),
  );

  await assert.rejects(() => installer.install(() => Promise.resolve(true)), /SHA-256 check/);
  assert.deepEqual(await readdir(cacheDirectory), []);
});

void test("times out a stalled embedding-model download and releases its installation lock", async (context) => {
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), "codesmith-memory-cache-"));
  context.after(async () => rm(cacheDirectory, { recursive: true, force: true }));
  const installer = new ReviewedModelInstaller(
    cacheDirectory,
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    1,
  );

  await assert.rejects(() => installer.install(() => Promise.resolve(true)), /timed out/);
  assert.deepEqual(await readdir(cacheDirectory), []);
});

void test("does not retain an episode when memory is disposed while embedding", async () => {
  const events = new EventSink();
  const pending = new DeferredEmbeddingModel();
  const memory = new EpisodicMemory(
    configureSemanticMemory(true),
    events,
    { create: () => Promise.resolve(pending) },
    new FakeInstaller(),
  );
  await memory.initialize(() => Promise.resolve(true));

  const recording = memory.recordAssistant("Delayed episode");
  memory.dispose();
  pending.resolve([1, 0]);
  await recording;

  assert.equal(events.recordedEvents.length, 0);
});

class FakeInstaller implements EmbeddingModelInstaller {
  async install(approval: (summary: string) => Promise<boolean>): Promise<string> {
    if (!(await approval("Download local semantic-memory model?"))) throw new Error("declined");
    return "/fake-model";
  }
}

class FakeFactory implements EmbeddingModelFactory {
  create(): Promise<EmbeddingModel> {
    return Promise.resolve(new FakeEmbeddingModel());
  }
}

class FakeEmbeddingModel implements EmbeddingModel {
  fail = false;

  embed(text: string): Promise<number[]> {
    if (this.fail) return Promise.reject(new Error("embedding failed"));
    return Promise.resolve(text.includes("needle") || text.includes("README") ? [1, 0] : [0, 1]);
  }
}

class DeferredEmbeddingModel implements EmbeddingModel {
  private resolveEmbedding: ((embedding: number[]) => void) | undefined;

  embed(): Promise<number[]> {
    return new Promise((resolve) => {
      this.resolveEmbedding = resolve;
    });
  }

  resolve(embedding: number[]): void {
    this.resolveEmbedding?.(embedding);
  }
}

class EventSink implements MemoryEventSink {
  readonly recordedEvents: Array<{ id: string; kind: "tool" | "assistant" }> = [];
  readonly retrievedEvents: Array<
    ReadonlyArray<{ id: string; kind: "tool" | "assistant"; score: number }>
  > = [];
  readonly clearedEvents: number[] = [];
  readonly failedEvents: Array<{
    phase: "initialization" | "retrieval" | "recording";
    message: string;
  }> = [];

  recorded(episode: { id: string; kind: "tool" | "assistant" }): void {
    this.recordedEvents.push(episode);
  }

  retrieved(
    episodes: ReadonlyArray<{ id: string; kind: "tool" | "assistant"; score: number }>,
  ): void {
    this.retrievedEvents.push(episodes);
  }

  cleared(count: number): void {
    this.clearedEvents.push(count);
  }

  failed(phase: "initialization" | "retrieval" | "recording", message: string): void {
    this.failedEvents.push({ phase, message });
  }
}
