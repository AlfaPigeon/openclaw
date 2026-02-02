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
import {
  type PersonalityConfig,
  DEFAULT_PERSONALITY,
  buildSystem1IdentityPrompt,
  isCapabilitiesQuery,
  generateCapabilitiesResponse,
} from "./shared-personality.js";

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
  /** Raw message from System 2 (internal) */
  rawMessage: string;
  /** User-facing message formulated by System 1 */
  userMessage: string;
  requiresInput: boolean;
  /** Full result data from System 2 */
  result?: unknown;
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
  /** Personality configuration (shared with System 2) */
  personality?: PersonalityConfig;
  /** Enable alter ego mode - System 1 can autonomously chain commands */
  enableAlterEgo?: boolean;
  /** Max consecutive alter ego commands (default: 3) */
  maxAlterEgoChain?: number;
  /** Callback when alter ego decides to chain a command */
  onAlterEgoAction?: (action: AlterEgoAction) => void;
};

/**
 * Alter Ego action - when System 1 autonomously chains a command.
 */
export type AlterEgoAction = {
  /** Original user intent */
  originalIntent: string;
  /** System 2's last response that triggered this */
  system2Response: string;
  /** The follow-up command System 1 is sending */
  followUpCommand: string;
  /** Reasoning for this action */
  reasoning: string;
  /** Chain depth (1 = first alter ego action) */
  chainDepth: number;
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
 * 6. (Alter Ego) Autonomously chain commands to System 2 when appropriate
 */
export class DualSystemOrchestrator {
  private memory: ShortTermMemory;
  private classifier: DecisionClassifier;
  private dispatcher: TaskDispatcher;
  private config: System1Config;
  
  /** Alter Ego state tracking */
  private alterEgoState: {
    /** Current chain depth for active task */
    chainDepth: Map<string, number>;
    /** Original user intent per task */
    originalIntent: Map<string, string>;
    /** Whether alter ego is currently processing */
    isProcessing: Set<string>;
  };

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
    
    // Initialize alter ego state
    this.alterEgoState = {
      chainDepth: new Map(),
      originalIntent: new Map(),
      isProcessing: new Set(),
    };

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

    // Check for capabilities query first - System 1 can answer this directly
    if (isCapabilitiesQuery(userInput)) {
      const capabilitiesResponse = generateCapabilitiesResponse(
        this.config.personality || DEFAULT_PERSONALITY
      );
      return {
        immediateResponse: capabilitiesResponse,
        delegated: false,
        classification: {
          decision: "RESPOND_ONLY",
          confidence: 1.0,
          reasoning: "Capabilities query - System 1 knows System 2's skills",
          suggestedResponse: capabilitiesResponse,
        },
      };
    }

    // Get recent context for classification including System 2's last response
    const recentIntents = this.memory
      .getByCategory("intent")
      .map((m) => m.content);
    
    const lastSystem2Response = this.memory.getLastSystem2Response();
    const system2Context = lastSystem2Response
      ? {
          lastTaskState: lastSystem2Response.metadata?.state as string | undefined,
          lastTaskResult: lastSystem2Response.metadata?.result,
          lastTaskMessage: lastSystem2Response.content,
        }
      : undefined;

    // Classify the input with System 2 context awareness
    let classification: ClassificationResult;
    if (this.config.useLlmClassification && this.config.llmInvoke) {
      classification = await this.classifier.classifyWithLlm(
        userInput,
        this.config.llmInvoke,
        system2Context,
      );
    } else {
      classification = this.classifier.classify(userInput, { 
        recentIntents,
        system2Context,
      });
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
    isAlterEgo = false,
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

    // Track original user intent for alter ego chaining
    if (!isAlterEgo) {
      this.alterEgoState.originalIntent.set(taskId, userInput);
      this.alterEgoState.chainDepth.set(taskId, 0);
    }

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
   * This is where System 1 observes System 2 state changes and formulates user responses.
   */
  private handleSystem2Event(event: TaskEvent): void {
    // Track System 2's response in memory for context awareness
    this.memory.trackSystem2Response({
      taskId: event.task_id,
      state: event.state,
      message: event.message,
      result: event.result,
      error: event.error,
    });

    // Also track as system state for backward compatibility
    this.memory.trackSystemState(
      `Task ${event.task_id} → ${event.state}: ${event.message}`,
      event.task_id,
    );

    // Check if alter ego should take action (for DONE or PROGRESS states, not WAITING/FAILED)
    if (this.config.enableAlterEgo && (event.state === "DONE" || event.state === "PROGRESS")) {
      this.evaluateAlterEgoAction(event).catch((err) => {
        console.error("Alter ego evaluation error:", err);
      });
    } else {
      // Formulate user-facing notification through System 1
      this.formulateAndNotifyUser(event);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Alter Ego - Autonomous Command Chaining
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Evaluate if System 1 (alter ego) should autonomously chain another command.
   * This is called after System 2 completes a task successfully.
   */
  private async evaluateAlterEgoAction(event: TaskEvent): Promise<void> {
    const taskId = event.task_id;
    const maxChain = this.config.maxAlterEgoChain ?? 3;
    const currentDepth = this.alterEgoState.chainDepth.get(taskId) ?? 0;

    // Don't chain if we've reached max depth
    if (currentDepth >= maxChain) {
      // Just notify user of the final result
      this.formulateAndNotifyUser(event);
      this.cleanupAlterEgoState(taskId);
      return;
    }

    // Don't chain if already processing
    if (this.alterEgoState.isProcessing.has(taskId)) {
      return;
    }

    // Get original user intent
    const originalIntent = this.alterEgoState.originalIntent.get(taskId);
    if (!originalIntent) {
      this.formulateAndNotifyUser(event);
      return;
    }

    // Mark as processing to prevent re-entry
    this.alterEgoState.isProcessing.add(taskId);

    try {
      // Ask System 1's LLM if we should chain
      const decision = await this.decideAlterEgoAction(originalIntent, event);

      if (decision.shouldChain && decision.followUpCommand) {
        // Notify about alter ego action
        const action: AlterEgoAction = {
          originalIntent,
          system2Response: event.message,
          followUpCommand: decision.followUpCommand,
          reasoning: decision.reasoning,
          chainDepth: currentDepth + 1,
        };

        if (this.config.onAlterEgoAction) {
          this.config.onAlterEgoAction(action);
        }

        // Delegate follow-up command to System 2
        const newTaskId = await this.delegateAlterEgoCommand(
          decision.followUpCommand,
          originalIntent,
          taskId,
          currentDepth + 1,
        );

        // Transfer alter ego state to new task
        this.alterEgoState.originalIntent.set(newTaskId, originalIntent);
        this.alterEgoState.chainDepth.set(newTaskId, currentDepth + 1);
      } else {
        // No more chaining needed, notify user of result
        this.formulateAndNotifyUser(event);
        this.cleanupAlterEgoState(taskId);
      }
    } finally {
      this.alterEgoState.isProcessing.delete(taskId);
    }
  }

  /**
   * Decide if alter ego should chain another command.
   */
  private async decideAlterEgoAction(
    originalIntent: string,
    event: TaskEvent,
  ): Promise<{ shouldChain: boolean; followUpCommand?: string; reasoning: string }> {
    if (!this.config.llmInvoke) {
      return { shouldChain: false, reasoning: "No LLM available for alter ego decisions" };
    }

    const personality = this.config.personality || DEFAULT_PERSONALITY;
    
    // Build result context
    let resultInfo = `State: ${event.state}\nMessage: ${event.message}`;
    if (event.result) {
      const resultStr = typeof event.result === "string"
        ? event.result
        : JSON.stringify(event.result, null, 2);
      resultInfo += `\nResult data:\n${resultStr.slice(0, 1500)}`;
    }

    const prompt = `You are ${personality.name}'s decision-making core (alter ego).
You've just received results from executing a task. Your job is to decide if MORE WORK IS NEEDED to fully satisfy the user's original request.

ORIGINAL USER REQUEST: "${originalIntent}"

SYSTEM 2 (backend) RESPONSE:
${resultInfo}

DECISION CRITERIA:
- If the task is COMPLETE and fully addresses the user's request → NO follow-up needed
- If the result reveals MORE WORK is required to fulfill the request → provide a follow-up command
- If there's an obvious NEXT STEP the user would want → provide it
- If the result is partial or needs refinement → chain another command
- Do NOT chain just to be thorough - only if genuinely needed

Examples of when to chain:
- User asked to "create and test a file" but only creation was done → chain the test
- User asked for "list and analyze files" but only listing was done → chain the analysis
- Result shows an error that can be fixed with another command → chain the fix

Examples of when NOT to chain:
- Task completed successfully and fully addresses the request
- User only asked for information and got it
- Result is a simple acknowledgment or confirmation

Respond with JSON only:
{"shouldChain": true/false, "followUpCommand": "command if chaining", "reasoning": "brief explanation"}`;

    try {
      const response = await this.config.llmInvoke(prompt);
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          shouldChain: parsed.shouldChain === true,
          followUpCommand: parsed.followUpCommand,
          reasoning: parsed.reasoning || "LLM decision",
        };
      }
    } catch {
      // Fallback: no chaining
    }

    return { shouldChain: false, reasoning: "Could not parse LLM response" };
  }

  /**
   * Delegate an alter ego follow-up command to System 2.
   */
  private async delegateAlterEgoCommand(
    command: string,
    originalIntent: string,
    parentTaskId: string,
    chainDepth: number,
  ): Promise<string> {
    // Build classification for the follow-up
    const classification: ClassificationResult = {
      decision: "DELEGATE_TO_SYSTEM_2",
      confidence: 0.9,
      reasoning: `Alter ego follow-up (depth ${chainDepth}) for: ${originalIntent}`,
      taskIntent: command,
      constraints: {
        isAlterEgo: true,
        parentTaskId,
        chainDepth,
        originalIntent,
      },
    };

    return this.delegateToSystem2(command, classification, true);
  }

  /**
   * Clean up alter ego state for a task.
   */
  private cleanupAlterEgoState(taskId: string): void {
    this.alterEgoState.chainDepth.delete(taskId);
    this.alterEgoState.originalIntent.delete(taskId);
    this.alterEgoState.isProcessing.delete(taskId);
  }

  /**
   * Formulate a user-facing response from System 2's output.
   * System 1 acts as the user-facing layer.
   */
  private async formulateAndNotifyUser(event: TaskEvent): Promise<void> {
    const notification = await this.buildUserNotification(event);
    if (notification && this.config.onNotifyUser) {
      this.config.onNotifyUser(notification);
    }
  }

  /**
   * Build a user notification from System 2's event.
   * System 1 formulates the user-facing message.
   */
  private async buildUserNotification(event: TaskEvent): Promise<UserNotification | null> {
    switch (event.state) {
      case "STARTED":
        // Usually don't notify on start (already acknowledged)
        return null;

      case "PROGRESS":
        // Only notify on significant progress (can be enhanced)
        return null;

      case "WAITING":
        if (event.requires_user_input) {
          const userMessage = await this.formulateUserMessage(event, "question");
          return {
            type: "waiting",
            taskId: event.task_id,
            rawMessage: event.message,
            userMessage,
            requiresInput: true,
          };
        }
        return null;

      case "DONE": {
        const userMessage = await this.formulateUserMessage(event, "success");
        return {
          type: "done",
          taskId: event.task_id,
          rawMessage: event.message,
          userMessage,
          requiresInput: false,
          result: event.result,
        };
      }

      case "FAILED": {
        const userMessage = await this.formulateUserMessage(event, "error");
        return {
          type: "failed",
          taskId: event.task_id,
          rawMessage: event.message,
          userMessage,
          requiresInput: false,
        };
      }

      default:
        return null;
    }
  }

  /**
   * Formulate a user-facing message from System 2's output.
   * Uses System 1's LLM to make the message user-friendly.
   */
  private async formulateUserMessage(
    event: TaskEvent,
    tone: "success" | "error" | "question"
  ): Promise<string> {
    // Get the original user request from memory
    const recentUserInput = this.memory.getByCategory("user_input")[0];
    const originalRequest = recentUserInput?.content || "the task";

    // If no LLM available, return a formatted version of System 2's message
    if (!this.config.llmInvoke) {
      return this.formatSystem2Output(event, tone);
    }

    const personality = this.config.personality || DEFAULT_PERSONALITY;
    
    // Build result context
    let resultContext = "";
    if (event.result) {
      const resultStr = typeof event.result === "string" 
        ? event.result 
        : JSON.stringify(event.result, null, 2);
      resultContext = `\n\nSystem 2 result data:\n${resultStr.slice(0, 2000)}`;
    }

    const prompt = `You are ${personality.name}, ${personality.tagline}.
You are System 1, the user-facing layer. You've just received results from System 2 (your agentic backend).
Your job is to communicate these results to the user in a friendly, helpful way.

User's original request: "${originalRequest}"

System 2's response:
- State: ${event.state}
- Message: ${event.message}
${event.error ? `- Error: ${event.error}` : ""}${resultContext}

Tone: ${tone === "success" ? "positive and helpful" : tone === "error" ? "apologetic but constructive" : "clear question"}

Respond to the user naturally. Be concise but complete. If there's useful data, present it clearly.
Do not mention "System 2" or internal systems - just communicate the result as if you did it yourself.

Your response to the user:`;

    try {
      const response = await this.config.llmInvoke(prompt);
      return response.trim() || this.formatSystem2Output(event, tone);
    } catch {
      return this.formatSystem2Output(event, tone);
    }
  }

  /**
   * Format System 2's output without LLM (fallback).
   */
  private formatSystem2Output(event: TaskEvent, tone: "success" | "error" | "question"): string {
    if (tone === "error") {
      return `I encountered an issue: ${event.message}${event.error ? ` (${event.error})` : ""}`;
    }
    
    if (tone === "question") {
      return event.message;
    }

    // Success - include result if available
    if (event.result) {
      const resultStr = typeof event.result === "string"
        ? event.result
        : JSON.stringify(event.result, null, 2);
      return `${event.message}\n\n${resultStr.slice(0, 1000)}`;
    }
    
    return event.message;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LLM Integration (phi-mini)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Generate a simple response using phi-mini with shared personality.
   */
  private async generateResponse(userInput: string): Promise<string> {
    if (!this.config.llmInvoke) {
      return "I understand.";
    }

    const personality = this.config.personality || DEFAULT_PERSONALITY;
    const identityPrompt = buildSystem1IdentityPrompt(personality);
    const context = this.memory.buildContextString(5);
    
    const prompt = `${identityPrompt}

---

${context ? `Recent context:\n${context}\n\n` : ""}User: ${userInput}

Respond briefly (1-2 sentences) in character:`;

    try {
      const response = await this.config.llmInvoke(prompt);
      return response.trim() || "I understand.";
    } catch {
      return "I understand.";
    }
  }

  /**
   * Generate an acknowledgment for a complex task with shared personality.
   */
  private async generateAcknowledgment(userInput: string): Promise<string> {
    if (!this.config.llmInvoke) {
      return "Got it, working on that now...";
    }

    const personality = this.config.personality || DEFAULT_PERSONALITY;

    const prompt = `You are ${personality.name}, ${personality.tagline}.
Generate a brief, friendly acknowledgment for this complex task request.

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
