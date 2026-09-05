/** Boundary validation. Request data is untrusted until it passes here. */
export class RequestValidationError extends Error {
  constructor(message, { code = 'INVALID_REQUEST', field = null } = {}) {
    super(message);
    this.name = 'RequestValidationError';
    this.code = code;
    this.field = field;
  }
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function requireObject(value, label = 'Request body') {
  if (!isPlainObject(value)) throw new RequestValidationError(`${label} must be a JSON object`);
  return value;
}

export function requireId(value, field = 'id') {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\u0000-\u001f]/.test(value)) {
    throw new RequestValidationError(`${field} must be a non-empty identifier`, { field });
  }
  return value;
}

export function requirePositiveAmount(value, field = 'amount') {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RequestValidationError(`${field} must be a positive whole INR amount`, { field });
  }
  return value;
}

export function requireCurrency(value, field = 'currency') {
  if (value !== 'INR') throw new RequestValidationError(`${field} must be INR`, { field });
  return value;
}

export function requireAction(value, allowed, field = 'action') {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new RequestValidationError(`${field} is not supported`, { field });
  }
  return value;
}

export function optionalString(value, field, { max = 4000 } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) {
    throw new RequestValidationError(`${field} must be a string`, { field });
  }
  return value;
}
