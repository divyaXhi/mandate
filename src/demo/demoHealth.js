/** Stable, local readiness check: external APIs are intentionally not required. */
export function demoHealth(checks = {}) {
  const required = ['api', 'intent', 'catalog', 'buyerAgent', 'merchantAgent', 'negotiation', 'trust', 'risk', 'policy', 'decision', 'approval', 'paymentGuard', 'security', 'audit'];
  const components = required.map(id => ({ id, ready: checks[id] === true, reason: checks[id] === true ? null : 'Component unavailable' }));
  return { ready: components.every(component => component.ready), components };
}
