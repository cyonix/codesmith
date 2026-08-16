export { AgentSession, type AgentSessionOptions } from "../agent/session.js";
export type { SemanticMemoryOption } from "../agent/episodic-memory.js";

export { ModelProvider, type ProviderConfiguration } from "../providers/provider.js";
export {
  modelCatalog,
  modelCatalogGroups,
  type ModelCatalogEntry,
  type ModelTier,
  type ProviderProtocol,
} from "../providers/model-catalog.js";

export {
  commandDescription,
  detectProjectProfile,
  validateCommand,
} from "../workspace/project-profile.js";
export type { ProjectCommand, ProjectKind, ProjectProfile } from "../workspace/project-profile.js";

export type { AgentEvent, AgentEventListener } from "../agent/events.js";
export type { ChatProvider, ToolCall } from "../shared/types.js";
