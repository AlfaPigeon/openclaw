import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  TaskDispatcher,
  buildTaskDispatchJson,
  buildTaskEventJson,
  parseTaskEventJson,
  type TaskEvent,
} from "./task-dispatcher.js";

describe("TaskDispatcher", () => {
  let dispatcher: TaskDispatcher;

  beforeEach(() => {
    dispatcher = new TaskDispatcher();
  });

  describe("task dispatch", () => {
    it("creates and tracks tasks", () => {
      const taskId = dispatcher.dispatch({
        intent: "create a file",
        priority: "high",
      });

      expect(taskId).toBeDefined();

      const task = dispatcher.getTask(taskId);
      expect(task).toBeDefined();
      expect(task?.dispatch.intent).toBe("create a file");
      expect(task?.dispatch.priority).toBe("high");
      expect(task?.currentState).toBe("PENDING");
    });

    it("uses default priority", () => {
      const taskId = dispatcher.dispatch({ intent: "test" });
      const task = dispatcher.getTask(taskId);
      expect(task?.dispatch.priority).toBe("normal");
    });

    it("includes constraints and context", () => {
      const taskId = dispatcher.dispatch({
        intent: "test",
        constraints: { timeout: 5000 },
        context: { user: "alice" },
      });

      const task = dispatcher.getTask(taskId);
      expect(task?.dispatch.constraints).toEqual({ timeout: 5000 });
      expect(task?.dispatch.context).toEqual({ user: "alice" });
    });
  });

  describe("event emission", () => {
    it("emits and tracks events", () => {
      const taskId = dispatcher.dispatch({ intent: "test" });

      dispatcher.emitStarted(taskId);
      let task = dispatcher.getTask(taskId);
      expect(task?.currentState).toBe("STARTED");
      expect(task?.events).toHaveLength(1);

      dispatcher.emitProgress(taskId, "50% done");
      task = dispatcher.getTask(taskId);
      expect(task?.currentState).toBe("PROGRESS");
      expect(task?.events).toHaveLength(2);

      dispatcher.emitDone(taskId, "completed", { result: "success" });
      task = dispatcher.getTask(taskId);
      expect(task?.currentState).toBe("DONE");
      expect(task?.events).toHaveLength(3);
    });

    it("emits waiting event with requires_user_input", () => {
      const taskId = dispatcher.dispatch({ intent: "test" });
      dispatcher.emitWaiting(taskId, "What is your preference?");

      const task = dispatcher.getTask(taskId);
      expect(task?.currentState).toBe("WAITING");

      const lastEvent = task?.events.at(-1);
      expect(lastEvent?.requires_user_input).toBe(true);
      expect(lastEvent?.message).toBe("What is your preference?");
    });

    it("emits failed event with error and recovery", () => {
      const taskId = dispatcher.dispatch({ intent: "test" });
      dispatcher.emitFailed(taskId, "Network error", ["Retry", "Check connection"]);

      const task = dispatcher.getTask(taskId);
      expect(task?.currentState).toBe("FAILED");

      const lastEvent = task?.events.at(-1);
      expect(lastEvent?.error).toBe("Network error");
      expect(lastEvent?.recovery_steps).toEqual(["Retry", "Check connection"]);
    });

    it("warns on unknown task_id", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      dispatcher.emit({
        task_id: "nonexistent",
        state: "DONE",
        message: "test",
        requires_user_input: false,
      });
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("event subscription", () => {
    it("notifies event handlers", () => {
      const handler = vi.fn();
      dispatcher.onEvent(handler);

      const taskId = dispatcher.dispatch({ intent: "test" });
      dispatcher.emitStarted(taskId);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          task_id: taskId,
          state: "STARTED",
        }),
      );
    });

    it("allows unsubscribing", () => {
      const handler = vi.fn();
      const unsubscribe = dispatcher.onEvent(handler);

      const taskId = dispatcher.dispatch({ intent: "test" });
      dispatcher.emitStarted(taskId);
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();
      dispatcher.emitProgress(taskId, "test");
      expect(handler).toHaveBeenCalledTimes(1); // Not called again
    });
  });

  describe("task subscription", () => {
    it("notifies task handlers on dispatch", () => {
      const handler = vi.fn();
      dispatcher.onTask(handler);

      dispatcher.dispatch({ intent: "test task" });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: "test task",
        }),
      );
    });
  });

  describe("task queries", () => {
    it("returns active tasks", () => {
      const task1 = dispatcher.dispatch({ intent: "task1" });
      const task2 = dispatcher.dispatch({ intent: "task2" });
      dispatcher.emitStarted(task1);
      dispatcher.emitDone(task2, "done");

      const active = dispatcher.getActiveTasks();
      expect(active).toHaveLength(1);
      expect(active[0].dispatch.task_id).toBe(task1);
    });

    it("returns waiting tasks", () => {
      const task1 = dispatcher.dispatch({ intent: "task1" });
      const task2 = dispatcher.dispatch({ intent: "task2" });
      dispatcher.emitWaiting(task1, "question?");
      dispatcher.emitProgress(task2, "working");

      expect(dispatcher.hasWaitingTasks()).toBe(true);

      const waiting = dispatcher.getWaitingTasks();
      expect(waiting).toHaveLength(1);
      expect(waiting[0].dispatch.task_id).toBe(task1);
    });

    it("returns all tasks", () => {
      dispatcher.dispatch({ intent: "task1" });
      dispatcher.dispatch({ intent: "task2" });

      expect(dispatcher.getAllTasks()).toHaveLength(2);
    });
  });

  describe("cleanup", () => {
    it("removes old completed tasks", () => {
      const taskId = dispatcher.dispatch({ intent: "test" });
      dispatcher.emitDone(taskId, "done");

      // Manually backdate the lastUpdate
      const task = dispatcher.getTask(taskId);
      if (task) {
        task.lastUpdate = Date.now() - 60 * 60 * 1000; // 1 hour ago
      }

      const removed = dispatcher.cleanup(30 * 60 * 1000); // 30 min max age
      expect(removed).toBe(1);
      expect(dispatcher.getTask(taskId)).toBeUndefined();
    });

    it("keeps recent completed tasks", () => {
      const taskId = dispatcher.dispatch({ intent: "test" });
      dispatcher.emitDone(taskId, "done");

      const removed = dispatcher.cleanup(60 * 60 * 1000); // 1 hour max age
      expect(removed).toBe(0);
      expect(dispatcher.getTask(taskId)).toBeDefined();
    });

    it("keeps active tasks", () => {
      const taskId = dispatcher.dispatch({ intent: "test" });
      dispatcher.emitStarted(taskId);

      // Backdate
      const task = dispatcher.getTask(taskId);
      if (task) {
        task.lastUpdate = Date.now() - 60 * 60 * 1000;
      }

      const removed = dispatcher.cleanup(30 * 60 * 1000);
      expect(removed).toBe(0); // Not removed because not completed
    });
  });

  describe("reset", () => {
    it("clears all tasks and handlers", () => {
      const handler = vi.fn();
      dispatcher.onEvent(handler);
      dispatcher.dispatch({ intent: "test" });

      dispatcher.reset();

      expect(dispatcher.getAllTasks()).toHaveLength(0);

      // Handler should be removed
      const newTaskId = dispatcher.dispatch({ intent: "new" });
      dispatcher.emitStarted(newTaskId);
      expect(handler).not.toHaveBeenCalled();
    });
  });
});

