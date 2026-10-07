export type SessionState =
  | 'blocked'    // waiting for permission or question approval (highest attention)
  | 'needs_you'  // turn finished, waiting for next prompt
  | 'working'    // agent processing, thinking, or running tool
  | 'parked'     // idle, but git repo has uncommitted/unpushed work
  | 'quiet'      // idle, git repo is completely clean
  | 'crashed'    // subprocess exited abnormally
  | 'snoozed';   // temporarily hidden until snooze timestamp

export interface SlashCommandItem {
  command: string;
  label: string;
  description: string;
  category: 'agent' | 'terminal';
  hint?: string;
  icon?: string;
  actionType?: 'insert' | 'immediate';
  agentIds?: string[];
}

export interface AgentDescriptor {
  id: string;
  name: string;
  provider: 'anthropic' | 'openai' | 'google' | 'custom' | 'mock';
  description: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  icon: string;
  defaultModel?: string;
  availableModels?: string[];
  slashCommands?: SlashCommandItem[];
  /** MCP transports the agent takes in `session/new`; empty when it can't take any. */
  /** `via: 'agy-settings'`: the agent reads MCP servers from its own settings file, which CodePit keeps in step. */
  mcpSupport?: { transports: McpTransport[]; note?: string; via?: 'agy-settings' };
  /** Effort levels to offer before the agent has reported its own; empty when it has no effort setting. */
  efforts?: ConfigChoice[];
  /** Ask the agent to run each subagent in a session of its own (AIR nativeSubagentSessions), so its work streams live. */
  nativeSubagentSessions?: boolean;
  /**
   * Env var holding a JSON config the agent merges at launch (Codex: CODEX_CONFIG). The model
   * goes in there as `model`, since set_config_option only takes the models the agent lists.
   */
  modelConfigEnv?: string;
  /** What the agent last advertised per model (from the options cache), keyed by model id. */
  advertised?: Record<string, AgentOptions>;
}

/** One value of an agent's select-style config option (ACP SessionConfigSelectOption). */
export interface ConfigChoice {
  value: string;
  label: string;
  description?: string;
  /** An approval mode's kind (ACP `_meta.kind`): standard, plan, auto_review or full_access. */
  kind?: string;
  /** A model this app first saw the agent offer in the last two weeks. */
  isNew?: boolean;
}

/** A slash command or skill the agent offers (ACP available_commands_update). */
export interface AgentCommand {
  name: string;
  description: string;
  /** What to type after it, e.g. "[pr-number]". */
  hint?: string;
}

/**
 * The effort and model choices a running agent advertised through ACP
 * `configOptions` (session/new, set_config_option, config_option_update).
 */
export interface AgentOptions {
  /** The config option id that carries effort ('effort' for Claude, 'reasoning_effort' for Codex). */
  effortConfigId?: string;
  /** Effort levels the current model accepts, without the agent's own "default" row. */
  efforts: ConfigChoice[];
  /** The agent's own "default" effort row, which 'auto' maps to. */
  effortDefaultValue?: string;
  /** The level the agent recommends, when it says (Codex does). */
  recommendedEffort?: string;
  currentEffort?: string;
  modelConfigId?: string;
  models: ConfigChoice[];
  currentModel?: string;
  /** The agent's approval modes (ACP `mode` option), e.g. Claude's Manual, Accept edits, Auto. */
  modeConfigId?: string;
  modes?: ConfigChoice[];
  currentMode?: string;
  /** Fast mode, when the current model offers it (Claude's `fast` option, an on/off select). */
  fast?: { configId: string; enabled: boolean; onValue: string; offValue: string; description?: string };
  updatedAt: number;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind?: 'allow_once' | 'allow_always' | 'deny' | string;
}

export interface PendingPermission {
  requestId: string;
  toolCallId: string;
  title: string;
  /** The subagent asking, when it is not the main agent. */
  subagent?: string;
  options: PermissionOption[];
  rawParams?: unknown;
  requestedAt: number;
}

/** A value the user gave in a form field: text or a choice, a number, a yes/no, or several choices. */
export type ElicitationValue = string | number | boolean | string[];

/** One choice of a single- or multi-select field. */
export interface ElicitationOption {
  /** What is sent back when it is picked (the schema's `const` or enum value). */
  value: string;
  title: string;
  description?: string;
  /** Extra content shown when the option has focus (Claude's AskUserQuestion `preview`, often markdown). */
  preview?: string;
}

