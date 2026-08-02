/**
 * Sitewide communications settings — brand shell + per-message enable/copy.
 * Stored under DATA_DIR/comms-settings.json.
 */

const fs = require('fs');
const path = require('path');
const { listCatalog, getCatalogItem } = require('./comms-catalog');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'comms-settings.json');

const DEFAULT_BRAND = {
  eyebrow: '24 Teams · Two Conferences · One Champion',
  footerExtra: "If you weren't expecting this email, ignore it.<br />GridIron 24 created by S.Evans",
  showConferences: true
};

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({
      brand: { ...DEFAULT_BRAND },
      items: {},
      updatedAt: null
    }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      brand: { ...DEFAULT_BRAND, ...(data.brand && typeof data.brand === 'object' ? data.brand : {}) },
      items: data.items && typeof data.items === 'object' ? data.items : {},
      updatedAt: data.updatedAt || null
    };
  } catch {
    return { brand: { ...DEFAULT_BRAND }, items: {}, updatedAt: null };
  }
}

function writeStore(data) {
  ensureStore();
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

function getBrand() {
  const brand = readStore().brand;
  return {
    eyebrow: String(brand.eyebrow || DEFAULT_BRAND.eyebrow).trim() || DEFAULT_BRAND.eyebrow,
    footerExtra: String(brand.footerExtra ?? DEFAULT_BRAND.footerExtra),
    showConferences: brand.showConferences !== false
  };
}

function updateBrand(patch = {}) {
  const store = readStore();
  const next = { ...store.brand };
  if (Object.prototype.hasOwnProperty.call(patch, 'eyebrow')) {
    next.eyebrow = String(patch.eyebrow || '').trim() || DEFAULT_BRAND.eyebrow;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'footerExtra')) {
    next.footerExtra = String(patch.footerExtra ?? '');
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'showConferences')) {
    next.showConferences = Boolean(patch.showConferences);
  }
  store.brand = next;
  store.updatedAt = new Date().toISOString();
  writeStore(store);
  return getBrand();
}

function itemState(id) {
  const store = readStore();
  const saved = store.items[id] || {};
  return {
    enabled: saved.enabled !== false,
    copy: saved.copy && typeof saved.copy === 'object' ? { ...saved.copy } : {},
    variants: saved.variants && typeof saved.variants === 'object' ? { ...saved.variants } : {}
  };
}

function isEnabled(id) {
  if (!getCatalogItem(id)) return true;
  return itemState(id).enabled !== false;
}

function getCopy(id, { variant = null } = {}) {
  const state = itemState(id);
  if (variant) {
    const v = state.variants[String(variant).toLowerCase()];
    if (v && typeof v === 'object') return { ...v };
  }
  return { ...state.copy };
}

function updateItem(id, patch = {}) {
  const meta = getCatalogItem(id);
  if (!meta) {
    throw Object.assign(new Error('Unknown communication'), { status: 404 });
  }
  const store = readStore();
  const prev = store.items[id] || { enabled: true, copy: {}, variants: {} };
  const next = {
    enabled: prev.enabled !== false,
    copy: { ...(prev.copy || {}) },
    variants: { ...(prev.variants || {}) }
  };

  if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) {
    next.enabled = Boolean(patch.enabled);
  }

  if (patch.copy && typeof patch.copy === 'object') {
    const allowed = new Set(meta.editable || []);
    for (const [key, value] of Object.entries(patch.copy)) {
      if (!allowed.has(key)) continue;
      const text = String(value ?? '');
      if (!text.trim()) {
        delete next.copy[key];
      } else {
        next.copy[key] = text;
      }
    }
  }

  if (patch.variant && patch.variantCopy && typeof patch.variantCopy === 'object') {
    const kind = String(patch.variant).toLowerCase();
    const allowed = new Set(meta.editable || []);
    const current = { ...(next.variants[kind] || {}) };
    for (const [key, value] of Object.entries(patch.variantCopy)) {
      if (!allowed.has(key)) continue;
      const text = String(value ?? '');
      if (!text.trim()) delete current[key];
      else current[key] = text;
    }
    next.variants[kind] = current;
  }

  store.items[id] = next;
  store.updatedAt = new Date().toISOString();
  writeStore(store);
  return itemState(id);
}

function resetItem(id) {
  const meta = getCatalogItem(id);
  if (!meta) {
    throw Object.assign(new Error('Unknown communication'), { status: 404 });
  }
  const store = readStore();
  delete store.items[id];
  store.updatedAt = new Date().toISOString();
  writeStore(store);
  return itemState(id);
}

function fill(template, vars = {}) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v == null ? '' : String(v);
  });
}

function listForAdmin() {
  return listCatalog().map((item) => {
    const state = itemState(item.id);
    return {
      ...item,
      enabled: state.enabled,
      hasCustomCopy: Boolean(
        Object.keys(state.copy).length
        || Object.values(state.variants).some((v) => v && Object.keys(v).length)
      ),
      copy: state.copy,
      variantCopy: state.variants,
      variantKeys: Array.isArray(item.variants) ? item.variants.slice() : []
    };
  }).sort((a, b) => {
    const g = String(a.group).localeCompare(String(b.group));
    if (g) return g;
    return String(a.name).localeCompare(String(b.name));
  });
}

function publicSnapshot() {
  return {
    brand: getBrand(),
    items: listForAdmin(),
    updatedAt: readStore().updatedAt,
    defaults: { brand: { ...DEFAULT_BRAND } }
  };
}

module.exports = {
  DEFAULT_BRAND,
  getBrand,
  updateBrand,
  isEnabled,
  getCopy,
  updateItem,
  resetItem,
  fill,
  itemState,
  listForAdmin,
  publicSnapshot
};
