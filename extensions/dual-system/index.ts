import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { createDualSystemTool } from "./src/dual-system-tool.js";
import { DualSystemOrchestrator } from "./src/orchestrator.js";

export { DualSystemOrchestrator, type AlterEgoAction } from "./src/orchestrator.js";
export { ShortTermMemory } from "./src/short-term-memory.js";
export { DecisionClassifier, type DecisionType, type System2Context } from "./src/decision-classifier.js";
export { TaskDispatcher, type TaskEvent, type TaskState } from "./src/task-dispatcher.js";
export { System2Prompt } from "./src/system2-prompt.js";
export {
  type PersonalityConfig,
  type ToolCapability,
  DEFAULT_PERSONALITY,
  SYSTEM2_CAPABILITIES,
  buildSystem1IdentityPrompt,
  buildCapabilitiesSummary,
  buildCapabilitiesDetailedPrompt,
  isCapabilitiesQuery,
  generateCapabilitiesResponse,
} from "./src/shared-personality.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool(createDualSystemTool(api), { optional: true });
}
