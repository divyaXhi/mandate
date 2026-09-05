// The original signal scorer remains the source of truth. This export gives
// Keep a stable, named boundary without duplicating or retuning its logic.
export { scoreConfidence as scoreTrustSignals } from '../trustLayer.js';