/**
 * One field of a form the agent asked for (ACP elicitation/create, mode "form"), flattened from
 * its JSON Schema property. A string field with `options` is a single select; an array field is
 * a multi-select and always has `options`.
 */
export interface ElicitationField {
  /** The property name; the answer goes under it. */
  key: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  title?: string;
  description?: string;
  required: boolean;
  default?: ElicitationValue;
  options?: ElicitationOption[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: 'email' | 'uri' | 'date' | 'date-time';
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  /**
   * Set on the free-text "Other" box that belongs to another field (Claude's and Codex's
   * AskUserQuestion): the key of that field. Show it with that question, not on its own.
   */
  customAnswerFor?: string;
  /** The answer is a secret (Codex `isSecret`): mask it while typing. */
  secret?: boolean;
}

/** A form the agent is waiting for the user to fill in, or to skip. */
export interface PendingElicitation {
  requestId: string;
  /** The tool call whose card records the question and answer in the conversation. */
  toolCallId: string;
  message: string;
  /** The subagent asking, when it is not the main agent. */
  subagent?: string;
  fields: ElicitationField[];
  requestedAt: number;
}

/** What was asked and how it was answered, kept on the tool call that asked it. */
export interface ElicitationRecord {
  requestId: string;
  message: string;
  fields: ElicitationField[];
  /** accepted: submitted with `content`; declined: skipped; cancelled: withdrawn or stopped. */
  status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  content?: Record<string, ElicitationValue>;
  requestedAt: number;
  resolvedAt?: number;
}

export type ElicitationAction = 'accept' | 'decline' | 'cancel';

export interface ToolCallRecord {
  id: string;
  title: string;
  kind?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  input?: unknown;
  output?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
  /** Agent-side tool name (e.g. Bash, Read, Agent), from _meta.claudeCode.toolName or ACP `name`. */
  toolName?: string;
  /** Human description of the call when the agent gives one (e.g. Bash `description`). */
  description?: string;
  /** Set on calls made by a subagent: the id of the tool call that spawned it. */
  parentToolUseId?: string;
  /** True when this call spawns a subagent (Claude's Agent/Task tool). */
  isSubagent?: boolean;
  subagentType?: string;
  /** Text the subagent streamed back, kept out of the main conversation. */
  subagentText?: string;
  /** Shell exit code, from ACP terminal_exit meta. */
  exitCode?: number | null;
  /** The command keeps running after the call returns (background shell, async agent). */
  background?: boolean;
  /** Lifecycle of that background work; absent means still running (or never reported). */
  backgroundState?: BackgroundState;
  /** How the background work ended, e.g. the agent's summary or why it was cut off. */
  backgroundSummary?: string;
  backgroundEndedAt?: number;
  /** Set on calls made inside a subagent or workflow: the id of that AgentTask. */
  agentTaskId?: string;
  /** What a finished subagent reported using (Claude's Agent tool response). */
  agentUsage?: AgentTask['usage'];
  /** An async subagent's transcript file (Claude's Agent tool response `outputFile`). */
  agentOutputFile?: string;
  /** What the agent said about the subagent or workflow this call launched (ids, model, transcript). */
  agentRef?: Omit<TaskAudit, 'agentId' | 'agentName' | 'model' | 'agentSessionId'>;
  /** A form the agent asked the user to fill in during this call, and the answer. */
  elicitation?: ElicitationRecord;
}

/**
 * The chronological parts of an agent turn. Agents interleave several messages
 * with tool calls in one turn; keeping the order lets the UI show them as
 * separate messages instead of one merged blob.
 */
export type TurnSegment =
  | { kind: 'text'; id: string; text: string; messageId?: string }
  | { kind: 'thought'; id: string; text: string }
  | { kind: 'tool'; id: string; toolCallId: string };

export interface PlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'high' | 'medium' | 'low';
}

export interface FileAttachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  path?: string;
  url?: string;
  data?: string;
  isImage?: boolean;
}

export interface TurnMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  content?: string;
  thoughts?: string;
  attachments?: FileAttachment[];
  toolCalls?: ToolCallRecord[];
  segments?: TurnSegment[];
  timestamp: number;
  agentId?: string;
  agentName?: string;
  model?: string;
  /** Set on the system turn that marks a context compaction; turns before it are what was compacted. */
  compaction?: CompactionRecord;
  /** Claude keywords CodePit added to a user message it sent (ultrathink, ultracode). */
  keywords?: string[];
}

