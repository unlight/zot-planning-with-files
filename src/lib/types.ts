export type HookMode = 'auto' | 'parity' | 'cache-safe' | 'notify';
export type EffectiveMode = Exclude<HookMode, 'auto'>;
export type PlanScope = 'scoped' | 'root' | 'none';
export type SelectionError =
  'session-plan-ambiguous' | 'invalid-plan-root' | 'plan-selector-rejected';

export interface PlanPaths {
  cwd: string;
  scope: PlanScope;
  selectionError?: SelectionError;
  planPath?: string;
  progressPath?: string;
  findingsPath?: string;
  planDir?: string;
  planId?: string;
  attestationCandidates: string[];
}

export interface PlanStatus extends PlanPaths {
  exists: boolean;
  planSha256?: string;
  attestationPath?: string;
  isClosed: boolean;
  totalPhases: number;
  completePhases: number;
  inProgressPhases: number;
  pendingPhases: number;
  firstLines50: string;
  headLines30: string;
  progressTail20: string;
}

export interface AttestationCheck {
  enabled: boolean;
  tampered: boolean;
  expected?: string;
  actual?: string;
  attestationPath?: string;
}

export interface HostInfo {
  protocolVersion: number;
  zotVersion: string;
  provider: string;
  model: string;
  cwd: string;
  extensionDir: string;
  dataDir: string;
}

export interface RuntimeState {
  cwd: string;
  sessionId: string;
  host: HostInfo;
  autoContinueBySessionPlan: Map<string, number>;
  loopTimersBySession: Map<string, NodeJS.Timeout>;
  goalBySession: Map<string, string>;
  executionApprovedBySessionPlan: Set<string>;
  extensionSubmits: Map<string, number>;
}

export interface Frame {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export interface HelloAckFrame extends Frame {
  type: 'hello_ack';
  protocol_version?: number;
  zot_version?: string;
  provider?: string;
  model?: string;
  cwd?: string;
  extension_dir?: string;
  data_dir?: string;
  capabilities?: string[];
}

export interface CommandInvokedFrame extends Frame {
  type: 'command_invoked';
  id: string;
  name: string;
  args?: string;
}

export interface EventFrame extends Frame {
  type: 'event';
  event: string;
  session_id?: string;
  session_alias?: string;
  cwd?: string;
  sequence?: number;
  stop?: string;
  error?: string;
  text?: string;
  queued?: boolean;
  image_count?: number;
  tool_id?: string;
  tool_name?: string;
  tool_args?: Record<string, unknown>;
  tool_preview?: string;
  status?: string;
  reason?: string;
  source?: string;
  decision?: string;
  stage?: string;
  step?: number;
}

export interface InterceptFrame extends Frame {
  type: 'event_intercept';
  id: string;
  event: string;
  system_prompt?: string;
  session_id?: string;
  session_alias?: string;
  cwd?: string;
  provider?: string;
  model?: string;
  step?: number;
  tool_id?: string;
  tool_name?: string;
  tool_args?: Record<string, unknown>;
  text?: string;
}

export type NotifyLevel = 'info' | 'success' | 'warn' | 'error';

export interface CommandResponse {
  action:
    'prompt' | 'tool_prompt' | 'insert' | 'display' | 'open_panel' | 'noop';
  display?: string;
  error?: string;
  prompt?: string;
  insert?: string;
}

export interface ProtocolContext {
  state: RuntimeState;
  send: (frame: Frame) => void;
  log: (message: string) => void;
  notify: (level: NotifyLevel, message: string, isStartup?: boolean) => void;
  submit: (text: string) => void;
}
