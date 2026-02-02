/**
 * Dual-System Tool for OpenClaw
 *
 * This tool provides a unified interface to the dual-system architecture,
 * allowing it to be invoked from OpenClaw sessions or external systems.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { DualSystemOrchestrator, type System1Config } from "./orchestrator.js";
import { System2Prompt, buildSystem2Prompt } from "./system2-prompt.js";
import { buildTaskDispatchJson, parseTaskEventJson, type TaskEvent } from "./task-dispatcher.js";

type PluginConfig = {
  /** Max items in System 1 short-term memory */
  memoryMaxSize?: number;
  /** Default TTL for memory items (ms) */
  memoryDefaultTtl?: number;
  /** Complexity threshold for delegation (0-1) */
  complexityThreshold?: number;
  /** Provider for System 1 (phi-mini) */
  system1Provider?: string;
  /** Model for System 1 (phi-mini) */
  system1Model?: string;
  /** Enable LLM-based classification */
  useLlmClassification?: boolean;
};

// Global orchestrator instance (singleton per process)
let orchestratorInstance: DualSystemOrchestrator | null = null;

function getOrchestrator(api: OpenClawPluginApi): DualSystemOrchestrator {
  if (orchestratorInstance) {
    return orchestratorInstance;
  }

  const pluginCfg = (api.pluginConfig ?? {}) as PluginConfig;

  const config: System1Config = {
    memoryMaxSize: pluginCfg.memoryMaxSize ?? 20,
    memoryDefaultTtl: pluginCfg.memoryDefaultTtl ?? 5 * 60 * 1000,
    complexityThreshold: pluginCfg.complexityThreshold ?? 0.4,
    useLlmClassification: pluginCfg.useLlmClassification ?? false,
    // Note: llmInvoke and system2Invoke are set up when the tool is used
  };

  orchestratorInstance = new DualSystemOrchestrator(config);
  return orchestratorInstance;
}

