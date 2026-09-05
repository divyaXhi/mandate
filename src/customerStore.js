import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, '..', 'data', 'customers.json');

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

/** Look up a saved customer/recipient record by phone digits. Returns null if none. */
export function findCustomerByPhone(phone) {
  const store = loadStore();
  return store[phone] || null;
}

/** Create or update a saved record for this phone number. */
export function saveCustomer(phone, data) {
  const store = loadStore();
  store[phone] = { ...store[phone], ...data, updatedAt: new Date().toISOString() };
  saveStore(store);
  return store[phone];
}
