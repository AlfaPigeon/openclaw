#!/usr/bin/env npx ts-node
/**
 * Dual-System Runner for OpenClaw
 *
 * This script demonstrates how to run the dual-system architecture
 * with OpenClaw. System 1 (phi-mini) handles fast responses while
 * System 2 (OpenClaw) handles agentic reasoning.
 *
 * Usage:
 *   pnpm ts-node extensions/dual-system/run.ts
 *   # or
 *   bun extensions/dual-system/run.ts
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

// Load .env file
const envPath = new URL(".env", import.meta.url).pathname;
try {
  const envContent = await fs.readFile(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...valueParts] = trimmed.split("=");
      const value = valueParts.join("=");
      if (key && value && !process.env[key]) {
        process.env[key] = value;
      }
    }
  }
} catch {
  // .env file not found, continue with existing env vars
}

// Import dual-system components
import { DualSystemOrchestrator, type System1Config } from "./src/orchestrator.js";
import { System2Prompt, buildSystem2Prompt } from "./src/system2-prompt.js";
import type { TaskDispatch, TaskEvent } from "./src/task-dispatcher.js";

// Types for OpenClaw integration
type RunEmbeddedPiAgentFn = (params: Record<string, unknown>) => Promise<{
  payloads?: Array<{ text?: string; isError?: boolean }>;
  meta?: { durationMs?: number };
}>;

type OpenClawConfig = Record<string, unknown>;

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  // System 1 (phi-mini) configuration
  system1: {
    provider: process.env.SYSTEM1_PROVIDER || "ollama",
    model: process.env.SYSTEM1_MODEL || "phi3:mini",
    // For testing without phi-mini, use OpenAI
    // provider: "openai",
    // model: "gpt-4o-mini",
  },

  // System 2 (GPT-5.2) configuration
  system2: {
    provider: process.env.SYSTEM2_PROVIDER || "openai",
    model: process.env.SYSTEM2_MODEL || "gpt-5.2",
  },

  // Embeddings configuration (OpenAI text-embedding-3-large)
  embeddings: {
    model: process.env.EMBEDDING_MODEL || "text-embedding-3-large",
    dimensions: 3072, // text-embedding-3-large default
  },

  // Workspace
  workspaceDir: process.env.WORKSPACE_DIR || process.cwd(),
  timeoutMs: 120_000,
};

// ═══════════════════════════════════════════════════════════════════════════
// OpenAI Embeddings
// ═══════════════════════════════════════════════════════════════════════════

export type EmbeddingResult = {
  text: string;
  embedding: number[];
  model: string;
};

/**
 * Generate word embeddings using OpenAI's text-embedding-3-large model.
 * Requires OPENAI_API_KEY environment variable.
 */
export async function generateEmbedding(text: string): Promise<EmbeddingResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is required for embeddings");
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: CONFIG.embeddings.model,
      input: text,
      dimensions: CONFIG.embeddings.dimensions,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI embedding API error: ${response.status} - ${error}`);
  }

  const data = (await response.json()) as {
    data?: Array<{ embedding?: number[] }>;
    model?: string;
  };

  const embedding = data.data?.[0]?.embedding;
  if (!embedding) {
    throw new Error("No embedding returned from OpenAI API");
  }

  return {
    text,
    embedding,
    model: data.model || CONFIG.embeddings.model,
  };
}

/**
 * Generate embeddings for multiple texts in batch.
 */
export async function generateEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is required for embeddings");
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: CONFIG.embeddings.model,
      input: texts,
      dimensions: CONFIG.embeddings.dimensions,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI embedding API error: ${response.status} - ${error}`);
  }

  const data = (await response.json()) as {
    data?: Array<{ embedding?: number[]; index?: number }>;
    model?: string;
  };

  if (!data.data) {
    throw new Error("No embeddings returned from OpenAI API");
  }

  return data.data.map((item, i) => ({
    text: texts[item.index ?? i],
    embedding: item.embedding || [],
    model: data.model || CONFIG.embeddings.model,
  }));
}

