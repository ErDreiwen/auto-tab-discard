const resolveReplacement = (edges, id) => {
  if (!Number.isInteger(id)) {
    return id;
  }
  const path = [];
  const seen = new Set();
  let current = id;
  while (Number.isInteger(edges.get(current)) && !seen.has(current)) {
    seen.add(current);
    path.push(current);
    current = edges.get(current);
  }
  for (const predecessor of path) {
    edges.set(predecessor, current);
  }
  return current;
};

const recordReplacement = (edges, addedId, removedId) => {
  if (!Number.isInteger(addedId) || !Number.isInteger(removedId)) {
    return undefined;
  }
  const from = resolveReplacement(edges, removedId);
  // A newly added id is a live identity and must not inherit a stale edge from
  // an older tab that happened to use the same integer.
  edges.delete(addedId);
  const to = resolveReplacement(edges, addedId);
  if (from === to) {
    return {changed: false, from, to};
  }
  edges.set(removedId, to);
  edges.set(from, to);
  return {changed: true, from, to};
};

// Retain only predecessor ids that an active callback/job can still present.
// Every retained path is compressed to one edge, so storage is bounded by the
// number of live tabs plus exact active references—not replacement history.
const pruneReplacementLineage = (edges, {
  liveIds = new Set(),
  referencedIds = new Set()
} = {}) => {
  const retained = new Map();
  for (const id of referencedIds) {
    if (!Number.isInteger(id) || liveIds.has(id)) {
      continue;
    }
    const current = resolveReplacement(edges, id);
    if (liveIds.has(current) && current !== id) {
      retained.set(id, current);
    }
  }
  edges.clear();
  for (const [from, to] of retained) {
    edges.set(from, to);
  }
  return edges.size;
};

export {pruneReplacementLineage, recordReplacement, resolveReplacement};