/**
 * A context compaction. 'native' runs the agent's own /compact in the same agent
 * session; 'handoff' asks the agent for a handoff summary, restarts it, and sends
 * the summary as the first context of the next prompt.
 */
export interface CompactionRecord {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  method: 'native' | 'handoff';
  /** 'auto' is "Compact when finished"; 'agent' is the agent compacting on its own mid-turn. */
  trigger: 'manual' | 'auto' | 'agent';
  startedAt: number;
  endedAt?: number;
  /** Context tokens before and after, when known. */
  preTokens?: number;
  postTokens?: number;
  /** postTokens is a rough count of the handoff summary, not a figure the agent reported. */
  postTokensEstimated?: boolean;
  summary?: string;
  error?: string;
}

/** "Compact when finished": compact after a clean turn once context use passes the threshold. */
export interface AutoCompactSetting {
  enabled: boolean;
  /** Percent of the context window, e.g. 50. */
  thresholdPercent: number;
}

export interface GitInfo {
  branch: string;
  uncommittedFiles: number;
  unpushedCommits: number;
  isClean: boolean;
  repoRoot: string;
}

export interface TokenUsage {
  /** Lifetime totals, summed from what each turn reports: input includes prompt-cache writes */
  inputTokens: number;
  outputTokens: number;
  /** Lifetime prompt-cache reads */
  cachedTokens: number;
  /** What the context holds now; drops after a compaction or an agent switch */
  contextTokens: number;
  /** Set once the totals are summed per turn. Older sessions stored the context size as input. */
  lifetime?: boolean;
}

export interface UserAnnotations {
  priority: 'p0' | 'p1' | 'p2' | null;
  pinned: boolean;
  snoozedUntil: number | null;
  tags: string[];
  cleanup: boolean;
  note?: string;
  autoApprove?: boolean;
}

/**
 * 'auto' leaves the choice to the agent (the model's own default); any other value
 * is one the agent advertised for the current model, e.g. 'xhigh' or 'max'.
 */
export type ThinkingEffort = string;
export const AUTO_EFFORT = 'auto';
export type ContextTransferMode = 'compact' | 'full' | 'none';

export interface RateLimitWindow {
  utilization: number;
  resetsAt?: string | null;
  /** The same reset as an epoch time, when it is known exactly. */
  resetsAtMs?: number;
}

export interface SessionRateLimits {
  fiveHour?: RateLimitWindow | null;
  weeklyAll?: RateLimitWindow | null;
  weeklyModels?: Array<{ name: string; utilization: number; resetsAt?: string | null }>;
  updatedAt?: number;
}

/** One agent session (the agent's own conversation) behind a CodePit session. */
export interface AgentSessionRecord {
  /** The agent's session id: for Claude the Claude Code session, for Codex the thread. */
  id: string;
  agentId: string;
  agentName: string;
  model?: string;
  startedAt: number;
  /** When it was last started or continued; equals startedAt until it is resumed. */
  lastStartedAt: number;
  /** How many times it was continued after a restart or a stop. */
  resumes: number;
  endedAt?: number;
  endReason?: string;
  /** Why continuing the previous session failed, when this one replaced it. */
  replacedBecause?: string;
  /** The agent's own transcript on this machine, when known. */
  transcriptPath?: string;
}

/** An agent session set aside when the conversation switched to another agent. */
export interface ParkedAgentResume {
  agentId: string;
  agentName: string;
  sessionId: string;
  cwd: string;
  savedAt: number;
  parkedAt: number;
  model?: string;
  lastSeenTurnId?: string;
}

