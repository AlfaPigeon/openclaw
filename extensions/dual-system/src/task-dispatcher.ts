/**
 * Task Dispatcher - System 1 ↔ System 2 Communication Interface
 *
 * Implements event-based async communication between System 1 and System 2.
 *
 * System 1 → System 2:
 * - Task dispatch with intent, constraints, context, priority
 *
 * System 2 → System 1:
 * - State updates (STARTED, PROGRESS, WAITING, DONE, FAILED)
 */

import { randomUUID } from "node:crypto";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export type TaskPriority = "low" | "normal" | "high";

export type TaskState = "STARTED" | "PROGRESS" | "WAITING" | "DONE" | "FAILED";

/**
 * Task dispatch from System 1 → System 2
 */
export type TaskDispatch = {
  task_id: string;
  intent: string;
  constraints: Record<string, unknown>;
  context: Record<string, unknown>;
  priority: TaskPriority;
  created_at: number;
};

/**
 * State update from System 2 → System 1
 */
export type TaskEvent = {
  task_id: string;
  state: TaskState;
  message: string;
  requires_user_input: boolean;
  result?: unknown;
  error?: string;
  recovery_steps?: string[];
  timestamp: number;
};

/**
 * Internal task tracking
 */
export type TrackedTask = {
  dispatch: TaskDispatch;
  events: TaskEvent[];
  currentState: TaskState | "PENDING";
  lastUpdate: number;
};

export type TaskEventHandler = (event: TaskEvent) => void;

// ═══════════════════════════════════════════════════════════════════════════
// Task Dispatcher
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Task Dispatcher manages communication between System 1 and System 2.
 *
 * System 1 uses this to:
 * - Dispatch tasks to System 2
 * - Listen for state updates
 * - Track task progress
 *
 * System 2 uses this to:
 * - Receive task dispatches
 * - Emit state updates
 */
export class TaskDispatcher {
  private tasks: Map<string, TrackedTask> = new Map();
  private eventHandlers: Set<TaskEventHandler> = new Set();
  private taskHandlers: Set<(dispatch: TaskDispatch) => void> = new Set();

  // ─────────────────────────────────────────────────────────────────────────
  // System 1 Methods (Dispatch & Listen)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Dispatch a task to System 2.
   * Returns the task_id for tracking.
   */
  dispatch(params: {
    intent: string;
    constraints?: Record<string, unknown>;
    context?: Record<string, unknown>;
    priority?: TaskPriority;
  }): string {
    const task_id = randomUUID();

    const dispatch: TaskDispatch = {
      task_id,
      intent: params.intent,
      constraints: params.constraints ?? {},
      context: params.context ?? {},
      priority: params.priority ?? "normal",
      created_at: Date.now(),
    };

    const tracked: TrackedTask = {
      dispatch,
      events: [],
      currentState: "PENDING",
      lastUpdate: Date.now(),
    };

    this.tasks.set(task_id, tracked);

    // Notify task handlers (System 2)
    for (const handler of this.taskHandlers) {
      try {
        handler(dispatch);
      } catch {
        // Don't let handler errors break dispatch
      }
    }

    return task_id;
  }