export function createDualSystemTool(api: OpenClawPluginApi) {
  return {
    name: "dual-system",
    description: `Dual-system agent architecture interface.
Actions:
- process: Process user input through System 1 (classify, respond, delegate)
- status: Get current system state (active tasks, memory)
- provide-input: Provide user input to a waiting task
- build-system2-prompt: Generate System 2 prompt for OpenClaw
- emit-event: Emit a System 2 event (for testing/integration)
- reset: Reset the orchestrator state`,
    parameters: Type.Object({
      action: Type.String({
        description:
          "Action to perform: process | status | provide-input | build-system2-prompt | emit-event | reset",
      }),
      input: Type.Optional(
        Type.String({ description: "User input for 'process' or 'provide-input' action" }),
      ),
      taskId: Type.Optional(
        Type.String({ description: "Task ID for 'provide-input' or 'emit-event'" }),
      ),
      intent: Type.Optional(
        Type.String({ description: "Task intent for 'build-system2-prompt'" }),
      ),
      constraints: Type.Optional(
        Type.Unknown({ description: "Task constraints for 'build-system2-prompt'" }),
      ),
      context: Type.Optional(
        Type.Unknown({ description: "Task context for 'build-system2-prompt'" }),
      ),
      priority: Type.Optional(
        Type.String({ description: "Task priority: low | normal | high" }),
      ),
      state: Type.Optional(
        Type.String({
          description: "Event state for 'emit-event': STARTED | PROGRESS | WAITING | DONE | FAILED",
        }),
      ),
      message: Type.Optional(
        Type.String({ description: "Event message for 'emit-event'" }),
      ),
      requiresUserInput: Type.Optional(
        Type.Boolean({ description: "Whether event requires user input" }),
      ),
      result: Type.Optional(
        Type.Unknown({ description: "Result for DONE events" }),
      ),
      error: Type.Optional(
        Type.String({ description: "Error for FAILED events" }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>) {
      const action = String(params.action ?? "").trim();

      if (!action) {
        throw new Error("action is required");
      }

      const orchestrator = getOrchestrator(api);

      switch (action) {
        case "process": {
          const input = String(params.input ?? "").trim();
          if (!input) {
            throw new Error("input is required for 'process' action");
          }

          const result = await orchestrator.processInput(input);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    immediateResponse: result.immediateResponse,
                    delegated: result.delegated,
                    taskId: result.taskId,
                    decision: result.classification.decision,
                    confidence: result.classification.confidence,
                    reasoning: result.classification.reasoning,
                  },
                  null,
                  2,
                ),
              },
            ],
            details: result,
          };
        }

        case "status": {
          const activeTasks = orchestrator.getActiveTasks();
          const waitingTasks = orchestrator.getWaitingTasks();
          const memory = orchestrator.getMemorySnapshot();

          const status = {
            activeTasks: activeTasks.map((t) => ({
              taskId: t.dispatch.task_id,
              intent: t.dispatch.intent,
              state: t.currentState,
              lastUpdate: t.lastUpdate,
              eventCount: t.events.length,
            })),
            waitingTasks: waitingTasks.map((t) => ({
              taskId: t.dispatch.task_id,
              intent: t.dispatch.intent,
              question: t.events.at(-1)?.message,
            })),
            memorySize: memory.length,
            recentMemory: memory.slice(0, 5).map((m) => ({
              category: m.category,
              content: m.content.slice(0, 100),
              priority: m.priority,
            })),
          };

          return {
            content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
            details: status,
          };
        }

        case "provide-input": {
          const taskId = String(params.taskId ?? "").trim();
          const input = String(params.input ?? "").trim();

          if (!taskId || !input) {
            throw new Error("taskId and input are required for 'provide-input' action");
          }

          await orchestrator.provideInput(taskId, input);

          return {
            content: [{ type: "text", text: `Input provided to task ${taskId}` }],
            details: { taskId, input },
          };
        }

        case "build-system2-prompt": {
          const taskId =
            String(params.taskId ?? "").trim() ||
            `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const intent = String(params.intent ?? "").trim();

          if (!intent) {
            throw new Error("intent is required for 'build-system2-prompt' action");
          }

          const prompt = buildSystem2Prompt({
            taskId,
            intent,
            constraints: (params.constraints as Record<string, unknown>) ?? undefined,
            context: (params.context as Record<string, unknown>) ?? undefined,
            priority: (params.priority as "low" | "normal" | "high") ?? undefined,
          });

          return {
            content: [{ type: "text", text: prompt }],
            details: { taskId, intent },
          };
        }

        case "emit-event": {
          const taskId = String(params.taskId ?? "").trim();
          const state = String(params.state ?? "").trim();
          const message = String(params.message ?? "").trim();

          if (!taskId || !state || !message) {
            throw new Error("taskId, state, and message are required for 'emit-event' action");
          }

          const validStates = ["STARTED", "PROGRESS", "WAITING", "DONE", "FAILED"];
          if (!validStates.includes(state)) {
            throw new Error(`Invalid state: ${state}. Must be one of: ${validStates.join(", ")}`);
          }

          const dispatcher = orchestrator.getDispatcher();
          dispatcher.emit({
            task_id: taskId,
            state: state as TaskEvent["state"],
            message,
            requires_user_input: Boolean(params.requiresUserInput),
            result: params.result,
            error: typeof params.error === "string" ? params.error : undefined,
          });

          return {
            content: [{ type: "text", text: `Event emitted for task ${taskId}: ${state}` }],
            details: { taskId, state, message },
          };
        }

        case "reset": {
          orchestrator.reset();
          return {
            content: [{ type: "text", text: "Orchestrator reset complete" }],
            details: { reset: true },
          };
        }

        default:
          throw new Error(
            `Unknown action: ${action}. Valid actions: process, status, provide-input, build-system2-prompt, emit-event, reset`,
          );
      }
    },
  };
}
