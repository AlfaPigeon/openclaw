# Dual-System Agent Architecture

A production-ready dual-system agent architecture for OpenClaw that separates fast user-facing responses (System 1) from deliberate agentic reasoning (System 2).

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              USER                                        │
│                                │                                         │
│                                ▼                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                    SYSTEM 1 (phi-mini)                            │  │
│  │                    Fast Layer - User-Facing                        │  │
│  │                                                                    │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │  │
│  │  │ Short-Term  │  │  Decision    │  │  Task Dispatcher         │  │  │
│  │  │ Memory      │  │  Classifier  │  │  (Event Interface)       │  │  │
│  │  │ (Priority Q)│  │              │  │                          │  │  │
│  │  └─────────────┘  └──────────────┘  └──────────────────────────┘  │  │
│  │         │               │                    │        ▲            │  │
│  │         │               │                    │        │            │  │
│  │         └───────────────┴────────────────────┼────────┤            │  │
│  │                                              │        │            │  │
│  └──────────────────────────────────────────────┼────────┼────────────┘  │
│                                                 │        │               │
│                         Task Dispatch           │        │ State Events  │
│                         ────────────────────────▼        │               │
│  ┌───────────────────────────────────────────────────────┴────────────┐  │
│  │                    SYSTEM 2 (OpenClaw)                             │  │
│  │                    Agentic Layer - Reasoning                        │  │
│  │                                                                    │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │  │
│  │  │ Long-Term   │  │  Tool        │  │  Multi-Step              │  │  │
│  │  │ Memory      │  │  Execution   │  │  Reasoning               │  │  │
│  │  │ (Vector DB) │  │              │  │                          │  │  │
│  │  └─────────────┘  └──────────────┘  └──────────────────────────┘  │  │
│  │                                                                    │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## System 1 (Fast Layer)

### Responsibilities

1. **Immediate Response**: Respond to every user input within milliseconds
2. **Classification**: Decide whether to handle locally or delegate
3. **Short-Term Memory**: Maintain conversational continuity
4. **State Tracking**: Observe System 2 execution state
5. **Proactive Messaging**: Notify user of System 2 state changes

### Constraints

- **CANNOT** execute tools
- **CANNOT** write long-term memory
- **CANNOT** mutate external systems
- **CAN** respond immediately
- **CAN** observe System 2 state
- **CAN** send instructions to System 2

### Short-Term Memory

Implemented as a priority queue (NOT a vector database):

```typescript
type MemoryItem = {
  id: string;
  content: string;
  priority: number;    // 0-1 float
  timestamp: number;   // Unix ms
  ttl: number;         // Time-to-live ms
  category: 'user_input' | 'system_state' | 'intent' | 'context';
};
```

**Eviction Policy:**
1. Expired TTL items first
2. Then lowest priority items

### Decision Classification

System 1 classifies each input into exactly ONE of:

| Decision | Description | Example |
|----------|-------------|---------|
| `RESPOND_ONLY` | Simple Q&A, no tools needed | "Hello", "Thanks", "What's 2+2?" |
| `DELEGATE_TO_SYSTEM_2` | Background task, no immediate response | "When you can, clean up my downloads" |
| `RESPOND_AND_DELEGATE` | Acknowledge and delegate | "Create a React component for..." |

## System 2 (Agentic Layer)

### Responsibilities

- **ONLY** system that executes tools
- **ONLY** system that accesses long-term memory
- Multi-step reasoning and planning
- Deliberate, slow, correct processing

### Output Format

System 2 MUST emit structured JSON events:

```json
{
  "task_id": "uuid",
  "state": "STARTED|PROGRESS|WAITING|DONE|FAILED",
  "message": "concise, factual, no fluff",
  "requires_user_input": false
}
```

### Execution Flow

For every task:

```
1. Emit STARTED
2. Plan internally
3. Execute tools as needed
4. Periodically emit PROGRESS
5. If blocked → emit WAITING (requires_user_input: true)
6. On completion → emit DONE with result
7. On failure → emit FAILED with error + recovery steps
```

## Communication Protocol

### System 1 → System 2 (Task Dispatch)

```json
{
  "task_id": "uuid",
  "intent": "string describing what to do",
  "constraints": { "key": "value" },
  "context": { "recentMemory": [...] },
  "priority": "low|normal|high"
}
```

### System 2 → System 1 (State Events)