  /**
   * Subscribe to task events (for System 1 to observe System 2).
   * Returns unsubscribe function.
   */
  onEvent(handler: TaskEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /**
   * Subscribe to new task dispatches (for System 2 to receive tasks).
   * Returns unsubscribe function.
   */
  onTask(handler: (dispatch: TaskDispatch) => void): () => void {
    this.taskHandlers.add(handler);
    return () => this.taskHandlers.delete(handler);
  }

  /**
   * Get current state of a task.
   */
  getTask(task_id: string): TrackedTask | undefined {
    return this.tasks.get(task_id);
  }

  /**
   * Get all active (non-terminal) tasks.
   */
  getActiveTasks(): TrackedTask[] {
    return Array.from(this.tasks.values()).filter(
      (t) => !["DONE", "FAILED"].includes(t.currentState),
    );
  }

  /**
   * Get all tasks.
   */
  getAllTasks(): TrackedTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Check if any tasks are waiting for user input.
   */
  hasWaitingTasks(): boolean {
    return Array.from(this.tasks.values()).some(
      (t) => t.currentState === "WAITING" && t.events.at(-1)?.requires_user_input,
    );
  }

  /**
   * Get tasks waiting for user input.
   */
  getWaitingTasks(): TrackedTask[] {
    return Array.from(this.tasks.values()).filter(
      (t) => t.currentState === "WAITING" && t.events.at(-1)?.requires_user_input,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // System 2 Methods (Emit Events)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Emit a state update for a task.
   * Called by System 2 to report progress.
   */
  emit(params: {
    task_id: string;
    state: TaskState;
    message: string;
    requires_user_input?: boolean;
    result?: unknown;
    error?: string;
    recovery_steps?: string[];
  }): void {
    const task = this.tasks.get(params.task_id);
    if (!task) {
      console.warn(`TaskDispatcher: Unknown task_id ${params.task_id}`);
      return;
    }

    const event: TaskEvent = {
      task_id: params.task_id,
      state: params.state,
      message: params.message,
      requires_user_input: params.requires_user_input ?? false,
      result: params.result,
      error: params.error,
      recovery_steps: params.recovery_steps,
      timestamp: Date.now(),
    };

    task.events.push(event);
    task.currentState = params.state;
    task.lastUpdate = Date.now();

    // Notify all event handlers (System 1)
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // Don't let handler errors break event flow
      }
    }
  }

  /**
   * Helper: Emit STARTED state.
   */
  emitStarted(task_id: string, message = "Task started"): void {
    this.emit({ task_id, state: "STARTED", message });
  }

  /**
   * Helper: Emit PROGRESS state.
   */
  emitProgress(task_id: string, message: string): void {
    this.emit({ task_id, state: "PROGRESS", message });
  }

  /**
   * Helper: Emit WAITING state (needs user input).
   */
  emitWaiting(task_id: string, question: string): void {
    this.emit({
      task_id,
      state: "WAITING",
      message: question,
      requires_user_input: true,
    });
  }

  /**
   * Helper: Emit DONE state with result.
   */
  emitDone(task_id: string, message: string, result?: unknown): void {
    this.emit({ task_id, state: "DONE", message, result });
  }

  /**
   * Helper: Emit FAILED state with error.
   */
  emitFailed(task_id: string, error: string, recovery_steps?: string[]): void {
    this.emit({
      task_id,
      state: "FAILED",
      message: `Task failed: ${error}`,
      error,
      recovery_steps,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Remove completed tasks older than maxAge (ms).
   */
  cleanup(maxAge = 30 * 60 * 1000): number {
    const cutoff = Date.now() - maxAge;
    let removed = 0;

    for (const [id, task] of this.tasks) {
      if (["DONE", "FAILED"].includes(task.currentState) && task.lastUpdate < cutoff) {
        this.tasks.delete(id);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Clear all tasks and handlers.
   */
  reset(): void {
    this.tasks.clear();
    this.eventHandlers.clear();
    this.taskHandlers.clear();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// JSON Protocol Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a task dispatch JSON for System 2.
 * This is the format System 2 expects to receive.
 */
export function buildTaskDispatchJson(dispatch: TaskDispatch): string {
  return JSON.stringify(
    {
      task_id: dispatch.task_id,
      intent: dispatch.intent,
      constraints: dispatch.constraints,
      context: dispatch.context,
      priority: dispatch.priority,
    },
    null,
    2,
  );
}

/**
 * Build a task event JSON from System 2.
 * This is the format System 2 should emit.
 */
export function buildTaskEventJson(event: TaskEvent): string {
  const obj: Record<string, unknown> = {
    task_id: event.task_id,
    state: event.state,
    message: event.message,
    requires_user_input: event.requires_user_input,
  };

  if (event.result !== undefined) {
    obj.result = event.result;
  }
  if (event.error) {
    obj.error = event.error;
  }
  if (event.recovery_steps && event.recovery_steps.length > 0) {
    obj.recovery_steps = event.recovery_steps;
  }

  return JSON.stringify(obj, null, 2);
}

/**
 * Parse a task event JSON from System 2 output.
 */
export function parseTaskEventJson(json: string): TaskEvent | null {
  try {
    const parsed = JSON.parse(json);

    if (!parsed.task_id || !parsed.state || !parsed.message) {
      return null;
    }

    return {
      task_id: parsed.task_id,
      state: parsed.state,
      message: parsed.message,
      requires_user_input: parsed.requires_user_input ?? false,
      result: parsed.result,
      error: parsed.error,
      recovery_steps: parsed.recovery_steps,
      timestamp: Date.now(),
    };
  } catch {
    return null;
  }
}
