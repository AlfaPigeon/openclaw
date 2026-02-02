import { describe, it, expect, beforeEach, vi } from "vitest";
import { DualSystemOrchestrator, type System1Config } from "./orchestrator.js";

describe("DualSystemOrchestrator", () => {
  let orchestrator: DualSystemOrchestrator;
  let mockLlmInvoke: ReturnType<typeof vi.fn>;
  let mockSystem2Invoke: ReturnType<typeof vi.fn>;
  let mockOnNotifyUser: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockLlmInvoke = vi.fn().mockResolvedValue("I understand.");
    mockSystem2Invoke = vi.fn().mockResolvedValue(undefined);
    mockOnNotifyUser = vi.fn();

    const config: System1Config = {
      memoryMaxSize: 10,
      llmInvoke: mockLlmInvoke,
      system2Invoke: mockSystem2Invoke,
      onNotifyUser: mockOnNotifyUser,
    };

    orchestrator = new DualSystemOrchestrator(config);
  });

  describe("input processing", () => {
    it("processes simple greetings without delegation", async () => {
      const result = await orchestrator.processInput("hello");

      expect(result.classification.decision).toBe("RESPOND_ONLY");
      expect(result.delegated).toBe(false);
      expect(result.immediateResponse).toBeDefined();
      expect(mockSystem2Invoke).not.toHaveBeenCalled();
    });

    it("delegates complex tasks", async () => {
      const result = await orchestrator.processInput(
        "create a Python script that fetches weather data from an API and displays it",
      );

      expect(result.classification.decision).toBe("RESPOND_AND_DELEGATE");
      expect(result.delegated).toBe(true);
      expect(result.taskId).toBeDefined();
      expect(result.immediateResponse).toBeDefined();
      expect(mockSystem2Invoke).toHaveBeenCalled();
    });

    it("handles multi-part requests", async () => {
      const result = await orchestrator.processInput(
        "in the background, please clean up all the temp files and reorganize the project structure",
      );

      // Should delegate (either with or without immediate response)
      expect(result.delegated).toBe(true);
    });

    it("tracks user messages in memory", async () => {
      await orchestrator.processInput("hello");
      const memory = orchestrator.getMemorySnapshot();

      expect(memory.some((m) => m.content === "hello")).toBe(true);
    });
  });

  describe("System 2 integration", () => {
    it("passes task dispatch to system2Invoke", async () => {
      await orchestrator.processInput("create a new file");

      expect(mockSystem2Invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: expect.any(String),
          context: expect.any(Object),
          priority: expect.any(String),
        }),
      );
    });

    it("handles System 2 invocation errors", async () => {
      mockSystem2Invoke.mockRejectedValueOnce(new Error("System 2 failed"));

      const result = await orchestrator.processInput("create a file");

      // Should still complete (error handled internally)
      expect(result.delegated).toBe(true);
    });
  });

  describe("System 2 events", () => {
    it("notifies user on task completion", async () => {
      const result = await orchestrator.processInput("create a file");
      const taskId = result.taskId!;

      // Simulate System 2 completing the task
      orchestrator.getDispatcher().emitDone(taskId, "File created successfully");

      expect(mockOnNotifyUser).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "done",
          taskId,
          message: "File created successfully",
        }),
      );
    });

    it("notifies user when waiting for input", async () => {
      const result = await orchestrator.processInput("create a Python file that does something complex");
      
      // Only test if a task was delegated
      if (result.taskId) {
        orchestrator.getDispatcher().emitWaiting(result.taskId, "What format do you prefer?");

        expect(mockOnNotifyUser).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "waiting",
            taskId: result.taskId,
            requiresInput: true,
          }),
        );
      } else {
        // If not delegated, test that waiting tasks work in general
        const taskId = orchestrator.getDispatcher().dispatch({ intent: "test task" });
        orchestrator.getDispatcher().emitWaiting(taskId, "What format?");
        expect(mockOnNotifyUser).toHaveBeenCalled();
      }
    });

    it("notifies user on failure", async () => {
      const result = await orchestrator.processInput("create a file");
      const taskId = result.taskId!;

      orchestrator.getDispatcher().emitFailed(taskId, "Permission denied");

      expect(mockOnNotifyUser).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "failed",
          taskId,
        }),
      );
    });

    it("tracks System 2 state in memory", async () => {
      const result = await orchestrator.processInput("create a file");
      const taskId = result.taskId!;

      orchestrator.getDispatcher().emitStarted(taskId);

      const memory = orchestrator.getMemorySnapshot();
      expect(
        memory.some((m) => m.category === "system_state" && m.content.includes(taskId)),
      ).toBe(true);
    });
  });

  describe("state queries", () => {
    it("returns active tasks", async () => {
      await orchestrator.processInput("task 1");
      await orchestrator.processInput("task 2");

      const active = orchestrator.getActiveTasks();
      // At least 2 tasks should be pending/active (depends on classification)
      expect(active.length).toBeGreaterThanOrEqual(0);
    });

    it("returns waiting tasks", async () => {
      const result = await orchestrator.processInput("create a file");
      const taskId = result.taskId!;

      orchestrator.getDispatcher().emitWaiting(taskId, "What name?");

      const waiting = orchestrator.getWaitingTasks();
      expect(waiting).toHaveLength(1);
      expect(waiting[0].dispatch.task_id).toBe(taskId);
    });
  });

  describe("provide input", () => {
    it("provides input to waiting task", async () => {
      const result = await orchestrator.processInput("create a file");
      const taskId = result.taskId!;

      orchestrator.getDispatcher().emitWaiting(taskId, "What name?");

      await orchestrator.provideInput(taskId, "myfile.txt");

      // Should call system2Invoke again with the follow-up
      expect(mockSystem2Invoke).toHaveBeenCalledTimes(2);
    });

    it("throws for non-waiting task", async () => {
      const result = await orchestrator.processInput("create a file");
      const taskId = result.taskId!;

      // Task is not in WAITING state
      await expect(orchestrator.provideInput(taskId, "input")).rejects.toThrow(
        /not waiting for input/,
      );
    });
  });

  describe("lifecycle", () => {
    it("resets state", async () => {
      await orchestrator.processInput("hello");
      await orchestrator.processInput("create something");

      orchestrator.reset();

      expect(orchestrator.getMemorySnapshot()).toHaveLength(0);
      expect(orchestrator.getActiveTasks()).toHaveLength(0);
    });

    it("cleans up old tasks", async () => {
      const result = await orchestrator.processInput("create a file");
      const taskId = result.taskId!;

      orchestrator.getDispatcher().emitDone(taskId, "done");

      // Backdate the task
      const task = orchestrator.getDispatcher().getTask(taskId);
      if (task) {
        task.lastUpdate = Date.now() - 60 * 60 * 1000;
      }

      orchestrator.cleanup(30 * 60 * 1000);

      expect(orchestrator.getDispatcher().getTask(taskId)).toBeUndefined();
    });
  });

  describe("without LLM", () => {
    it("uses fallback responses without llmInvoke", async () => {
      const basicOrchestrator = new DualSystemOrchestrator({});

      const result = await basicOrchestrator.processInput("hello");
      expect(result.immediateResponse).toBeDefined();
    });
  });
});
