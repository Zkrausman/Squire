import { createHash } from 'node:crypto';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const projectLanes = new Set(['project:preflight', 'project:plan', 'project:acceptance', 'project:agent', 'project:doctor', 'project:configure-runtime']);
const validLane = value => projectLanes.has(value) || (typeof value === 'string' && value.startsWith('ticket:') && identifier(value.slice(7)));

function dependencyGraph(tickets, issues) {
  if (!Array.isArray(tickets) || tickets.length > 200) {
    issues.add('owner_decision_dependency_graph_invalid');
    return null;
  }
  const graph = new Map();
  for (const ticket of tickets) {
    const id = ticket?.id, dependencies = ticket?.dependsOn;
    if (!identifier(id) || graph.has(id) || !Array.isArray(dependencies) || dependencies.length > 100 ||
      dependencies.some(dependency => !identifier(dependency)) || new Set(dependencies).size !== dependencies.length) {
      issues.add('owner_decision_dependency_graph_invalid');
      return null;
    }
    graph.set(id, dependencies);
  }
  for (const [id, dependencies] of graph) {
    if (dependencies.some(dependency => !graph.has(dependency) || dependency === id)) {
      issues.add('owner_decision_dependency_graph_invalid');
      return null;
    }
  }
  const visiting = new Set(), visited = new Set();
  const visit = id => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of graph.get(id)) if (!visit(dependency)) return false;
    visiting.delete(id); visited.add(id);
    return true;
  };
  for (const id of graph.keys()) if (!visit(id)) {
    issues.add('owner_decision_dependency_graph_invalid');
    return null;
  }
  return graph;
}

/**
 * Project a bounded owner-facing decision summary from already captured state.
 * This function has no persistence, notification, dispatch, or retry behavior.
 */
export function projectOwnerDecisions({ projectId, rootScopeIds, tickets, scopes }) {
  const issues = new Set(), decisions = [];
  if (!identifier(projectId) || !Array.isArray(rootScopeIds) || rootScopeIds.length > 200 || !Array.isArray(scopes) || scopes.length > 200) {
    return { decisions, issues: ['owner_decision_input_invalid'] };
  }
  const roots = [...new Set(rootScopeIds.filter(uuid))].sort();
  if (rootScopeIds.some(id => !uuid(id))) issues.add('owner_decision_input_invalid');
  if (!roots.length) return { decisions, issues: [...issues].sort() };

  const graph = dependencyGraph(tickets, issues);
  const byScope = new Map();
  for (const scope of scopes) {
    if (!uuid(scope?.scopeId)) continue;
    if (byScope.has(scope.scopeId)) {
      byScope.set(scope.scopeId, null);
      issues.add('owner_decision_scope_identity_invalid');
    } else byScope.set(scope.scopeId, scope);
  }
  for (const scopeId of roots) {
    const scope = byScope.get(scopeId);
    if (!scope || scope.projectId !== projectId || !validLane(scope.lane) || scope.evidence === 'missing') {
      issues.add('owner_decision_scope_unavailable');
      continue;
    }
    const rootTicketId = scope.lane.startsWith('ticket:') ? scope.lane.slice(7) : null;
    const rootExists = rootTicketId === null || graph?.has(rootTicketId);
    if (rootTicketId !== null && !rootExists) issues.add('owner_decision_root_ticket_missing');
    const descendants = rootTicketId === null ? [] : graph && rootExists ? [...graph]
      .filter(([id, dependencies]) => id !== rootTicketId && dependencies.includes(rootTicketId))
      .map(([id]) => id) : [];
    if (rootTicketId !== null && graph && rootExists) {
      const affected = new Set([rootTicketId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [id, dependencies] of graph) if (!affected.has(id) && dependencies.some(dependency => affected.has(dependency))) {
          affected.add(id); changed = true;
        }
      }
      descendants.splice(0, descendants.length, ...[...affected].filter(id => id !== rootTicketId).sort());
    }
    const identity = JSON.stringify(['squire.owner-decision', 1, projectId, scopeId]);
    const decisionId = createHash('sha256').update(identity).digest('hex');
    decisions.push({
      type: 'squire.owner-decision', version: 1, decisionId,
      rootBlocker: { scopeId, lane: scope.lane, ticketId: rootTicketId,
        scopeClosure: ['open', 'recorded_closed'].includes(scope.closure) ? scope.closure : 'unknown' },
      descendantTicketIds: descendants.sort(),
      descendantsEvidence: rootTicketId === null ? 'not_applicable' : graph && rootExists ? 'complete' : 'unavailable',
      decisionState: 'pending', choices: ['retain_hold', 'investigate'],
      liveness: 'unknown', retryAuthorized: false, acknowledgmentAuthorizesRetry: false
    });
  }
  decisions.sort((a, b) => a.decisionId.localeCompare(b.decisionId));
  return { decisions, issues: [...issues].sort() };
}