```json
{
  "task_id": "uuid",
  "state": "STARTED|PROGRESS|WAITING|DONE|FAILED",
  "message": "what happened",
  "requires_user_input": false,
  "result": { ... },           // DONE only
  "error": "what went wrong",  // FAILED only
  "recovery_steps": [...]      // FAILED only
}
```

## Message Flow Example

```
User: "Create a Python script that fetches weather data"

┌──────────────────────────────────────────────────────────────────────┐
│ SYSTEM 1                                                              │
│                                                                       │
│ 1. Receive input                                                      │
│ 2. Track in short-term memory                                         │
│ 3. Classify → RESPOND_AND_DELEGATE (complexity: 0.75)                │
│ 4. Generate acknowledgment: "Got it! Creating that script now..."    │
│ 5. Dispatch task to System 2                                          │
│                                                                       │
│ → Immediate Response: "Got it! Creating that script now..."          │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│ SYSTEM 2                                                              │
│                                                                       │
│ 1. Receive dispatch                                                   │
│ 2. Emit STARTED                                                       │
│ 3. Plan: need to create file, write Python code                      │
│ 4. Execute write tool                                                 │
│ 5. Emit PROGRESS: "Created weather_fetcher.py"                       │
│ 6. Emit DONE: "Script created at weather_fetcher.py"                 │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│ SYSTEM 1                                                              │
│                                                                       │
│ 1. Receive DONE event                                                 │
│ 2. Track state in memory                                              │
│ 3. Decide to notify user                                              │
│ 4. Format user-friendly message                                       │
│                                                                       │
│ → Proactive Response: "Done! Created weather_fetcher.py for you."    │
└──────────────────────────────────────────────────────────────────────┘
```

## Usage

### Basic Usage

```typescript
import { DualSystemOrchestrator } from '@openclaw/dual-system';

const orchestrator = new DualSystemOrchestrator({
  memoryMaxSize: 20,
  complexityThreshold: 0.4,
  llmInvoke: async (prompt) => {
    // Your phi-mini invocation here
    return await phiMini.generate(prompt);
  },
  system2Invoke: async (dispatch) => {
    // Route to OpenClaw
    await openclaw.runTask(dispatch);
  },
  onNotifyUser: (notification) => {
    // Push to user
    sendToUser(notification.message);
  },
});

// Process user input
const result = await orchestrator.processInput("Create a weather app");
console.log(result.immediateResponse); // "Got it! Working on that..."
console.log(result.delegated);          // true
console.log(result.taskId);             // "abc123..."
```

### Via OpenClaw Tool

```bash
# Process input through System 1
openclaw invoke dual-system --action process --input "Hello there!"

# Check system status
openclaw invoke dual-system --action status

# Build System 2 prompt
openclaw invoke dual-system --action build-system2-prompt \
  --taskId "task_123" \
  --intent "Create a weather fetching script"
```

## Configuration

```yaml
# openclaw.yaml
dual-system:
  memoryMaxSize: 20
  memoryDefaultTtl: 300000  # 5 minutes
  complexityThreshold: 0.4
  useLlmClassification: false
  system1Provider: "ollama"
  system1Model: "phi-mini"
```

## Non-Negotiable Constraints

| Rule | Enforcement |
|------|-------------|
| System 1 CANNOT execute tools | Not exposed to System 1 |
| System 1 CANNOT write long-term memory | No memory write API |
| System 2 CANNOT speak directly to user | Output format validation |
| ALL user messages through System 1 | Architecture design |
| Clear separation of concerns | Module boundaries |

## Integration with OpenClaw

The System 2 prompt template is designed to work with OpenClaw's existing agent infrastructure:

1. System 1 creates a task dispatch
2. The dispatch is converted to a System 2 prompt via `buildSystem2Prompt()`
3. OpenClaw runs the agent with the prompt
4. Agent outputs are parsed for state events
5. Events are routed back to System 1 via `TaskDispatcher`

## Files

| File | Description |
|------|-------------|
| `short-term-memory.ts` | Priority queue memory implementation |
| `decision-classifier.ts` | Input classification logic |
| `task-dispatcher.ts` | System 1 ↔ System 2 communication |
| `orchestrator.ts` | Main System 1 orchestrator |
| `system2-prompt.ts` | System 2 prompt templates |
| `dual-system-tool.ts` | OpenClaw tool integration |

## License

MIT
