/**
 * Decision Classifier for System 1
 *
 * Classifies user input into exactly one of three categories:
 * - RESPOND_ONLY: Simple Q&A, can be handled by System 1 alone
 * - DELEGATE_TO_SYSTEM_2: Background/complex task, delegate without immediate response
 * - RESPOND_AND_DELEGATE: Acknowledge and delegate (most common for complex requests)
 *
 * This classification determines how System 1 routes requests.
 */

export type DecisionType = "RESPOND_ONLY" | "DELEGATE_TO_SYSTEM_2" | "RESPOND_AND_DELEGATE";

export type ClassificationResult = {
  decision: DecisionType;
  confidence: number; // 0-1
  reasoning: string;
  suggestedResponse?: string; // For RESPOND_ONLY or RESPOND_AND_DELEGATE
  taskIntent?: string; // For DELEGATE_TO_SYSTEM_2 or RESPOND_AND_DELEGATE
  constraints?: Record<string, unknown>;
};

// Pattern matchers for quick classification
const SIMPLE_PATTERNS = {
  greeting: /^(hi|hello|hey|good\s*(morning|afternoon|evening)|howdy)[\s!?.]*$/i,
  thanks: /^(thanks?|thank\s*you|ty|thx)[\s!?.]*$/i,
  acknowledgment: /^(ok|okay|sure|got\s*it|understood|alright|cool|great)[\s!?.]*$/i,
  farewell: /^(bye|goodbye|see\s*you|later|cya|ttyl)[\s!?.]*$/i,
  status: /^(how\s*are\s*you|what'?s\s*up|sup)[\s!?.]*$/i,
};

const COMPLEX_INDICATORS = [
  /\b(create|build|implement|develop|design|write|generate|make)\b/i,
  /\b(analyze|research|investigate|find|search|look\s*up)\b/i,
  /\b(schedule|remind|set\s*up|configure|deploy|install)\b/i,
  /\b(send|email|message|notify|alert)\b/i,
  /\b(calculate|compute|solve|figure\s*out)\b/i,
  /\b(compare|contrast|evaluate|assess)\b/i,
  /\b(file|folder|directory|code|script|program)\b/i,
  /\b(api|database|server|service|endpoint)\b/i,
  /\b(step\s*by\s*step|multi-?step|complex|detailed)\b/i,
];

// ACTION INDICATORS - commands that require tool execution / System 2
const ACTION_INDICATORS = [
  /\b(run|execute|start|launch|invoke|trigger|call)\b/i,
  /\b(check|verify|test|validate|inspect)\b/i,
  /\b(list|show|display|get|fetch|retrieve|read)\b.*\b(files?|folders?|directories?|contents?)\b/i,
  /\bls\b/i, // Unix ls command
  /\b(weather|temperature|forecast)\b/i,
  /\b(skill|tool|command|script|agent)\b/i,
  /\b(open|close|edit|modify|update|delete|remove)\b/i,
  /\b(download|upload|copy|move|rename)\b/i,
  /\b(what\s*(files?|is\s*in|are\s*in))\b/i,
  /\b(tell\s*me\s*(what|about|the))\b/i,
  /\b(at\s*(root|home|the|this))\b/i, // "at root", "at home directory"
];

const BACKGROUND_INDICATORS = [
  /\b(in\s*the\s*background|when\s*you\s*can|no\s*rush|take\s*your\s*time)\b/i,
  /\b(later|eventually|at\s*some\s*point|whenever)\b/i,
  /\b(don'?t\s*need\s*to\s*wait|async|asynchronously)\b/i,
];

/**
 * Decision Classifier for System 1
 *
 * Uses a combination of pattern matching and heuristics for
 * fast classification. This is designed for phi-mini level inference.
 */
export class DecisionClassifier {
  private complexThreshold: number;
  private backgroundThreshold: number;

  constructor(options: { complexThreshold?: number; backgroundThreshold?: number } = {}) {
    this.complexThreshold = options.complexThreshold ?? 0.4;
    this.backgroundThreshold = options.backgroundThreshold ?? 0.6;
  }

  /**
   * Classify user input into a decision type.
   *
   * This is the main entry point for classification.
   * For production, this could be enhanced with phi-mini inference.
   */
  classify(input: string, context?: { recentIntents?: string[] }): ClassificationResult {
    const trimmed = input.trim();

    // Empty input
    if (!trimmed) {
      return {
        decision: "RESPOND_ONLY",
        confidence: 1.0,
        reasoning: "Empty input",
        suggestedResponse: "I didn't catch that. Could you say more?",
      };
    }

    // Check simple patterns first (fast path)
    const simpleResult = this.checkSimplePatterns(trimmed);
    if (simpleResult) {
      return simpleResult;
    }

    // Score complexity indicators
    const complexityScore = this.scoreComplexity(trimmed);
    const backgroundScore = this.scoreBackground(trimmed);
    const actionScore = this.scoreAction(trimmed);
    const length = trimmed.length;
    const questionCount = (trimmed.match(/\?/g) || []).length;
    const sentenceCount = trimmed.split(/[.!?]+/).filter((s) => s.trim()).length;

    // Decision logic
    if (backgroundScore >= this.backgroundThreshold) {
      // User explicitly wants background processing
      return {
        decision: "DELEGATE_TO_SYSTEM_2",
        confidence: backgroundScore,
        reasoning: "Background processing requested",
        taskIntent: this.extractIntent(trimmed),
        constraints: { background: true },
      };
    }

    // ACTION-TAKING REQUESTS - must delegate to System 2
    if (actionScore >= 0.3) {
      return {
        decision: "RESPOND_AND_DELEGATE",
        confidence: Math.max(actionScore, 0.8),
        reasoning: `Action/tool execution detected (score: ${actionScore.toFixed(2)})`,
        suggestedResponse: this.buildActionAcknowledgment(trimmed),
        taskIntent: this.extractIntent(trimmed),
      };
    }

    if (complexityScore >= this.complexThreshold) {
      // Complex task - acknowledge and delegate
      return {
        decision: "RESPOND_AND_DELEGATE",
        confidence: complexityScore,
        reasoning: `Complex task detected (score: ${complexityScore.toFixed(2)})`,
        suggestedResponse: this.buildAcknowledgment(trimmed),
        taskIntent: this.extractIntent(trimmed),
      };
    }

    // Simple questions or short inputs
    if (questionCount === 1 && sentenceCount <= 2 && length < 100) {
      return {
        decision: "RESPOND_ONLY",
        confidence: 0.7,
        reasoning: "Simple question detected",
        suggestedResponse: undefined, // Let phi-mini generate
      };
    }

    // Medium complexity - still delegate but with acknowledgment
    if (length > 50 || sentenceCount > 1) {
      return {
        decision: "RESPOND_AND_DELEGATE",
        confidence: 0.6,
        reasoning: "Multi-part request detected",
        suggestedResponse: this.buildAcknowledgment(trimmed),
        taskIntent: this.extractIntent(trimmed),
      };
    }

    // Default: simple response
    return {
      decision: "RESPOND_ONLY",
      confidence: 0.5,
      reasoning: "Default classification",
    };
  }

  /**
   * Fast path for simple conversational patterns.
   */
  private checkSimplePatterns(input: string): ClassificationResult | null {
    for (const [type, pattern] of Object.entries(SIMPLE_PATTERNS)) {
      if (pattern.test(input)) {
        return {
          decision: "RESPOND_ONLY",
          confidence: 0.95,
          reasoning: `Simple ${type} pattern`,
          suggestedResponse: this.getSimpleResponse(type),
        };
      }
    }
    return null;
  }

  /**
   * Score how complex/tool-requiring the input appears to be.
   */
  private scoreComplexity(input: string): number {
    let score = 0;
    let matches = 0;

    for (const pattern of COMPLEX_INDICATORS) {
      if (pattern.test(input)) {
        matches++;
      }
    }

    // Base score from pattern matches
    score = Math.min(matches / 3, 1);

    // Length bonus
    if (input.length > 200) {
      score += 0.2;
    } else if (input.length > 100) {
      score += 0.1;
    }

    // Multiple sentences bonus
    const sentences = input.split(/[.!?]+/).filter((s) => s.trim()).length;
    if (sentences > 2) {
      score += 0.15;
    }

    return Math.min(score, 1);
  }

  /**
   * Score how much this looks like a background task request.
   */
  private scoreBackground(input: string): number {
    let score = 0;

    for (const pattern of BACKGROUND_INDICATORS) {
      if (pattern.test(input)) {
        score += 0.4;
      }
    }

    return Math.min(score, 1);
  }

  /**
   * Score how much this looks like an action/tool execution request.
   * These MUST be delegated to System 2 since System 1 cannot execute tools.
   */
  private scoreAction(input: string): number {
    let score = 0;
    let matches = 0;

    for (const pattern of ACTION_INDICATORS) {
      if (pattern.test(input)) {
        matches++;
      }
    }

    // Even one action indicator should trigger delegation
    if (matches >= 1) {
      score = 0.5 + (matches * 0.15);
    }

    // Explicit "run X" or "execute X" is a strong signal
    if (/\b(run|execute|invoke|call)\s+\w/i.test(input)) {
      score = Math.max(score, 0.85);
    }

    // Commands like "ls", "check weather", "list files" are definite actions
    if (/\bls\b|\bcheck\s+(weather|the)|\blist\s+(files?|folder)/i.test(input)) {
      score = Math.max(score, 0.9);
    }

    return Math.min(score, 1);
  }

  /**
   * Build acknowledgment for action-taking requests.
   */
  private buildActionAcknowledgment(input: string): string {
    if (/weather/i.test(input)) {
      return "Let me check the weather for you...";
    }
    if (/\bls\b|list.*file|show.*file|what.*file/i.test(input)) {
      return "Let me list those files for you...";
    }
    if (/\brun\b/i.test(input)) {
      return "Running that now...";
    }
    if (/\bcheck\b/i.test(input)) {
      return "Checking that for you...";
    }
    return "On it! Executing that now...";
  }

  /**
   * Extract the core intent from user input.
   */
  private extractIntent(input: string): string {
    // Remove filler words and extract main action
    const cleaned = input
      .replace(/^(can you|could you|please|i want you to|i need you to|help me)/i, "")
      .replace(/[.!?]+$/, "")
      .trim();

    // Truncate if too long
    if (cleaned.length > 200) {
      return cleaned.slice(0, 200) + "...";
    }

    return cleaned || input.slice(0, 100);
  }

  /**
   * Build an acknowledgment message for the user.
   */
  private buildAcknowledgment(input: string): string {
    const intent = this.extractIntent(input);
    const verbs = intent.match(/\b(create|build|find|analyze|send|write|make|get)\b/i);

    if (verbs) {
      return `On it! I'll ${verbs[0].toLowerCase()} that for you. Working on it now...`;
    }

    return "Got it! Working on that now...";
  }

  /**
   * Get a response for simple conversational patterns.
   */
  private getSimpleResponse(type: string): string {
    const responses: Record<string, string[]> = {
      greeting: ["Hello!", "Hi there!", "Hey! How can I help?"],
      thanks: ["You're welcome!", "Happy to help!", "Anytime!"],
      acknowledgment: ["Perfect!", "Great!", "Sounds good!"],
      farewell: ["Goodbye!", "See you!", "Take care!"],
      status: ["I'm doing well! Ready to help.", "All good here! What can I do for you?"],
    };

    const options = responses[type] || ["Okay!"];
    return options[Math.floor(Math.random() * options.length)] ?? options[0] ?? "Okay!";
  }

  /**
   * Enhanced classification using phi-mini inference.
   *
   * This method is designed to be called with the actual LLM for
   * more accurate classification when needed.
   */
  async classifyWithLlm(
    input: string,
    llmInvoke: (prompt: string) => Promise<string>,
  ): Promise<ClassificationResult> {
    const prompt = `Classify this user input into exactly ONE category.

Categories:
- RESPOND_ONLY: Simple greetings, thanks, basic Q&A that needs no tools
- DELEGATE_TO_SYSTEM_2: Background tasks, no immediate response needed
- RESPOND_AND_DELEGATE: Complex tasks needing acknowledgment + background work

User input: "${input}"

Respond with JSON only:
{"decision": "RESPOND_ONLY|DELEGATE_TO_SYSTEM_2|RESPOND_AND_DELEGATE", "confidence": 0.0-1.0, "reasoning": "brief reason", "taskIntent": "extracted task if delegating"}`;

    try {
      const response = await llmInvoke(prompt);
      const parsed = JSON.parse(response.trim());

      return {
        decision: parsed.decision || "RESPOND_AND_DELEGATE",
        confidence: parsed.confidence || 0.5,
        reasoning: parsed.reasoning || "LLM classification",
        taskIntent: parsed.taskIntent,
      };
    } catch {
      // Fallback to heuristic classification
      return this.classify(input);
    }
  }
}
