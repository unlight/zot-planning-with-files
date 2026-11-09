export function createState() {
  return {
    cwd: process.cwd(),
    sessionId: "default",
    host: {
      protocolVersion: 0,
      zotVersion: "",
      provider: "",
      model: "",
      cwd: "",
      extensionDir: "",
      dataDir: "",
    },
    autoContinueBySessionPlan: new Map(),
    loopTimersBySession: new Map(),
    goalBySession: new Map(),
    executionApprovedBySessionPlan: new Set(),
    extensionSubmits: new Map(),
  };
}

export function planSessionKey(sessionId, status) {
  return `${sessionId}:${status.planPath ?? "none"}`;
}

export function isExecutionApproved(state, sessionId, status) {
  return state.executionApprovedBySessionPlan.has(planSessionKey(sessionId, status));
}

export function approveExecution(state, sessionId, status) {
  state.executionApprovedBySessionPlan.add(planSessionKey(sessionId, status));
}

export function clearExecution(state, sessionId, status) {
  state.executionApprovedBySessionPlan.delete(planSessionKey(sessionId, status));
}

export function clearSessionApprovals(state, sessionId) {
  for (const key of Array.from(state.executionApprovedBySessionPlan)) {
    if (key.startsWith(`${sessionId}:`)) state.executionApprovedBySessionPlan.delete(key);
  }
}

export function clearSessionAutoContinue(state, sessionId) {
  for (const key of Array.from(state.autoContinueBySessionPlan.keys())) {
    if (key.startsWith(`${sessionId}:`)) state.autoContinueBySessionPlan.delete(key);
  }
}

export function clearSessionLoop(state, sessionId) {
  const timer = state.loopTimersBySession.get(sessionId);
  if (timer) clearInterval(timer);
  state.loopTimersBySession.delete(sessionId);
}
