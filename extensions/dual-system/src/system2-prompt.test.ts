import { describe, it, expect } from "vitest";
import { System2Prompt, buildSystem2Prompt, wrapAsSystem2Task } from "./system2-prompt.js";

describe("System2Prompt", () => {
  describe("buildSystem2Prompt", () => {
    it("builds complete prompt with all sections", () => {
      const prompt = buildSystem2Prompt({
        taskId: "task-123",
        intent: "Create a weather fetching script",
        constraints: { language: "python", timeout: 30000 },
        context: { user: "alice", recent: ["asked about weather"] },
        priority: "high",
      });

      // Check required sections
      expect(prompt).toContain("SYSTEM ROLE: SYSTEM 2");
      expect(prompt).toContain("AUTHORITY & BOUNDARIES");
      expect(prompt).toContain("MEMORY RULES");
      expect(prompt).toContain("CURRENT TASK");
      expect(prompt).toContain("EXECUTION FLOW");
      expect(prompt).toContain("OUTPUT FORMAT");
      expect(prompt).toContain("COGNITIVE STYLE");
      expect(prompt).toContain("ABSOLUTE RULES");

      // Check task details
      expect(prompt).toContain("task-123");
      expect(prompt).toContain("Create a weather fetching script");
      expect(prompt).toContain("high");
      expect(prompt).toContain("python");
    });

    it("handles minimal options", () => {
      const prompt = buildSystem2Prompt({
        taskId: "task-456",
        intent: "Simple task",
      });

      expect(prompt).toContain("task-456");
      expect(prompt).toContain("Simple task");
      expect(prompt).toContain("normal"); // Default priority
    });

    it("includes custom instructions when provided", () => {
      const prompt = buildSystem2Prompt({
        taskId: "task-789",
        intent: "Test task",
        customInstructions: "Always use TypeScript",
      });

      expect(prompt).toContain("ADDITIONAL INSTRUCTIONS");
      expect(prompt).toContain("Always use TypeScript");
    });

    it("enforces JSON output format", () => {
      const prompt = buildSystem2Prompt({
        taskId: "test",
        intent: "test",
      });

      expect(prompt).toContain('"task_id"');
      expect(prompt).toContain('"state"');
      expect(prompt).toContain('"message"');
      expect(prompt).toContain("STARTED|PROGRESS|WAITING|DONE|FAILED");
    });
  });

  describe("System2Prompt.buildIdentity", () => {
    it("returns minimal identity prompt", () => {
      const identity = System2Prompt.buildIdentity();

      expect(identity).toContain("SYSTEM ROLE: SYSTEM 2");
      expect(identity).toContain("NOT user-facing");
      expect(identity).toContain("structured JSON events");
      expect(identity).not.toContain("CURRENT TASK"); // No task-specific content
    });
  });

  describe("System2Prompt.buildOutputReminder", () => {
    it("includes task ID in reminder", () => {
      const reminder = System2Prompt.buildOutputReminder("my-task-id");

      expect(reminder).toContain("my-task-id");
      expect(reminder).toContain("STARTED");
      expect(reminder).toContain("DONE");
      expect(reminder).toContain("FAILED");
    });
  });

  describe("System2Prompt.validateResponse", () => {
    it("validates correct JSON response", () => {
      const response = JSON.stringify({
        task_id: "test-123",
        state: "DONE",
        message: "Task completed",
        requires_user_input: false,
      });

      const result = System2Prompt.validateResponse(response);
      expect(result.valid).toBe(true);
      expect(result.parsed?.task_id).toBe("test-123");
      expect(result.parsed?.state).toBe("DONE");
    });

    it("extracts JSON from mixed content", () => {
      const response = `Let me think about this...
{
  "task_id": "test-123",
  "state": "PROGRESS",
  "message": "Working on it",
  "requires_user_input": false
}`;

      const result = System2Prompt.validateResponse(response);
      expect(result.valid).toBe(true);
      expect(result.parsed?.state).toBe("PROGRESS");
    });

    it("rejects missing task_id", () => {
      const response = JSON.stringify({
        state: "DONE",
        message: "Done",
      });

      const result = System2Prompt.validateResponse(response);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("task_id");
    });

    it("rejects missing state", () => {
      const response = JSON.stringify({
        task_id: "test",
        message: "Done",
      });

      const result = System2Prompt.validateResponse(response);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("state");
    });

    it("rejects missing message", () => {
      const response = JSON.stringify({
        task_id: "test",
        state: "DONE",
      });

      const result = System2Prompt.validateResponse(response);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("message");
    });

    it("rejects invalid state", () => {
      const response = JSON.stringify({
        task_id: "test",
        state: "INVALID",
        message: "test",
      });

      const result = System2Prompt.validateResponse(response);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid state");
    });

    it("rejects non-JSON response", () => {
      const result = System2Prompt.validateResponse("This is just plain text");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("No JSON");
    });

    it("handles malformed JSON", () => {
      const result = System2Prompt.validateResponse('{ "task_id": "test", state: "DONE" }');
      expect(result.valid).toBe(false);
      expect(result.error).toContain("parse error");
    });

    it("validates all state types", () => {
      const states = ["STARTED", "PROGRESS", "WAITING", "DONE", "FAILED"];

      for (const state of states) {
        const response = JSON.stringify({
          task_id: "test",
          state,
          message: "test message",
        });

        const result = System2Prompt.validateResponse(response);
        expect(result.valid).toBe(true);
        expect(result.parsed?.state).toBe(state);
      }
    });
  });

  describe("wrapAsSystem2Task", () => {
    it("creates task options from user request", () => {
      const options = wrapAsSystem2Task({
        userRequest: "Create a file",
        priority: "high",
      });

      expect(options.taskId).toBeDefined();
      expect(options.taskId).toMatch(/^task_/);
      expect(options.intent).toBe("Create a file");
      expect(options.priority).toBe("high");
    });

    it("includes short-term memory in context", () => {
      const options = wrapAsSystem2Task({
        userRequest: "Test",
        shortTermMemory: "Recent: user asked about files",
      });

      expect(options.context).toBeDefined();
      expect(options.context?.system1_memory).toBe("Recent: user asked about files");
    });

    it("generates unique task IDs", () => {
      const options1 = wrapAsSystem2Task({ userRequest: "test" });
      const options2 = wrapAsSystem2Task({ userRequest: "test" });

      expect(options1.taskId).not.toBe(options2.taskId);
    });
  });
});