export interface AcpSession {
  id: string;
  agentId: string;
  agentName: string;
  title: string;
  titleSource: 'user' | 'agent' | 'auto';
  cwd: string;
  startedAt: number;
  updatedAt: number;
  state: SessionState;
  score: number;
  reasons: string[];
  /** The score's parts in plain language, and one sentence on why it sits where it does. */
  rankFactors?: Array<{ label: string; points: number }>;
  rankSummary?: string;
  lastPrompt: string;
  recap: string;
  usage: TokenUsage;
  git: GitInfo | null;
  user: UserAnnotations;
  pendingPermission: PendingPermission | null;
  /** A form the agent is waiting on (e.g. Claude's AskUserQuestion); absent on older sessions. */
  pendingElicitation?: PendingElicitation | null;
  turns: TurnMessage[];
  model?: string;
  effort?: ThinkingEffort;
  /** The approval mode chosen here (an agentOptions.modes value), applied when the agent starts. */
  mode?: string;
  /** Fast mode chosen here, applied when the agent starts. */
  fastMode?: boolean;
  /** The slash commands and skills the agent last reported. */
  agentCommands?: AgentCommand[];
  /** The running agent's own session id (for Claude, its Claude Code session). */
  agentSessionId?: string;
  /** The agent session to continue on the next start (ACP session/resume); absent means start fresh. */
  agentResume?: { agentId: string; sessionId: string; cwd: string; savedAt: number };
  /**
   * Other agents' sessions set aside by a switch to another agent, at most one per agent:
   * switching back to that agent (same folder) continues it and catches it up on what it
   * missed. `lastSeenTurnId` is the last turn it saw (absent when it saw none).
   */
  parkedAgentResumes?: ParkedAgentResume[];
  /**
   * The continued agent session saw the conversation up to and including this turn ('' for
   * none): its handoff is only the turns since. Cleared once that handoff is sent.
   */
  catchUpAfterTurnId?: string;
  /** Every agent session that has served this conversation, oldest first. */
  agentSessions?: AgentSessionRecord[];
  /**
   * Never pick up an older Claude session found on disk for this conversation: set once the
   * user cleared the context, set the agent session aside, or rewound the conversation.
   */
  skipClaudeAdoption?: boolean;
  /** Turns before this index are not handed to a new agent session ("Clean slate"). */
  contextStartIndex?: number;
  /** Claude's ultracode: multi-agent workflow orchestration on every message, at xhigh effort. */
  ultracode?: boolean;
  /** Claude's ultrathink on the next message only. */
  ultrathinkNext?: boolean;
  contextMode?: ContextTransferMode;
  contextHandoffPending?: boolean;
  failoverFromId?: string; // Tracks previous session if failed over from another agent
  activeTerminalId?: string;
  promptSuggestion?: string;
  rateLimits?: SessionRateLimits;
  isAgentRunning?: boolean;
  /** The running agent can take a message into a turn in progress (ACP steering). */
  canSteer?: boolean;
  agentStopped?: boolean; // Set by an explicit Stop; ranks the session 'parked' until restarted
  agentLive?: AgentLiveMark;
  restore?: RestoreOffer;
  /** The agent's latest todo list (ACP `plan` update). */
  plan?: PlanEntry[];
  /** App-level MCP servers handed to the agent when it last started. */
  mcp?: SessionMcpInfo;
  /** Messages sent while a turn was running; the next one goes out when a turn ends cleanly. */
  queuedPrompts?: QueuedPrompt[];
  /** Subagents, background tasks and workflows the agent launched, oldest first. */
  agentTasks?: AgentTask[];
  /** Effort and model choices the agent advertised when it last ran. */
  agentOptions?: AgentOptions;
  /** Context window the agent reported (ACP usage_update.size); the model table is only a fallback. */
  contextWindow?: number;
  /** "Compact when finished" for this session. */
  autoCompact?: AutoCompactSetting;
  /** When the agent last finished a turn: the prompt cache was last written then. */
  lastTurnEndedAt?: number;
  /** When the user last had this session open; a turn that ended after it is unseen. */
  seenAt?: number;
  /** A message to send later: after the usage limit resets, or when a pause ends. */
  scheduledResume?: ScheduledResume | null;
  /** Limit resumes in a row that hit the limit again soon after; reset by a turn that ends cleanly. */
  limitResumeStreak?: number;
  /** When the last limit resume was sent, until its turn ends. */
  limitResumeSentAt?: number;
}

/** An agent process this run of CodePit started and has not stopped: on disk while it runs, so a crash leaves it behind. */
export interface AgentLiveMark {
  since: number;
  /** The CodePit process that owns it; another live CodePit on the same data dir keeps its own. */
  pid: number;
  /** When that process started and when the machine booted (ms): a reused pid is not that process. */
  started?: number;
  boot?: number;
}

/** The agent was running when CodePit last closed (quit, crash or update); offered back, never restarted on its own. */
export interface RestoreOffer {
  /** When that agent process started. */
  runningSince: number;
  /** When this run of CodePit found it. */
  foundAt: number;
  /** A turn was in progress; it is not sent again. */
  turnInterrupted: boolean;
  /** Restoring continues the same agent session; false: a new one, handed a summary. */
  continues: boolean;
  /** Why the last restore failed; the offer stays so it can be retried or dismissed. */
  error?: string;
}

/** What happens when Claude stops a turn on its 5-hour usage limit. */
export type LimitResumeMode = 'off' | 'ask' | 'auto';

