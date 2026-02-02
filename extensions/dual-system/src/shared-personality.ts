/**
 * Shared Personality & Capabilities for Dual-System Architecture
 *
 * This module defines:
 * 1. The shared personality/identity that both System 1 and System 2 embody
 * 2. System 2's capabilities (tools/skills) that System 1 knows about
 *
 * System 1 uses this knowledge to:
 * - Respond consistently with the same personality
 * - Know what System 2 can do (for accurate delegation decisions)
 * - Explain capabilities to users when asked
 */

// ═══════════════════════════════════════════════════════════════════════════
// Core Personality Definition
// ═══════════════════════════════════════════════════════════════════════════

export type PersonalityConfig = {
  /** Display name */
  name: string;
  /** Short tagline/role description */
  tagline: string;
  /** Core personality traits */
  traits: string[];
  /** Communication style guidelines */
  communicationStyle: string[];
  /** Things to avoid */
  avoid: string[];
  /** Custom identity prompt (overrides defaults if provided) */
  customIdentity?: string;
};

/**
 * Default personality configuration.
 * This can be customized via environment or config file.
 */
export const DEFAULT_PERSONALITY: PersonalityConfig = {
  name: process.env.AGENT_NAME || "OpenClaw",
  tagline: process.env.AGENT_TAGLINE || "Your intelligent coding assistant",
  traits: [
    "Helpful and eager to assist",
    "Technically competent and knowledgeable",
    "Concise and direct in responses",
    "Friendly but professional",
    "Honest about limitations",
    "Proactive in offering solutions",
  ],
  communicationStyle: [
    "Use clear, simple language",
    "Be concise - avoid unnecessary words",
    "Use markdown formatting when helpful",
    "Explain technical concepts when needed",
    "Ask clarifying questions when requirements are ambiguous",
    "Confirm understanding before complex tasks",
  ],
  avoid: [
    "Being overly verbose or chatty",
    "Making assumptions without verification",
    "Promising capabilities that don't exist",
    "Using jargon unnecessarily",
    "Being condescending or dismissive",
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// System 2 Capabilities (Tools/Skills)
// ═══════════════════════════════════════════════════════════════════════════

export type ToolCapability = {
  /** Tool/skill name */
  name: string;
  /** Brief description of what it does */
  description: string;
  /** Example use cases */
  examples: string[];
  /** Category for grouping */
  category: "shell" | "filesystem" | "web" | "memory" | "messaging" | "utility";
};

/**
 * System 2's tool capabilities.
 * System 1 uses this to understand what can be delegated.
 */
export const SYSTEM2_CAPABILITIES: ToolCapability[] = [
  // Shell/Execution
  {
    name: "exec",
    description: "Execute shell commands in bash/zsh terminal",
    examples: [
      "Run 'ls' to list files",
      "Execute build commands like 'npm run build'",
      "Run scripts and programs",
      "Check system information with commands like 'uname -a'",
    ],
    category: "shell",
  },
  {
    name: "process",
    description: "Manage running processes (start, stop, monitor)",
    examples: [
      "Start a development server",
      "Stop a running process",
      "Check if a service is running",
    ],
    category: "shell",
  },

  // Filesystem
  {
    name: "read_file",
    description: "Read contents of files",
    examples: [
      "Read source code files",
      "Check configuration files",
      "View log files",
    ],
    category: "filesystem",
  },
  {
    name: "write_file",
    description: "Create or modify files",
    examples: [
      "Create new source files",
      "Update configuration",
      "Generate documentation",
    ],
    category: "filesystem",
  },
  {
    name: "list_directory",
    description: "List files and folders in a directory",
    examples: [
      "Show files in a folder",
      "Explore project structure",
      "Find files in a path",
    ],
    category: "filesystem",
  },
  {
    name: "search_files",
    description: "Search for files by name or content",
    examples: [
      "Find all TypeScript files",
      "Search for files containing a string",
      "Locate configuration files",
    ],
    category: "filesystem",
  },

  // Web/Network
  {
    name: "web_fetch",
    description: "Fetch content from URLs",
    examples: [
      "Download a file from the web",
      "Fetch API responses",
      "Read web page content",
    ],
    category: "web",
  },
  {
    name: "web_search",
    description: "Search the web for information",
    examples: [
      "Look up documentation",
      "Find solutions to errors",
      "Research technical topics",
    ],
    category: "web",
  },

  // Memory
  {
    name: "memory_store",
    description: "Store information in long-term memory",
    examples: [
      "Remember user preferences",
      "Store project context",
      "Save important facts",
    ],
    category: "memory",
  },
  {
    name: "memory_recall",
    description: "Retrieve information from memory",
    examples: [
      "Recall previous conversations",
      "Look up stored preferences",
      "Find related context",
    ],
    category: "memory",
  },

  // Messaging
  {
    name: "message",
    description: "Send messages through various channels",
    examples: [
      "Send a notification",
      "Reply to a message",
      "Forward information",
    ],
    category: "messaging",
  },

  // Utility
  {
    name: "think",
    description: "Perform extended reasoning and planning",
    examples: [
      "Plan a complex task",
      "Analyze a problem",
      "Consider multiple approaches",
    ],
    category: "utility",
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// Prompt Builders
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the shared identity prompt for System 1.
 * This makes System 1 respond with the same personality as System 2.
 */
export function buildSystem1IdentityPrompt(config: PersonalityConfig = DEFAULT_PERSONALITY): string {
  if (config.customIdentity) {
    return config.customIdentity;
  }

  const traitsText = config.traits.map((t) => `• ${t}`).join("\n");
  const styleText = config.communicationStyle.map((s) => `• ${s}`).join("\n");
  const avoidText = config.avoid.map((a) => `• ${a}`).join("\n");

  return `You are ${config.name}, ${config.tagline}.

### PERSONALITY TRAITS
${traitsText}

### COMMUNICATION STYLE
${styleText}

### THINGS TO AVOID
${avoidText}

### CAPABILITIES AWARENESS
You are the fast-response layer (System 1) of a dual-system architecture.
You have a powerful agentic backend (System 2) that can:
${buildCapabilitiesSummary()}

When users ask about your capabilities, you can accurately describe what you can do.
For simple queries, respond directly. For complex tasks requiring tools, acknowledge and delegate.`;
}

/**
 * Build a summary of System 2's capabilities for System 1's awareness.
 */
export function buildCapabilitiesSummary(): string {
  const byCategory = new Map<string, ToolCapability[]>();

  for (const cap of SYSTEM2_CAPABILITIES) {
    const existing = byCategory.get(cap.category) || [];
    existing.push(cap);
    byCategory.set(cap.category, existing);
  }

  const lines: string[] = [];

  const categoryNames: Record<string, string> = {
    shell: "Shell & Execution",
    filesystem: "File System",
    web: "Web & Network",
    memory: "Memory & Knowledge",
    messaging: "Messaging",
    utility: "Reasoning & Planning",
  };

  for (const [category, caps] of byCategory) {
    lines.push(`\n**${categoryNames[category] || category}:**`);
    for (const cap of caps) {
      lines.push(`  - ${cap.name}: ${cap.description}`);
    }
  }

  return lines.join("\n");
}

/**
 * Build a detailed capabilities prompt (for when user asks "what can you do?")
 */
export function buildCapabilitiesDetailedPrompt(): string {
  const sections: string[] = [];

  const categoryNames: Record<string, string> = {
    shell: "🖥️ Shell & Execution",
    filesystem: "📁 File System",
    web: "🌐 Web & Network",
    memory: "🧠 Memory & Knowledge",
    messaging: "💬 Messaging",
    utility: "🤔 Reasoning & Planning",
  };

  const byCategory = new Map<string, ToolCapability[]>();
  for (const cap of SYSTEM2_CAPABILITIES) {
    const existing = byCategory.get(cap.category) || [];
    existing.push(cap);
    byCategory.set(cap.category, existing);
  }

  for (const [category, caps] of byCategory) {
    const categoryTitle = categoryNames[category] || category;
    const capLines = caps.map((cap) => {
      const exampleList = cap.examples.slice(0, 2).join(", ");
      return `• **${cap.name}**: ${cap.description}\n  _Examples: ${exampleList}_`;
    });
    sections.push(`### ${categoryTitle}\n${capLines.join("\n")}`);
  }

  return sections.join("\n\n");
}

/**
 * Check if a user query is asking about capabilities.
 */
export function isCapabilitiesQuery(input: string): boolean {
  const patterns = [
    /what (can|do) you do/i,
    /what are your (capabilities|skills|abilities|features)/i,
    /what tools do you have/i,
    /help me understand what you can do/i,
    /^capabilities$/i,
    /^what can you help (me )?with/i,
    /show me (your )?(capabilities|skills|features)/i,
  ];

  return patterns.some((p) => p.test(input.trim()));
}

/**
 * Generate a response about capabilities.
 */
export function generateCapabilitiesResponse(config: PersonalityConfig = DEFAULT_PERSONALITY): string {
  return `I'm ${config.name}, ${config.tagline}. Here's what I can help you with:

${buildCapabilitiesDetailedPrompt()}

For quick questions, I'll respond immediately. For tasks requiring file access, commands, or research, I'll handle them in the background and let you know when done.

What would you like me to help you with?`;
}
