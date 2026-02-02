import { describe, it, expect, beforeEach } from "vitest";
import { ShortTermMemory } from "./short-term-memory.js";

describe("ShortTermMemory", () => {
  let memory: ShortTermMemory;

  beforeEach(() => {
    memory = new ShortTermMemory({ maxSize: 5 });
  });

  describe("basic operations", () => {
    it("adds and retrieves items", () => {
      const item = memory.add({
        content: "test content",
        category: "user_input",
        priority: 0.5,
      });

      expect(item.id).toBeDefined();
      expect(item.content).toBe("test content");
      expect(item.category).toBe("user_input");

      const retrieved = memory.get(item.id);
      expect(retrieved).toEqual(item);
    });

    it("returns undefined for non-existent items", () => {
      expect(memory.get("nonexistent")).toBeUndefined();
    });

    it("removes items", () => {
      const item = memory.add({ content: "test", category: "context" });
      expect(memory.get(item.id)).toBeDefined();

      memory.remove(item.id);
      expect(memory.get(item.id)).toBeUndefined();
    });

    it("clears all items", () => {
      memory.add({ content: "test1", category: "context" });
      memory.add({ content: "test2", category: "context" });
      expect(memory.size).toBe(2);

      memory.clear();
      expect(memory.size).toBe(0);
    });
  });

  describe("priority queue behavior", () => {
    it("returns items sorted by priority (descending)", () => {
      memory.add({ content: "low", category: "context", priority: 0.2 });
      memory.add({ content: "high", category: "context", priority: 0.9 });
      memory.add({ content: "medium", category: "context", priority: 0.5 });

      const items = memory.getAll();
      expect(items[0].content).toBe("high");
      expect(items[1].content).toBe("medium");
      expect(items[2].content).toBe("low");
    });

    it("evicts lowest priority when at capacity", () => {
      // Fill up memory
      for (let i = 0; i < 5; i++) {
        memory.add({ content: `item${i}`, category: "context", priority: 0.5 });
      }
      expect(memory.size).toBe(5);

      // Add one more with higher priority
      memory.add({ content: "new high priority", category: "context", priority: 0.9 });

      // Should still be at capacity
      expect(memory.size).toBe(5);

      // New item should be present
      const items = memory.getAll();
      expect(items.some((i) => i.content === "new high priority")).toBe(true);
    });

    it("updates priority", () => {
      const item = memory.add({ content: "test", category: "context", priority: 0.3 });
      expect(item.priority).toBe(0.3);

      memory.updatePriority(item.id, 0.8);

      const updated = memory.get(item.id);
      expect(updated?.priority).toBe(0.8);
    });

    it("clamps priority to 0-1 range", () => {
      const item = memory.add({ content: "test", category: "context", priority: 0.5 });

      memory.updatePriority(item.id, 1.5);
      expect(memory.get(item.id)?.priority).toBe(1);

      memory.updatePriority(item.id, -0.5);
      expect(memory.get(item.id)?.priority).toBe(0);
    });
  });

  describe("TTL behavior", () => {
    it("evicts expired items", async () => {
      const item = memory.add({
        content: "expires soon",
        category: "context",
        ttl: 50, // 50ms TTL
      });

      expect(memory.get(item.id)).toBeDefined();

      // Wait for expiration
      await new Promise((r) => setTimeout(r, 60));

      // Item should be gone
      expect(memory.get(item.id)).toBeUndefined();
    });

    it("extends TTL", async () => {
      const item = memory.add({
        content: "test",
        category: "context",
        ttl: 100,
      });

      memory.extendTtl(item.id, 1000);

      // Wait past original TTL
      await new Promise((r) => setTimeout(r, 150));

      // Item should still exist due to extension
      expect(memory.get(item.id)).toBeDefined();
    });
  });

  describe("category filtering", () => {
    it("filters by category", () => {
      memory.add({ content: "user1", category: "user_input" });
      memory.add({ content: "user2", category: "user_input" });
      memory.add({ content: "state1", category: "system_state" });
      memory.add({ content: "intent1", category: "intent" });

      const userInputs = memory.getByCategory("user_input");
      expect(userInputs).toHaveLength(2);
      expect(userInputs.every((i) => i.category === "user_input")).toBe(true);

      const systemStates = memory.getByCategory("system_state");
      expect(systemStates).toHaveLength(1);
    });
  });

  describe("convenience methods", () => {
    it("tracks user messages", () => {
      const item = memory.trackUserMessage("Hello there");
      expect(item.category).toBe("user_input");
      expect(item.content).toBe("Hello there");
      expect(item.priority).toBe(0.7); // User messages have priority 0.7
    });

    it("tracks intent (replaces old intent)", () => {
      memory.trackIntent("create file", 0.8);
      memory.trackIntent("delete file", 0.9);

      const intents = memory.getByCategory("intent");
      expect(intents).toHaveLength(1);
      expect(intents[0].content).toBe("delete file");
    });

    it("tracks system state", () => {
      const item = memory.trackSystemState("Task started", "task_123");
      expect(item.category).toBe("system_state");
      expect(item.metadata).toEqual({ taskId: "task_123" });
    });

    it("builds context string", () => {
      memory.trackUserMessage("Hello");
      memory.trackIntent("greeting", 0.9);
      memory.trackSystemState("Idle");

      const context = memory.buildContextString(10);
      expect(context).toContain("user_input");
      expect(context).toContain("Hello");
    });
  });

  describe("recent items", () => {
    it("returns most recent items first", async () => {
      memory.add({ content: "first", category: "context" });
      await new Promise((r) => setTimeout(r, 10));
      memory.add({ content: "second", category: "context" });
      await new Promise((r) => setTimeout(r, 10));
      memory.add({ content: "third", category: "context" });

      const recent = memory.getRecent(2);
      expect(recent).toHaveLength(2);
      expect(recent[0].content).toBe("third");
      expect(recent[1].content).toBe("second");
    });
  });
});
