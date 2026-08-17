import { randomUUID } from "node:crypto";
import {
  EpisodicMemory,
  configureSemanticMemory,
  type MemoryEventSink,
  type SemanticMemoryConfiguration,
  type SemanticMemoryOption,
} from "./episodic-memory.js";
import { AgentLoop } from "./loop.js";
import type { AgentEvent, AgentEventListener } from "./events.js";
import { CodeSmithError } from "../shared/errors.js";
import { ToolExecutor, type ApprovalRequest } from "../workspace/tools.js";
import type { ChatProvider } from "../shared/types.js";

export interface AgentSessionOptions {
  projectRoot: string;
  provider: ChatProvider;
  autoApprove?: boolean;
  maximumToolRounds?: number;
  semanticMemory?: SemanticMemoryOption;
}

export interface AgentSessionDependencies {
  createMemory?: (
    configuration: SemanticMemoryConfiguration,
    eventSink: MemoryEventSink,
  ) => EpisodicMemory;
}

interface PendingApproval {
  resolve: (approved: boolean) => void;
}

export class AgentSession {
  private readonly listeners = new Set<AgentEventListener>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly loop: AgentLoop;
  private readonly memory: EpisodicMemory | undefined;
  private active = false;
  private closed = false;

  private constructor(
    provider: ChatProvider,
    tools: ToolExecutor,
    maximumToolRounds?: number,
    semanticMemory?: SemanticMemoryOption,
    createMemory: (
      configuration: SemanticMemoryConfiguration,
      eventSink: MemoryEventSink,
    ) => EpisodicMemory = (configuration, eventSink) =>
      new EpisodicMemory(configuration, eventSink),
  ) {
    this.memory = semanticMemory
      ? createMemory(configureSemanticMemory(semanticMemory), {
          recorded: (episode) =>
            this.emit({
              type: "memory_recorded",
              episodeId: episode.id,
              kind: episode.kind,
            }),
          retrieved: (episodes) => this.emit({ type: "memory_retrieved", episodes }),
          cleared: (count) => this.emit({ type: "memory_cleared", count }),
          failed: (phase, message) =>
            this.emit({
              type: "memory_failed",
              phase,
              message,
              blocksFutureSubmissions: phase !== "initialization",
            }),
        })
      : undefined;
    this.loop = new AgentLoop(
      provider,
      tools,
      maximumToolRounds,
      (event) => this.emit(event),
      () => this.closed,
      this.memory,
    );
  }

  static async create(
    options: AgentSessionOptions,
    dependencies: AgentSessionDependencies = {},
  ): Promise<AgentSession> {
    const sessionReference: { current?: AgentSession } = {};

    const tools = await ToolExecutor.create(
      options.projectRoot,
      options.autoApprove,
      (request) => sessionReference.current!.requestApproval(request),
      () => sessionReference.current!.closed,
    );

    const session = new AgentSession(
      options.provider,
      tools,
      options.maximumToolRounds,
      options.semanticMemory,
      dependencies.createMemory,
    );
    sessionReference.current = session;
    return session;
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async submit(prompt: string): Promise<string> {
    if (this.closed) throw new CodeSmithError("loop", "This agent session is closed.");
    if (this.active)
      throw new CodeSmithError("loop", "This agent session is already processing a prompt.");

    this.active = true;

    try {
      await this.memory?.initialize((summary) =>
        this.requestApproval({ kind: "model_download", summary }),
      );
      return await this.loop.run(prompt);
    } catch (error) {
      this.emit({
        type: "error",
        message: error instanceof Error ? error.message : "Agent session failed.",
      });
      throw error;
    } finally {
      this.active = false;
    }
  }

  approve(requestId: string, approved: boolean): boolean {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return false;

    this.pendingApprovals.delete(requestId);
    pending.resolve(approved);
    return true;
  }

  close(): void {
    if (this.closed) return;

    this.closed = true;
    this.memory?.dispose();

    for (const pending of this.pendingApprovals.values()) pending.resolve(false);

    this.pendingApprovals.clear();
    this.listeners.clear();
  }

  clearEpisodicMemory(): void {
    if (this.active)
      throw new CodeSmithError(
        "loop",
        "Episodic memory cannot be cleared while the agent is processing a prompt.",
      );
    this.memory?.clear();
  }

  private requestApproval(request: ApprovalRequest): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);

    const requestId = randomUUID();

    return new Promise((resolve) => {
      this.pendingApprovals.set(requestId, { resolve });
      this.emit({ type: "status", phase: "waiting_for_approval" });
      this.emit({
        type: "approval_requested",
        requestId,
        kind: request.kind,
        summary: request.summary,
      });
    });
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
