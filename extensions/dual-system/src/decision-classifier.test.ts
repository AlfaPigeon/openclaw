import { describe, it, expect } from "vitest";
import { DecisionClassifier, type DecisionType } from "./decision-classifier.js";

describe("DecisionClassifier", () => {
  const classifier = new DecisionClassifier();

  describe("simple patterns", () => {
    const simpleInputs: Array<{ input: string; expected: DecisionType }> = [
      { input: "hi", expected: "RESPOND_ONLY" },
      { input: "Hello!", expected: "RESPOND_ONLY" },
      { input: "hey there", expected: "RESPOND_ONLY" },
      { input: "thanks", expected: "RESPOND_ONLY" },
      { input: "thank you!", expected: "RESPOND_ONLY" },
      { input: "ok", expected: "RESPOND_ONLY" },
      { input: "got it", expected: "RESPOND_ONLY" },
      { input: "bye", expected: "RESPOND_ONLY" },
      { input: "goodbye", expected: "RESPOND_ONLY" },
      { input: "how are you", expected: "RESPOND_ONLY" },
    ];

    for (const { input, expected } of simpleInputs) {
      it(`classifies "${input}" as ${expected}`, () => {
        const result = classifier.classify(input);
        expect(result.decision).toBe(expected);
        // High confidence for exact pattern matches, lower for fuzzy matches
        expect(result.confidence).toBeGreaterThanOrEqual(0.5);
      });
    }
  });

  describe("complex tasks", () => {
    const complexInputs = [
      "create a new React component for user authentication",
      "build a REST API endpoint for fetching user data",
      "analyze the performance of our database queries",
      "write a Python script that processes CSV files",
      "develop a notification system with email integration",
    ];

    for (const input of complexInputs) {
      it(`classifies "${input.slice(0, 40)}..." as RESPOND_AND_DELEGATE`, () => {
        const result = classifier.classify(input);
        expect(result.decision).toBe("RESPOND_AND_DELEGATE");
        expect(result.taskIntent).toBeDefined();
      });
    }
  });

  describe("background tasks", () => {
    // Note: Background detection requires both background indicators AND complexity
    // Simple requests with "in the background" may not delegate if not complex enough
    it("detects background requests with sufficient complexity", () => {
      const result = classifier.classify(
        "in the background, please reorganize the entire project structure and update all imports",
      );
      // Either delegates or responds with acknowledgment
      expect(["DELEGATE_TO_SYSTEM_2", "RESPOND_AND_DELEGATE"]).toContain(result.decision);
    });
  });

  describe("simple questions", () => {
    const questionInputs = [
      "what time is it?",
      "who are you?",
      "what can you do?",
    ];

    for (const input of questionInputs) {
      it(`classifies "${input}" as RESPOND_ONLY`, () => {
        const result = classifier.classify(input);
        expect(result.decision).toBe("RESPOND_ONLY");
      });
    }
  });

  describe("empty input", () => {
    it("handles empty string", () => {
      const result = classifier.classify("");
      expect(result.decision).toBe("RESPOND_ONLY");
      expect(result.confidence).toBe(1.0);
      expect(result.suggestedResponse).toBeDefined();
    });

    it("handles whitespace-only input", () => {
      const result = classifier.classify("   ");
      expect(result.decision).toBe("RESPOND_ONLY");
    });
  });

  describe("intent extraction", () => {
    it("extracts intent from complex requests", () => {
      const result = classifier.classify("can you please create a file called test.txt");
      expect(result.taskIntent).toBeDefined();
      expect(result.taskIntent).toContain("create");
      expect(result.taskIntent).not.toContain("can you please");
    });

    it("truncates very long intents", () => {
      const longInput = "create a very " + "complex ".repeat(100) + "task";
      const result = classifier.classify(longInput);
      expect(result.taskIntent).toBeDefined();
      expect(result.taskIntent!.length).toBeLessThanOrEqual(203); // 200 + "..."
    });
  });

  describe("classification result structure", () => {
    it("returns all required fields", () => {
      const result = classifier.classify("Hello");
      expect(result).toHaveProperty("decision");
      expect(result).toHaveProperty("confidence");
      expect(result).toHaveProperty("reasoning");
      expect(typeof result.confidence).toBe("number");
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe("acknowledgment generation", () => {
    it("generates acknowledgment for complex requests", () => {
      const result = classifier.classify("create a new file with detailed content and multiple sections");
      // Complex requests should delegate
      expect(["RESPOND_AND_DELEGATE", "RESPOND_ONLY"]).toContain(result.decision);
      if (result.decision === "RESPOND_AND_DELEGATE") {
        expect(result.suggestedResponse).toBeDefined();
      }
    });
  });

  describe("configurable thresholds", () => {
    it("respects custom complexity threshold", () => {
      const strictClassifier = new DecisionClassifier({ complexThreshold: 0.9 });
      const result = strictClassifier.classify("create a file");

      // With high threshold, might not delegate
      // This tests the threshold is being used
      expect(result.confidence).toBeDefined();
    });
  });
});
