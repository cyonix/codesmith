import { randomUUID } from "node:crypto";
import { AgentLoop } from "./agent-loop.js";
import type { AgentEvent, AgentEventListener } from "./agent-events.js";
import { CodeSmithError } from "./errors.js";
import { ToolExecutor, type ApprovalRequest } from "./tools.js";
import type { ChatProvider } from "./types.js";

export interface AgentSessionOptions {
  projectRoot: string;
  provider: ChatProvider;
  autoApprove?: boolean;
  maximumToolRounds?: number;
}

interface PendingApproval {
  resolve: (approved: boolean) => void;
}

export class AgentSession {
  private readonly listeners = new Set<AgentEventListener>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly loop: AgentLoop;
  private active = false;
  private closed = false;

  private constructor(provider: ChatProvider, tools: ToolExecutor, maximumToolRounds?: number) {
    this.loop = new AgentLoop(provider, tools, maximumToolRounds, (event) => this.emit(event), () => this.closed);
  }

  static async create(options: AgentSessionOptions): Promise<AgentSession> {
    let session: AgentSession | undefined;
    const tools = await ToolExecutor.create(
      options.projectRoot,
      options.autoApprove,
      async (request) => session!.requestApproval(request),
      () => session!.closed,
    );
    session = new AgentSession(options.provider, tools, options.maximumToolRounds);
    return session;
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async submit(prompt: string): Promise<string> {
    if (this.closed) throw new CodeSmithError("loop", "This agent session is closed.");
    if (this.active) throw new CodeSmithError("loop", "This agent session is already processing a prompt.");
    this.active = true;
    try {
      return await this.loop.run(prompt);
    } catch (error) {
      this.emit({ type: "error", message: error instanceof Error ? error.message : "Agent session failed." });
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
    for (const pending of this.pendingApprovals.values()) pending.resolve(false);
    this.pendingApprovals.clear();
    this.listeners.clear();
  }

  private requestApproval(request: ApprovalRequest): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    const requestId = randomUUID();
    return new Promise((resolve) => {
      this.pendingApprovals.set(requestId, { resolve });
      this.emit({ type: "status", phase: "waiting_for_approval" });
      this.emit({ type: "approval_requested", requestId, kind: request.kind, summary: request.summary });
    });
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
