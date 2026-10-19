// Persist by named hierarchy, not numeric row IDs: inserting a different part
// must not transfer a hidden state to its new neighbour.
export class VisibilityPreferences {
  constructor(key, storage = () => globalThis.localStorage) {
    this.key = key;
    this.storage = storage;
    this.saved = new Map();
    try {
      const entries = JSON.parse(this.storage().getItem(key));
      if (Array.isArray(entries)) for (const entry of entries) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'boolean')
          this.saved.set(entry[0], entry[1]);
      }
    } catch { /* Storage may be disabled or contain an obsolete value. */ }
  }
  keys(rows) {
    const paths = new Map(), counts = new Map(), keys = new Map();
    for (const row of rows) {
      const parent = row.id.slice(0, row.id.lastIndexOf('/'));
      const name = JSON.stringify([row.name, Boolean(row.group)]);
      const sibling = JSON.stringify([parent, name]);
      const occurrence = counts.get(sibling) || 0;
      counts.set(sibling, occurrence + 1);
      const path = [...(paths.get(parent) || []), [name, occurrence]];
      paths.set(row.id, path);
      if (!row.group) keys.set(row.id, JSON.stringify(path));
    }
    return keys;
  }
  restore(rows) {
    return new Map([...this.keys(rows)].map(([id, key]) => [id, this.saved.get(key) ?? true]));
  }
  save(rows, visibility) {
    for (const [id, key] of this.keys(rows)) this.saved.set(key, visibility.get(id) ?? true);
    try { this.storage().setItem(this.key, JSON.stringify([...this.saved])); }
    catch { /* Continue with in-memory preferences if storage is unavailable. */ }
  }
}

// A display-only group keeps original IDs, motion paths and saved preferences intact.
export function visibilityRows(rows) {
  const references = rows.filter(row => !row.group && row.fullColourGhost);
  if (!references.length) return rows;
  const ids = new Set(references.map(row => row.id));
  return [...rows.filter(row => !ids.has(row.id)),
    {id:'/non-manufactured', name:'Non-manufactured items', depth:0, group:true,
     members:references},
    ...references.map(row => ({...row, depth:1, displayParent:'/non-manufactured'}))];
}
