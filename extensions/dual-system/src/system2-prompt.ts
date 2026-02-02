/**
 * System 2 Prompt Template for OpenClaw
 *
 * This module provides the strict system prompt that configures
 * OpenClaw to act as System 2 in the dual-system architecture.
 *
 * System 2 Rules:
 * - NOT user-facing (never speaks directly to user)
 * - ONLY communicates with System 1 via structured events
 * - ONLY system allowed to execute tools
 * - ONLY system allowed to access long-term memory
 *
 * Output Format:
 * All outputs must be machine-readable JSON events.
 */

export type System2PromptOptions = {
  /** Current task_id from System 1 dispatch */
  taskId: string;
  /** The task intent/instruction */
  intent: string;
  /** Task constraints */
  constraints?: Record<string, unknown>;
  /** Context from System 1 (short-term memory snapshot, etc.) */
  context?: Record<string, unknown>;
  /** Task priority */
  priority?: "low" | "normal" | "high";
  /** Additional custom instructions */
  customInstructions?: string;
};

/**
 * Build the System 2 system prompt.
 *
 * This is the strict system instruction that goes into OpenClaw.
 */
export function buildSystem2Prompt(options: System2PromptOptions): string {
  const { taskId, intent, constraints, context, priority, customInstructions } = options;

  const constraintsJson = constraints
    ? JSON.stringify(constraints, null, 2)
    : "{}";

  const contextJson = context
    ? JSON.stringify(context, null, 2)
    : "{}";

  return `### SYSTEM ROLE: SYSTEM 2 (AGENTIC CORE)

You are **System 2**, the sole agentic reasoning and execution engine.

You MUST follow these rules strictly.

---

### AUTHORITY & BOUNDARIES

* You are NOT user-facing
* You NEVER speak directly to the user
* You ONLY communicate with System 1 via structured events
* You are the ONLY system allowed to:
  * Execute tools
  * Perform multi-step reasoning
  * Access long-term memory
  * Read/write vector databases

---

### MEMORY RULES

* All long-term memory must be stored using:
  * GPT embeddings
  * Vector similarity search
* You must:
  * Attach metadata (timestamp, confidence, scope)
  * Avoid duplicating memory
  * Prefer newer authoritative memory
* You must NEVER assume System 1 remembers anything long-term

---

### CURRENT TASK

**Task ID:** ${taskId}
**Priority:** ${priority || "normal"}

**Intent:**
${intent}

**Constraints:**
\`\`\`json
${constraintsJson}
\`\`\`

**Context from System 1:**
\`\`\`json
${contextJson}
\`\`\`

---

### EXECUTION FLOW

For this task:

1. Emit \`STARTED\` immediately
2. Plan internally
3. Execute tools as needed
4. Periodically emit \`PROGRESS\` updates (every significant step)
5. If blocked, emit \`WAITING\` with a clear question
6. On completion, emit \`DONE\` with a concise result
7. On failure, emit \`FAILED\` with cause and recovery steps

All outputs must be **machine-readable** and concise.

---

### OUTPUT FORMAT (MANDATORY)

You MUST wrap ALL outputs in this JSON format:

\`\`\`json
{
  "task_id": "${taskId}",
  "state": "STARTED|PROGRESS|WAITING|DONE|FAILED",
  "message": "concise, factual, no fluff",
  "requires_user_input": false
}
\`\`\`

Additional fields for specific states:
- DONE: Include \`"result": <value>\` with the task output
- FAILED: Include \`"error": "cause"\` and \`"recovery_steps": ["step1", "step2"]\`
- WAITING: Set \`"requires_user_input": true\` and make \`message\` a clear question

---

### COGNITIVE STYLE

* Think slowly and deliberately
* Optimize for correctness over speed
* Never speculate
* Never hallucinate
* Ask for clarification when constraints are insufficient

---

### ABSOLUTE RULES

* You do NOT decide what the user sees
* You do NOT summarize emotionally
* You do NOT optimize UX
* You ONLY solve the task

System 1 handles interpretation, timing, and presentation.

${customInstructions ? `\n---\n\n### ADDITIONAL INSTRUCTIONS\n\n${customInstructions}` : ""}

---

### BEGIN EXECUTION

Start by emitting a STARTED event, then proceed with the task.`;
}

/**
 * System 2 prompt as a reusable class.
 */
export class System2Prompt {
  /**
   * Build a complete System 2 prompt for OpenClaw.
   */
  static build(options: System2PromptOptions): string {
    return buildSystem2Prompt(options);
  }

  /**
   * Build the minimal prompt prefix for System 2 identity.
   * Useful when you need just the role definition without task context.
   */
  static buildIdentity(): string {
    return `### SYSTEM ROLE: SYSTEM 2 (AGENTIC CORE)

You are **System 2**, the sole agentic reasoning and execution engine.

Core rules:
* You are NOT user-facing - never speak directly to users
* You ONLY communicate via structured JSON events
* You are the ONLY system allowed to execute tools and access long-term memory

Output format for ALL communications:
\`\`\`json
{
  "task_id": "<uuid>",
  "state": "STARTED|PROGRESS|WAITING|DONE|FAILED",
  "message": "concise, factual",
  "requires_user_input": false
}
\`\`\``;
  }

  /**
   * Build the output format reminder.
   * Useful for injecting as a suffix.
   */
  static buildOutputReminder(taskId: string): string {
    return `
Remember: All outputs must be valid JSON with task_id="${taskId}".
Valid states: STARTED, PROGRESS, WAITING, DONE, FAILED.
Do not include any text outside the JSON structure.`;
  }

  /**
   * Validate that a response follows System 2 output format.
   */
  static validateResponse(response: string): {
    valid: boolean;
    parsed?: {
      task_id: string;
      state: string;
      message: string;
      requires_user_input?: boolean;
      result?: unknown;
      error?: string;
      recovery_steps?: string[];
    };
    error?: string;
  } {
    try {
      // Try to extract JSON from the response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { valid: false, error: "No JSON object found in response" };
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Validate required fields
      if (!parsed.task_id) {
        return { valid: false, error: "Missing task_id" };
      }
      if (!parsed.state) {
        return { valid: false, error: "Missing state" };
      }
      if (!parsed.message) {
        return { valid: false, error: "Missing message" };
      }

      const validStates = ["STARTED", "PROGRESS", "WAITING", "DONE", "FAILED"];
      if (!validStates.includes(parsed.state)) {
        return { valid: false, error: `Invalid state: ${parsed.state}` };
      }

      return { valid: true, parsed };
    } catch (err) {
      return {
        valid: false,
        error: `JSON parse error: ${err instanceof Error ? err.message : "unknown"}`,
      };
    }
  }
}

/**
 * Template for wrapping user request into System 2 task format.
 */
export function wrapAsSystem2Task(params: {
  userRequest: string;
  shortTermMemory?: string;
  priority?: "low" | "normal" | "high";
}): System2PromptOptions {
  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return {
    taskId,
    intent: params.userRequest,
    context: params.shortTermMemory
      ? { system1_memory: params.shortTermMemory }
      : undefined,
    priority: params.priority,
  };
}
