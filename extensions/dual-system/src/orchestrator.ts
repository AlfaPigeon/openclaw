/**
 * Dual-System Orchestrator - System 1 Core Logic
 *
 * This is the main entry point for the dual-system architecture.
 * System 1 (phi-mini) handles:
 * - Immediate user response (low latency)
 * - Decision classification
 * - Task delegation to System 2
 * - State observation and proactive messaging
 *
 * System 1 CANNOT:
 * - Execute tools
 * - Write long-term memory
 * - Mutate external systems
 *
 * System 1 CAN:
 * - Respond immediately to user
 * - Observe System 2 state
 * - Send instructions to System 2
 * - Maintain short-term memory
 */

import { DecisionClassifier, type ClassificationResult, type DecisionType } from "./decision-classifier.js";
import { ShortTermMemory, type MemoryItem } from "./short-term-memory.js";
import {
  TaskDispatcher,
  type TaskDispatch,
  type TaskEvent,
  type TaskState,
  buildTaskDispatchJson,
} from "./task-dispatcher.js";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export type System1Response = {
  /** Immediate response to show user */
  immediateResponse: string | null;
  /** Whether a task was delegated to System 2 */
  delegated: boolean;
  /** Task ID if delegated */
  taskId?: string;
  /** Classification result */
  classification: ClassificationResult;
};

export type UserNotification = {
  type: "progress" | "waiting" | "done" | "failed";
  taskId: string;
  message: string;
  requiresInput: boolean;
};

export type System1Config = {
  /** Max items in short-term memory */
  memoryMaxSize?: number;
  /** Default TTL for memory items (ms) */
  memoryDefaultTtl?: number;
  /** Complexity threshold for delegation (0-1) */
  complexityThreshold?: number;
  /** Whether to use LLM for classification */
  useLlmClassification?: boolean;
  /** Callback to invoke phi-mini for responses */
  llmInvoke?: (prompt: string) => Promise<string>;
  /** Callback to invoke System 2 (OpenClaw) */
  system2Invoke?: (dispatch: TaskDispatch) => Promise<void>;
  /** Callback when user should be notified */
  onNotifyUser?: (notification: UserNotification) => void;
};

// ═══════════════════════════════════════════════════════════════════════════
// Orchestrator
// ═══════════════════════════════════════════════════════════════════════════

/**
 * DualSystemOrchestrator - The System 1 brain.
 *
 * Responsibilities:
 * 1. Immediately respond to every user input
 * 2. Decide whether to delegate to System 2
 * 3. Maintain short-term memory buffer
 * 4. Track System 2 execution state
 * 5. Push proactive messages to user on System 2 state changes
 */
export class DualSystemOrchestrator {
  private memory: ShortTermMemory;
  private classifier: DecisionClassifier;
  private dispatcher: TaskDispatcher;
  private config: System1Config;