/**
 * Calculate cosine similarity between two embeddings.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Embeddings must have the same dimension");
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ═══════════════════════════════════════════════════════════════════════════
// OpenClaw Integration
// ═══════════════════════════════════════════════════════════════════════════

async function loadOpenClawRunner(): Promise<RunEmbeddedPiAgentFn> {
  // Try source checkout first
  try {
    const mod = await import("../../src/agents/pi-embedded-runner.js");
    if (typeof mod.runEmbeddedPiAgent === "function") {
      return mod.runEmbeddedPiAgent;
    }
  } catch {
    // ignore
  }

  // Try built output
  try {
    const mod = await import("../../agents/pi-embedded-runner.js");
    if (typeof mod.runEmbeddedPiAgent === "function") {
      return mod.runEmbeddedPiAgent;
    }
  } catch {
    // ignore
  }

  throw new Error("Could not load OpenClaw agent runner");
}

async function loadOpenClawConfig(): Promise<OpenClawConfig> {
  try {
    const mod = await import("../../src/config/config.js");
    if (typeof mod.loadConfig === "function") {
      return mod.loadConfig();
    }
  } catch {
    // ignore
  }
  return {};
}

// ═══════════════════════════════════════════════════════════════════════════
// System 1 LLM Integration (phi-mini or fallback)
// ═══════════════════════════════════════════════════════════════════════════

async function invokeSystem1Llm(prompt: string): Promise<string> {
  const { provider, model } = CONFIG.system1;

  // Try Ollama first (for local phi-mini)
  if (provider === "ollama") {
    try {
      const response = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as { response?: string };
        return data.response ?? "";
      }
    } catch {
      console.warn("⚠️  Ollama not available, using fallback responses");
    }
  }

  // Try OpenAI as fallback
  if (provider === "openai" || process.env.OPENAI_API_KEY) {
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (apiKey) {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: provider === "openai" ? model : "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 150,
          }),
        });

        if (response.ok) {
          const data = (await response.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          return data.choices?.[0]?.message?.content ?? "";
        }
      }
    } catch {
      // ignore
    }
  }

  // Ultimate fallback - just return empty (will use heuristics)
  return "";
}

// ═══════════════════════════════════════════════════════════════════════════
// System 2 Integration (OpenClaw Agent)
// ═══════════════════════════════════════════════════════════════════════════

let openclawRunner: RunEmbeddedPiAgentFn | null = null;
let openclawConfig: OpenClawConfig = {};

async function invokeSystem2(dispatch: TaskDispatch): Promise<void> {
  if (!openclawRunner) {
    openclawRunner = await loadOpenClawRunner();
    openclawConfig = await loadOpenClawConfig();
  }

  const sessionId = `dual-system-${dispatch.task_id}`;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dual-"));
  const sessionFile = path.join(tmpDir, "session.json");

  // Build System 2 prompt with strict output format
  const system2Prompt = buildSystem2Prompt({
    taskId: dispatch.task_id,
    intent: dispatch.intent,
    constraints: dispatch.constraints,
    context: dispatch.context,
    priority: dispatch.priority,
  });

  try {
    console.log(`\n🤖 System 2 starting task: ${dispatch.task_id.slice(0, 8)}...`);

    const result = await openclawRunner({
      sessionId,
      sessionFile,
      workspaceDir: CONFIG.workspaceDir,
      config: openclawConfig,
      prompt: dispatch.intent,
      provider: CONFIG.system2.provider,
      model: CONFIG.system2.model,
      timeoutMs: CONFIG.timeoutMs,
      runId: `dual-${Date.now()}`,
      extraSystemPrompt: system2Prompt,
      disableTools: false,
    });

    // Extract and parse System 2 response
    const responseText =
      result.payloads
        ?.filter((p) => !p.isError && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n")
        .trim() || "";

    // Try to parse as System 2 event
    const validation = System2Prompt.validateResponse(responseText);

    if (validation.valid && validation.parsed) {
      console.log(`✅ System 2 completed: ${validation.parsed.state}`);
      console.log(`   Message: ${validation.parsed.message}`);

      // Emit event through the dispatcher (orchestrator will handle it)
      globalOrchestrator?.getDispatcher().emit({
        task_id: dispatch.task_id,
        state: validation.parsed.state as TaskEvent["state"],
        message: validation.parsed.message,
        requires_user_input: validation.parsed.requires_user_input ?? false,
        result: validation.parsed.result,
        error: validation.parsed.error,
        recovery_steps: validation.parsed.recovery_steps,
      });
    } else {
      // If response doesn't follow format, treat as DONE with the full text
      console.log(`✅ System 2 completed (unstructured response)`);
      globalOrchestrator?.getDispatcher().emitDone(
        dispatch.task_id,
        responseText.slice(0, 200) || "Task completed",
        { rawResponse: responseText },
      );
    }
  } catch (err) {
    console.error(`❌ System 2 failed:`, err);
    globalOrchestrator?.getDispatcher().emitFailed(
      dispatch.task_id,
      err instanceof Error ? err.message : "Unknown error",
      ["Check logs", "Retry the task"],
    );
  } finally {
    // Cleanup temp directory
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Runner
// ═══════════════════════════════════════════════════════════════════════════

let globalOrchestrator: DualSystemOrchestrator | null = null;

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║        Dual-System Agent Architecture for OpenClaw           ║");
  console.log("║                                                              ║");
  console.log("║  System 1: Fast layer (phi-mini) - immediate responses       ║");
  console.log("║  System 2: Agentic layer (GPT-5.2) - reasoning & tools       ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();
  console.log(`System 1: ${CONFIG.system1.provider}/${CONFIG.system1.model}`);
  console.log(`System 2: ${CONFIG.system2.provider}/${CONFIG.system2.model}`);
  console.log(`Embeddings: ${CONFIG.embeddings.model} (${CONFIG.embeddings.dimensions}d)`);
  console.log(`Workspace: ${CONFIG.workspaceDir}`);
  console.log(`OpenAI API: ${process.env.OPENAI_API_KEY ? "✓ configured" : "✗ missing OPENAI_API_KEY"}`);
  console.log();

  // Initialize the orchestrator
  const config: System1Config = {
    memoryMaxSize: 20,
    complexityThreshold: 0.4,

    // System 1 LLM for fast responses
    llmInvoke: invokeSystem1Llm,

    // System 2 (OpenClaw) for complex tasks
    system2Invoke: invokeSystem2,

    // User notification handler
    onNotifyUser: (notification) => {
      const prefix =
        notification.type === "done"
          ? "✅"
          : notification.type === "failed"
            ? "❌"
            : notification.type === "waiting"
              ? "❓"
              : "📊";

      console.log(`\n${prefix} [System 2 → User] ${notification.message}`);

      if (notification.requiresInput) {
        console.log("   (System 2 is waiting for your input)");
      }
    },
  };

  globalOrchestrator = new DualSystemOrchestrator(config);

  // Create readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("Type your messages below. Commands:");
  console.log("  /status  - Show system status");
  console.log("  /memory  - Show short-term memory");
  console.log("  /tasks   - Show active tasks");
  console.log("  /embed   - Generate embedding for text (e.g., /embed hello world)");
  console.log("  /similar - Compare two texts (e.g., /similar cat | dog)");
  console.log("  /reset   - Reset the system");
  console.log("  /quit    - Exit");
  console.log();

  const prompt = () => {
    rl.question("You: ", async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      // Handle commands
      if (trimmed.startsWith("/")) {
        await handleCommand(trimmed);
        prompt();
        return;
      }

      // Process through dual-system
      try {
        const result = await globalOrchestrator!.processInput(trimmed);

        // Show immediate response
        if (result.immediateResponse) {
          console.log(`\n🤖 System 1: ${result.immediateResponse}`);
        }

        // Show classification info
        const { classification } = result;
        console.log(
          `   [${classification.decision}] confidence=${classification.confidence.toFixed(2)}`,
        );

        if (result.delegated) {
          console.log(`   → Delegated to System 2 (task: ${result.taskId?.slice(0, 8)}...)`);
        }
      } catch (err) {
        console.error("Error:", err);
      }

      prompt();
    });
  };

  prompt();
}

async function handleCommand(cmd: string) {
  if (!globalOrchestrator) return;

  switch (cmd.toLowerCase()) {
    case "/status": {
      const active = globalOrchestrator.getActiveTasks();
      const waiting = globalOrchestrator.getWaitingTasks();
      const memory = globalOrchestrator.getMemorySnapshot();

      console.log("\n📊 System Status:");
      console.log(`   Active tasks: ${active.length}`);
      console.log(`   Waiting for input: ${waiting.length}`);
      console.log(`   Memory items: ${memory.length}`);
      break;
    }

    case "/memory": {
      const memory = globalOrchestrator.getMemorySnapshot();
      console.log("\n🧠 Short-Term Memory:");
      if (memory.length === 0) {
        console.log("   (empty)");
      } else {
        for (const item of memory.slice(0, 10)) {
          const age = Math.floor((Date.now() - item.timestamp) / 1000);
          console.log(`   [${item.category}] ${item.content.slice(0, 60)}... (${age}s ago)`);
        }
      }
      break;
    }

    case "/tasks": {
      const tasks = globalOrchestrator.getActiveTasks();
      console.log("\n📋 Active Tasks:");
      if (tasks.length === 0) {
        console.log("   (none)");
      } else {
        for (const task of tasks) {
          console.log(`   ${task.dispatch.task_id.slice(0, 8)}... [${task.currentState}]`);
          console.log(`      Intent: ${task.dispatch.intent.slice(0, 50)}...`);
        }
      }
      break;
    }

    case "/reset": {
      globalOrchestrator.reset();
      console.log("\n🔄 System reset complete");
      break;
    }

    case "/quit":
    case "/exit": {
      console.log("\nGoodbye! 👋");
      process.exit(0);
    }

    default: {
      // Handle /embed <text>
      if (cmd.toLowerCase().startsWith("/embed ")) {
        const text = cmd.slice(7).trim();
        if (!text) {
          console.log("Usage: /embed <text>");
          break;
        }
        try {
          console.log(`\n🔢 Generating embedding for: "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"`);
          const result = await generateEmbedding(text);
          console.log(`   Model: ${result.model}`);
          console.log(`   Dimensions: ${result.embedding.length}`);
          console.log(`   First 5 values: [${result.embedding.slice(0, 5).map(v => v.toFixed(6)).join(", ")}...]`);
          console.log(`   Norm: ${Math.sqrt(result.embedding.reduce((s, v) => s + v * v, 0)).toFixed(6)}`);
        } catch (err) {
          console.error(`   Error: ${err instanceof Error ? err.message : err}`);
        }
        break;
      }

      // Handle /similar <text1> | <text2>
      if (cmd.toLowerCase().startsWith("/similar ")) {
        const parts = cmd.slice(9).split("|").map(s => s.trim());
        if (parts.length !== 2 || !parts[0] || !parts[1]) {
          console.log("Usage: /similar <text1> | <text2>");
          break;
        }
        try {
          console.log(`\n🔍 Comparing: "${parts[0].slice(0, 30)}" vs "${parts[1].slice(0, 30)}"`);
          const embeddings = await generateEmbeddings(parts);
          const similarity = cosineSimilarity(embeddings[0].embedding, embeddings[1].embedding);
          console.log(`   Cosine similarity: ${(similarity * 100).toFixed(2)}%`);
          if (similarity > 0.9) console.log("   → Very similar");
          else if (similarity > 0.7) console.log("   → Similar");
          else if (similarity > 0.5) console.log("   → Somewhat related");
          else console.log("   → Different");
        } catch (err) {
          console.error(`   Error: ${err instanceof Error ? err.message : err}`);
        }
        break;
      }

      console.log(`Unknown command: ${cmd}`);
      console.log("Available: /status, /memory, /tasks, /embed, /similar, /reset, /quit");
    }
  }
}

// Run
main().catch(console.error);