describe("JSON helpers", () => {
  describe("buildTaskDispatchJson", () => {
    it("formats dispatch as JSON", () => {
      const json = buildTaskDispatchJson({
        task_id: "test-123",
        intent: "create file",
        constraints: { timeout: 5000 },
        context: { user: "alice" },
        priority: "high",
        created_at: 1234567890,
      });

      const parsed = JSON.parse(json);
      expect(parsed.task_id).toBe("test-123");
      expect(parsed.intent).toBe("create file");
      expect(parsed.priority).toBe("high");
    });
  });

  describe("buildTaskEventJson", () => {
    it("formats event as JSON", () => {
      const json = buildTaskEventJson({
        task_id: "test-123",
        state: "DONE",
        message: "completed",
        requires_user_input: false,
        result: { success: true },
        timestamp: 1234567890,
      });

      const parsed = JSON.parse(json);
      expect(parsed.task_id).toBe("test-123");
      expect(parsed.state).toBe("DONE");
      expect(parsed.result).toEqual({ success: true });
    });

    it("omits undefined fields", () => {
      const json = buildTaskEventJson({
        task_id: "test-123",
        state: "STARTED",
        message: "started",
        requires_user_input: false,
        timestamp: 1234567890,
      });

      const parsed = JSON.parse(json);
      expect(parsed).not.toHaveProperty("result");
      expect(parsed).not.toHaveProperty("error");
      expect(parsed).not.toHaveProperty("recovery_steps");
    });
  });

  describe("parseTaskEventJson", () => {
    it("parses valid event JSON", () => {
      const json = JSON.stringify({
        task_id: "test-123",
        state: "DONE",
        message: "completed",
        requires_user_input: false,
        result: { success: true },
      });

      const event = parseTaskEventJson(json);
      expect(event).not.toBeNull();
      expect(event?.task_id).toBe("test-123");
      expect(event?.state).toBe("DONE");
      expect(event?.result).toEqual({ success: true });
    });

    it("returns null for invalid JSON", () => {
      expect(parseTaskEventJson("not json")).toBeNull();
    });

    it("returns null for missing required fields", () => {
      expect(parseTaskEventJson(JSON.stringify({ task_id: "test" }))).toBeNull();
      expect(parseTaskEventJson(JSON.stringify({ state: "DONE" }))).toBeNull();
      expect(
        parseTaskEventJson(JSON.stringify({ task_id: "test", state: "DONE" })),
      ).toBeNull();
    });

    it("defaults requires_user_input to false", () => {
      const json = JSON.stringify({
        task_id: "test",
        state: "DONE",
        message: "done",
      });

      const event = parseTaskEventJson(json);
      expect(event?.requires_user_input).toBe(false);
    });
  });
});
