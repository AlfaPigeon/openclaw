/**
 * Short-Term Memory for System 1
 *
 * Implements a priority queue-based memory system for maintaining
 * conversational continuity and immediate context. This is NOT a vector DB -
 * it's a simple, fast, in-memory structure optimized for low latency.
 *
 * Properties:
 * - Max size: configurable (default 20 items)
 * - Priority-based eviction
 * - TTL-based expiration
 * - Used ONLY for:
 *   - Conversational continuity
 *   - Immediate intent tracking
 *   - Recent system state
 */

export type MemoryItem = {
  id: string;
  content: string;
  priority: number; // 0-1 float, higher = more important
  timestamp: number; // Unix timestamp ms
  ttl: number; // Time-to-live in ms
  category: "user_input" | "system_state" | "intent" | "context";
  metadata?: Record<string, unknown>;
};

export type ShortTermMemoryConfig = {
  maxSize: number;
  defaultTtl: number; // ms
  defaultPriority: number;
};

const DEFAULT_CONFIG: ShortTermMemoryConfig = {
  maxSize: 20,
  defaultTtl: 5 * 60 * 1000, // 5 minutes
  defaultPriority: 0.5,
};

/**
 * Short-term memory implemented as a priority queue with TTL eviction.
 *
 * Eviction policy:
 * 1. Expired TTL items are removed first
 * 2. Then lowest priority items
 *
 * System 1 must NEVER store long-term facts here.
 */
export class ShortTermMemory {
  private items: Map<string, MemoryItem> = new Map();
  private config: ShortTermMemoryConfig;
  private idCounter = 0;

  constructor(config: Partial<ShortTermMemoryConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Add an item to short-term memory.
   * Triggers eviction if memory is full.
   */
  add(params: {
    content: string;
    category: MemoryItem["category"];
    priority?: number;
    ttl?: number;
    metadata?: Record<string, unknown>;
  }): MemoryItem {
    // First, evict expired items
    this.evictExpired();

    // If still at capacity, evict lowest priority
    while (this.items.size >= this.config.maxSize) {
      this.evictLowestPriority();
    }

    const id = `mem_${Date.now()}_${++this.idCounter}`;
    const item: MemoryItem = {
      id,
      content: params.content,
      priority: params.priority ?? this.config.defaultPriority,
      timestamp: Date.now(),
      ttl: params.ttl ?? this.config.defaultTtl,
      category: params.category,
      metadata: params.metadata,
    };

    this.items.set(id, item);
    return item;
  }

  /**
   * Get all non-expired items, sorted by priority (descending).
   */
  getAll(): MemoryItem[] {
    this.evictExpired();
    return Array.from(this.items.values()).sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get items by category, sorted by priority.
   */
  getByCategory(category: MemoryItem["category"]): MemoryItem[] {
    return this.getAll().filter((item) => item.category === category);
  }

  /**
   * Get the most recent N items.
   */
  getRecent(count: number): MemoryItem[] {
    return this.getAll()
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, count);
  }

  /**
   * Get a specific item by ID.
   */
  get(id: string): MemoryItem | undefined {
    const item = this.items.get(id);
    if (item && this.isExpired(item)) {
      this.items.delete(id);
      return undefined;
    }
    return item;
  }

  /**
   * Update an item's priority (e.g., to boost importance).
   */
  updatePriority(id: string, priority: number): boolean {
    const item = this.items.get(id);
    if (!item || this.isExpired(item)) {
      return false;
    }
    item.priority = Math.max(0, Math.min(1, priority));
    return true;
  }

  /**
   * Extend an item's TTL.
   */
  extendTtl(id: string, additionalMs: number): boolean {
    const item = this.items.get(id);
    if (!item || this.isExpired(item)) {
      return false;
    }
    item.ttl += additionalMs;
    return true;
  }

  /**
   * Remove a specific item.
   */
  remove(id: string): boolean {
    return this.items.delete(id);
  }

  /**
   * Clear all items.
   */
  clear(): void {
    this.items.clear();
  }

  /**
   * Get current memory size.
   */
  get size(): number {
    this.evictExpired();
    return this.items.size;
  }

  /**
   * Build a context string for LLM consumption.
   * Returns recent, high-priority items formatted as context.
   */
  buildContextString(maxItems = 10): string {
    const items = this.getRecent(maxItems);
    if (items.length === 0) {
      return "";
    }

    const lines = items.map((item) => {
      const age = Math.floor((Date.now() - item.timestamp) / 1000);
      const ageStr = age < 60 ? `${age}s ago` : `${Math.floor(age / 60)}m ago`;
      return `[${item.category}] (${ageStr}, p=${item.priority.toFixed(2)}): ${item.content}`;
    });

    return lines.join("\n");
  }

  /**
   * Track a user message for continuity.
   */
  trackUserMessage(content: string, metadata?: Record<string, unknown>): MemoryItem {
    return this.add({
      content,
      category: "user_input",
      priority: 0.7, // User messages are fairly important
      ttl: 3 * 60 * 1000, // 3 minutes
      metadata,
    });
  }

  /**
   * Track current user intent.
   */
  trackIntent(intent: string, confidence: number): MemoryItem {
    // Remove old intent items (only keep most recent intent)
    for (const item of this.getByCategory("intent")) {
      this.remove(item.id);
    }
    return this.add({
      content: intent,
      category: "intent",
      priority: Math.max(0.5, confidence),
      ttl: 2 * 60 * 1000, // 2 minutes
      metadata: { confidence },
    });
  }

  /**
   * Track System 2 state for observation.
   */
  trackSystemState(state: string, taskId?: string): MemoryItem {
    return this.add({
      content: state,
      category: "system_state",
      priority: 0.6,
      ttl: 5 * 60 * 1000, // 5 minutes
      metadata: taskId ? { taskId } : undefined,
    });
  }

  /**
   * Add contextual information.
   */
  addContext(content: string, priority = 0.5): MemoryItem {
    return this.add({
      content,
      category: "context",
      priority,
      ttl: this.config.defaultTtl,
    });
  }

  // --- Private helpers ---

  private isExpired(item: MemoryItem): boolean {
    return Date.now() > item.timestamp + item.ttl;
  }

  private evictExpired(): void {
    for (const [id, item] of this.items) {
      if (this.isExpired(item)) {
        this.items.delete(id);
      }
    }
  }

  private evictLowestPriority(): void {
    let lowestId: string | null = null;
    let lowestPriority = Infinity;
    let oldestTimestamp = Infinity;

    for (const [id, item] of this.items) {
      // Prefer evicting by priority, then by age
      if (
        item.priority < lowestPriority ||
        (item.priority === lowestPriority && item.timestamp < oldestTimestamp)
      ) {
        lowestPriority = item.priority;
        oldestTimestamp = item.timestamp;
        lowestId = id;
      }
    }

    if (lowestId) {
      this.items.delete(lowestId);
    }
  }
}