  constructor(config: System1Config = {}) {
    this.config = config;

    // Initialize components
    this.memory = new ShortTermMemory({
      maxSize: config.memoryMaxSize ?? 20,
      defaultTtl: config.memoryDefaultTtl ?? 5 * 60 * 1000,
    });

    this.classifier = new DecisionClassifier({
      complexThreshold: config.complexityThreshold ?? 0.4,
    });

    this.dispatcher = new TaskDispatcher();

    // Set up event listener for System 2 state changes
    this.dispatcher.onEvent(this.handleSystem2Event.bind(this));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Main Entry Point
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Process user input through System 1.
   *
   * This is the main entry point. It:
   * 1. Classifies the input
   * 2. Generates immediate response if needed
   * 3. Delegates to System 2 if needed
   * 4. Updates short-term memory
   */
  async processInput(userInput: string): Promise<System1Response> {
    // Track user message in short-term memory
    this.memory.trackUserMessage(userInput);

    // Get recent context for classification
    const recentIntents = this.memory
      .getByCategory("intent")
      .map((m) => m.content);

    // Classify the input
    let classification: ClassificationResult;
    if (this.config.useLlmClassification && this.config.llmInvoke) {
      classification = await this.classifier.classifyWithLlm(
        userInput,
        this.config.llmInvoke,
      );
    } else {
      classification = this.classifier.classify(userInput, { recentIntents });
    }

    // Track the detected intent
    if (classification.taskIntent) {
      this.memory.trackIntent(classification.taskIntent, classification.confidence);
    }

    // Process based on decision type
    return this.executeDecision(userInput, classification);
  }

  /**
   * Execute the decision based on classification.
   */
  private async executeDecision(
    userInput: string,
    classification: ClassificationResult,
  ): Promise<System1Response> {
    const { decision } = classification;

    switch (decision) {
      case "RESPOND_ONLY":
        return this.handleRespondOnly(userInput, classification);

      case "DELEGATE_TO_SYSTEM_2":
        return this.handleDelegateOnly(userInput, classification);

      case "RESPOND_AND_DELEGATE":
        return this.handleRespondAndDelegate(userInput, classification);

      default:
        // Should never happen, but handle gracefully
        return this.handleRespondOnly(userInput, classification);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Decision Handlers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Handle RESPOND_ONLY: System 1 responds directly, no delegation.
   */
  private async handleRespondOnly(
    userInput: string,
    classification: ClassificationResult,
  ): Promise<System1Response> {
    let response = classification.suggestedResponse;

    // If no suggested response, generate one with phi-mini
    if (!response && this.config.llmInvoke) {
      response = await this.generateResponse(userInput);
    }

    return {
      immediateResponse: response || "I understand.",
      delegated: false,
      classification,
    };
  }

  /**
   * Handle DELEGATE_TO_SYSTEM_2: Delegate without immediate response.
   * Used for background tasks where user doesn't need acknowledgment.
   */
  private async handleDelegateOnly(
    userInput: string,
    classification: ClassificationResult,
  ): Promise<System1Response> {
    const taskId = await this.delegateToSystem2(userInput, classification);

    return {
      immediateResponse: null, // No immediate response
      delegated: true,
      taskId,
      classification,
    };
  }

  /**
   * Handle RESPOND_AND_DELEGATE: Acknowledge and delegate.
   * Most common path for complex requests.
   */
  private async handleRespondAndDelegate(
    userInput: string,
    classification: ClassificationResult,
  ): Promise<System1Response> {
    // Get acknowledgment
    let acknowledgment = classification.suggestedResponse;

    // If no suggested acknowledgment, generate one
    if (!acknowledgment && this.config.llmInvoke) {
      acknowledgment = await this.generateAcknowledgment(userInput);
    }

    // Delegate to System 2
    const taskId = await this.delegateToSystem2(userInput, classification);

    return {
      immediateResponse: acknowledgment || "Working on it...",
      delegated: true,
      taskId,
      classification,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // System 2 Integration
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Delegate a task to System 2.
   */
  private async delegateToSystem2(
    userInput: string,
    classification: ClassificationResult,
  ): Promise<string> {
    // Build context from short-term memory
    const contextItems = this.memory.getRecent(5);
    const context: Record<string, unknown> = {
      recentContext: contextItems.map((item) => ({
        content: item.content,
        category: item.category,
        timestamp: item.timestamp,
      })),
      memorySnapshot: this.memory.buildContextString(10),
    };

    // Dispatch the task
    const taskId = this.dispatcher.dispatch({
      intent: classification.taskIntent || userInput,
      constraints: classification.constraints ?? {},
      context,
      priority: this.inferPriority(classification),
    });

    // Track system state
    this.memory.trackSystemState(`Delegated task: ${taskId}`, taskId);

    // If we have a System 2 invoke function, call it ASYNC (non-blocking)
    // System 1 should return immediately while System 2 works in background
    if (this.config.system2Invoke) {
      const task = this.dispatcher.getTask(taskId);
      if (task) {
        // Fire and forget - don't await, let it run in background
        this.config.system2Invoke(task.dispatch).catch((err) => {
          // Task failed to start - emit failure event
          this.dispatcher.emitFailed(
            taskId,
            err instanceof Error ? err.message : "Unknown error",
          );
        });
      }
    }

    return taskId;
  }

  /**
   * Handle events from System 2.
   * This is where System 1 observes System 2 state changes.
   */
  private handleSystem2Event(event: TaskEvent): void {
    // Track state change in memory
    this.memory.trackSystemState(
      `Task ${event.task_id} → ${event.state}: ${event.message}`,
      event.task_id,
    );

    // Decide whether to notify user
    const notification = this.shouldNotifyUser(event);
    if (notification && this.config.onNotifyUser) {
      this.config.onNotifyUser(notification);
    }
  }

  /**
   * Determine if user should be notified of this event.
   */
  private shouldNotifyUser(event: TaskEvent): UserNotification | null {
    switch (event.state) {
      case "STARTED":
        // Usually don't notify on start (already acknowledged)
        return null;

      case "PROGRESS":
        // Only notify on significant progress
        // Could be enhanced with more sophisticated logic
        return null;

      case "WAITING":
        // Always notify if waiting for user input
        if (event.requires_user_input) {
          return {
            type: "waiting",
            taskId: event.task_id,
            message: event.message,
            requiresInput: true,
          };
        }
        return null;

      case "DONE":
        return {
          type: "done",
          taskId: event.task_id,
          message: event.message,
          requiresInput: false,
        };

      case "FAILED":
        return {
          type: "failed",
          taskId: event.task_id,
          message: event.message,
          requiresInput: false,
        };

      default:
        return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LLM Integration (phi-mini)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Generate a simple response using phi-mini.
   */
  private async generateResponse(userInput: string): Promise<string> {
    if (!this.config.llmInvoke) {
      return "I understand.";
    }

    const context = this.memory.buildContextString(5);
    const prompt = `You are a helpful assistant. Respond briefly and naturally.

${context ? `Recent context:\n${context}\n\n` : ""}User: ${userInput}

Respond in 1-2 sentences:`;

    try {
      const response = await this.config.llmInvoke(prompt);
      return response.trim() || "I understand.";
    } catch {
      return "I understand.";
    }
  }

  /**
   * Generate an acknowledgment for a complex task.
   */
  private async generateAcknowledgment(userInput: string): Promise<string> {
    if (!this.config.llmInvoke) {
      return "Got it, working on that now...";
    }

    const prompt = `The user has requested a complex task. Generate a brief, friendly acknowledgment.

User request: ${userInput}

Acknowledgment (1 sentence, confirm you understood and are working on it):`;

    try {
      const response = await this.config.llmInvoke(prompt);
      return response.trim() || "Got it, working on that now...";
    } catch {
      return "Got it, working on that now...";
    }
  }

  /**
   * Infer priority from classification.
   */
  private inferPriority(classification: ClassificationResult): "low" | "normal" | "high" {
    const { confidence, constraints } = classification;

    // Check if user explicitly requested background processing
    if (constraints?.background) {
      return "low";
    }

    // High confidence = higher priority
    if (confidence > 0.8) {
      return "high";
    }

    return "normal";
  }

  // ─────────────────────────────────────────────────────────────────────────
  // State Access (for observation)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get all active tasks.
   */
  getActiveTasks() {
    return this.dispatcher.getActiveTasks();
  }

  /**
   * Get tasks waiting for user input.
   */
  getWaitingTasks() {
    return this.dispatcher.getWaitingTasks();
  }

  /**
   * Get short-term memory state.
   */
  getMemorySnapshot() {
    return this.memory.getAll();
  }

  /**
   * Get the dispatcher for direct event handling.
   */
  getDispatcher(): TaskDispatcher {
    return this.dispatcher;
  }

  /**
   * Provide user input to a waiting task.
   * This routes the input to System 2 as additional context.
   */
  async provideInput(taskId: string, input: string): Promise<void> {
    const task = this.dispatcher.getTask(taskId);
    if (!task || task.currentState !== "WAITING") {
      throw new Error(`Task ${taskId} is not waiting for input`);
    }

    // Track the input
    this.memory.trackUserMessage(input, { forTask: taskId });

    // Create a follow-up dispatch with the input
    // In practice, this would route to the existing System 2 session
    if (this.config.system2Invoke) {
      await this.config.system2Invoke({
        ...task.dispatch,
        task_id: taskId, // Keep same task ID
        context: {
          ...task.dispatch.context,
          userFollowUp: input,
          isFollowUp: true,
        },
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Reset the orchestrator (clear memory and tasks).
   */
  reset(): void {
    this.memory.clear();
    this.dispatcher.reset();
  }

  /**
   * Cleanup old completed tasks.
   */
  cleanup(maxAge?: number): void {
    this.dispatcher.cleanup(maxAge);
  }
}