/**
 * A message the session sends by itself later: after Claude's 5-hour limit resets, or at a
 * time the user picked when pausing it. Cleared when it is sent, cancelled, or the user
 * sends a message of their own.
 */
export interface ScheduledResume {
  reason: 'limit' | 'manual';
  /** When it is sent. Absent only for a limit whose reset time is not known. */
  at?: number;
  /** False while it waits for the user to agree (limit, "Ask"): nothing is sent until then. */
  armed: boolean;
  /** What is sent. */
  prompt: string;
  createdAt: number;
  /** limit: what Claude said, e.g. "You've hit your session limit · resets 3:40pm". */
  limitMessage?: string;
  /** limit: when the 5-hour window resets. */
  resetsAt?: number;
  /** Why the last attempt to send it failed, or why it was not armed. */
  note?: string;
}

export interface QueuedPrompt {
  id: string;
  text: string;
  attachments?: FileAttachment[];
  queuedAt: number;
}

export interface SessionSummary {
  id: string;
  agentId: string;
  agentName: string;
  title: string;
  model?: string;
  effort?: ThinkingEffort;
  cwd: string;
  startedAt: number;
  updatedAt: number;
  state: SessionState;
  score: number;
  reasons: string[];
  /** The score's parts in plain language, and one sentence on why it sits where it does. */
  rankFactors?: Array<{ label: string; points: number }>;
  rankSummary?: string;
  lastPrompt: string;
  recap: string;
  git: GitInfo | null;
  user: UserAnnotations;
  hasPendingPermission: boolean;
  pendingPermissionTitle?: string;
  /** The agent is waiting for the user to answer a form; the title is the form's message, on one line. */
  hasPendingElicitation: boolean;
  pendingElicitationTitle?: string;
  tokenCount: number;
  turnCount: number;
  isAgentRunning?: boolean;
  restore?: RestoreOffer;
  /** A restore is starting this session's agent now. */
  restoring?: boolean;
  /** A compaction is running (started here or by the agent). */
  compacting?: boolean;
  /** The turn ended but subagents, workflows or background commands it started still run. */
  workingInBackground?: boolean;
  titleSource: AcpSession['titleSource'];
  /** What the context holds now, and the window the agent reported (absent: use the model table). */
  contextTokens: number;
  contextWindow?: number;
  lastTurnEndedAt?: number;
  seenAt?: number;
  /**
   * When the agent's prompt cache is expected to lapse, for agents whose cache lifetime is
   * known (Claude: 1 hour on a subscription, 5 minutes on an API key). An estimate: no
   * agent reports it.
   */
  cacheExpiresAt?: number;
  scheduledResume?: ScheduledResume | null;
}

// ------------------------------------------------------------------ MCP

export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  /** 'all', or the one agent id the server is limited to. */
  scope: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  presetId?: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

/** McpServerConfig as sent to the browser, with secret values masked. */
export type McpServerView = McpServerConfig & {
  /** A memory MCP server whose knowledge graph CodePit can show. */
  memoryGraph?: boolean;
};

export interface MemoryGraphObservation {
  /** Stamp time as written, e.g. "2026-10-02 00:45"; empty when unstamped. */
  ts: string;
  repo: string;
  /** Session name and id from the stamp. */
  name: string;
  id: string;
  text: string;
}

export interface MemoryGraphEntity {
  name: string;
  /** entityType, e.g. decision or action-item. */
  type: string;
  /** From the latest `status=` observation; empty when there is none. */
  status: string;
  repo: string;
  /** Second segment of Task:<Domain>:<slug>, else the first segment of the name. */
  domain: string;
  observations: MemoryGraphObservation[];
}

export interface MemoryGraphRelation {
  from: string;
  to: string;
  type: string;
}

export interface MemoryGraph {
  file: string;
  exists: boolean;
  /** Size and mtime; send it back as `since` to get `unchanged` until the file changes. */
  version: string;
  modified: number | null;
  entities: MemoryGraphEntity[];
  relations: MemoryGraphRelation[];
  /** Lines that were not entity or relation rows. */
  skipped: number;
}

export type McpServerInput = Partial<Omit<McpServerConfig, 'id' | 'createdAt' | 'updatedAt'>>;

export interface SessionMcpInfo {
  attached: string[];
  skipped: Array<{ name: string; reason: string }>;
}

export type BackgroundState = 'running' | 'completed' | 'failed' | 'stopped';

