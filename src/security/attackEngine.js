import { attackById } from './attackRegistry.js';

/** Validates lookup and delegates all execution to the real-defense runner. */
export async function executeAttack(attackId, context, runner) {
  const attack = attackById(attackId);
  if (!attack) throw new Error(`Unknown attack type: ${attackId}`);
  return runner(attack, context);
}
