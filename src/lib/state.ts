import type { PlanStatus, RuntimeState } from './types.ts';

export function createState(): RuntimeState {
  return {
    cwd: process.cwd(),
    sessionId: 'default',
    host: {
      protocolVersion: 0,
      zotVersion: '',
      provider: '',
      model: '',
      cwd: '',
      extensionDir: '',
      dataDir: '',
    },
    autoContinueBySessionPlan: new Map(),
    loopTimersBySession: new Map(),
    goalBySession: new Map(),
    executionApprovedBySessionPlan: new Set(),
    extensionSubmits: new Map(),
    lastNotification: undefined,
  };
}

export function planSessionKey(sessionId: string, status: PlanStatus): string {
  return `${sessionId}:${status.planPath ?? 'none'}`;
}

export function isExecutionApproved(
  state: RuntimeState,
  sessionId: string,
  status: PlanStatus,
): boolean {
  return state.executionApprovedBySessionPlan.has(
    planSessionKey(sessionId, status),
  );
}

export function approveExecution(
  state: RuntimeState,
  sessionId: string,
  status: PlanStatus,
): void {
  state.executionApprovedBySessionPlan.add(planSessionKey(sessionId, status));
}

export function clearExecution(
  state: RuntimeState,
  sessionId: string,
  status: PlanStatus,
): void {
  state.executionApprovedBySessionPlan.delete(
    planSessionKey(sessionId, status),
  );
}

export function clearSessionApprovals(
  state: RuntimeState,
  sessionId: string,
): void {
  for (const key of state.executionApprovedBySessionPlan) {
    if (key.startsWith(`${sessionId}:`))
      state.executionApprovedBySessionPlan.delete(key);
  }
}

export function clearSessionAutoContinue(
  state: RuntimeState,
  sessionId: string,
): void {
  for (const key of state.autoContinueBySessionPlan.keys()) {
    if (key.startsWith(`${sessionId}:`))
      state.autoContinueBySessionPlan.delete(key);
  }
}

export function clearSessionLoop(state: RuntimeState, sessionId: string): void {
  const timer = state.loopTimersBySession.get(sessionId);
  if (timer) clearInterval(timer);
  state.loopTimersBySession.delete(sessionId);
}