/** An AIR `async_task_*` session update (background shell, workflow, monitor). */
export interface AsyncTaskUpdate {
  kind: 'spawned' | 'progress' | 'state';
  asyncTaskId: string;
  toolCallId?: string;
  state?: BackgroundState;
  summary?: string;
  name?: string;
  /** File the agent writes the task's output to. */
  outputFilePath?: string;
  /** shell, workflow, monitor or task (spawned only). */
  taskType?: string;
  description?: string;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
}

// ------------------------------------------------------------ Agent tasks

export type AgentTaskKind = 'subagent' | 'background' | 'workflow';
export type AgentTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

/**
 * Work the session's agent handed off: a subagent (Claude's Agent/Task tool),
 * a background shell or monitor, or a workflow run. The tool calls and
 * messages it produced are tagged with its id so it can be viewed on its own.
 */
/**
 * Where an agent task came from. The session fields are stamped when the task is first
 * seen, so a later agent switch or restart does not rewrite them.
 */
export interface TaskAudit {
  /** The CodePit agent (e.g. "claude") and its name, and the session's model at the time. */
  agentId?: string;
  agentName?: string;
  model?: string;
  /** The agent's own session id; for Claude, the Claude Code session whose transcript holds this work. */
  agentSessionId?: string;
  /** The subagent's own id and the model it ran on, as the agent reports them. */
  subagentId?: string;
  subagentModel?: string;
  /** A workflow's run id and script. */
  runId?: string;
  scriptPath?: string;
  /** Its transcript on this machine: a subagent's .jsonl, or a workflow's transcript folder. */
  transcriptPath?: string;
  worktreePath?: string;
  worktreeBranch?: string;
}

export interface AgentTask {
  /** The spawning tool call's id, or `task:<asyncTaskId>` when there is none. */
  id: string;
  kind: AgentTaskKind;
  title: string;
  /** The task given to it: a subagent's prompt, a command, a workflow description. */
  prompt?: string;
  /** Subagent type (e.g. Explore), or the background task type (shell, monitor, workflow). */
  agentType?: string;
  status: AgentTaskStatus;
  startedAt: number;
  endedAt?: number;
  /** The tool call that launched it. */
  toolCallId?: string;
  /** The AIR async task id, for background work and workflows. */
  asyncTaskId?: string;
  /** The task it was launched from, when a subagent launches another. */
  parentTaskId?: string;
  /** How it ended, or why it was cut off. */
  summary?: string;
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
  /** Who ran it, for audit: recorded when the agent reported it and kept as it was. */
  audit?: TaskAudit;
  /** Its own messages, reasoning and tool calls in the order they happened. */
  segments?: TurnSegment[];
}

// ------------------------------------------------------------ Workflow runs

/**
 * One agent inside a Claude workflow run. ACP only reports the run's totals, so
 * this is read from the run's folder on disk (journal and per-agent transcript).
 */
export interface WorkflowAgentInfo {
  /** Claude's agent id (agent-<id>.jsonl). */
  id: string;
  /** The label the script gave it, e.g. "research:hdmi-cec". */
  label: string;
  phase?: string;
  status: AgentTaskStatus;
  startedAt?: number;
  /** Time of its last transcript entry; the end time once it is not running. */
  lastActivityAt?: number;
  toolUses: number;
  outputTokens: number;
  model?: string;
  /** The tool it called last, while it runs. */
  lastTool?: string;
  /** The first line of what it last said. */
  lastText?: string;
}

export interface WorkflowPhaseInfo {
  title: string;
  detail?: string;
}

export interface WorkflowRunInfo {
  runId?: string;
  name?: string;
  description?: string;
  /** Phases from the script's meta block, then any phase only the agents name. */
  phases: WorkflowPhaseInfo[];
  agents: WorkflowAgentInfo[];
  /** How many times the run was launched (a resume launches it again). */
  launches: number;
}

/** One workflow agent's own activity, as tool calls and segments the task views already render. */
export interface WorkflowAgentDetail {
  agent: WorkflowAgentInfo;
  /** The task the script computed for it. */
  prompt?: string;
  segments: TurnSegment[];
  calls: ToolCallRecord[];
  /** What it returned: its structured output or final message. */
  result?: string;
}

/** One streamed chunk of a task's text or reasoning; the client appends it to the named segment. */
export interface AgentTaskTextDelta {
  taskId: string;
  segmentId: string;
  kind: 'text' | 'thought';
  messageId?: string;
  text: string;
  /** For a reply chunk: the spawning call, whose `subagentText` gets it too. */
  toolCallId?: string;
}
