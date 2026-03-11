const LIMITS = {
  aggression: { min: 0.05, max: 0.95 },
  patience: { min: 0.05, max: 0.95 },
  risk_tolerance: { min: 0.05, max: 0.95 },
  buy_threshold_holders: { min: 50, max: 5000 },
  buy_threshold_volume: { min: 100, max: 50000 },
  sell_profit_pct: { min: 5, max: 200 },
  sell_loss_pct: { min: 3, max: 50 },
  max_position_pct: { min: 5, max: 80 },
  min_mcap: { min: 5000, max: 1000000 },
  max_mcap: { min: 50000, max: 5000000 },
  max_pair_age_hours: { min: 1, max: 720 },
  trailing_stop_pct: { min: 5, max: 50 },
};
const MUTABLE_KEYS = Object.keys(LIMITS);
function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
export function mutate(parentDna) {
  const childDna = { ...parentDna };
  const mutations = [];
  const numMutations = Math.random() > 0.5 ? 2 : 1;
  const usedKeys = new Set();
  const availableKeys = MUTABLE_KEYS.filter(k => childDna[k] !== undefined);
  if (availableKeys.length === 0) return { childDna, mutations };
  for (let i = 0; i < numMutations; i++) {
    let key;
    do { key = availableKeys[Math.floor(Math.random() * availableKeys.length)]; } while (usedKeys.has(key) && usedKeys.size < availableKeys.length);
    usedKeys.add(key);
    const oldValue = childDna[key];
    const change = 1 + (Math.random() * 0.4 - 0.2);
    const newValue = clamp(childDna[key] * change, LIMITS[key].min, LIMITS[key].max);
    childDna[key] = Number.isInteger(LIMITS[key].min) ? Math.round(newValue) : parseFloat(newValue.toFixed(3));
    mutations.push({ param: key, from: oldValue, to: childDna[key], change_pct: parseFloat(((change - 1) * 100).toFixed(1)) });
  }
  return { childDna, mutations };
}

export function crossover(parentA, parentB) {
  const childDna = {};
  const mutations = [];

  // For each mutable key present in at least one parent: randomly pick from parent A or B, then apply ±10% mutation
  for (const key of MUTABLE_KEYS) {
    if (parentA[key] === undefined && parentB[key] === undefined) continue;
    const hasA = parentA[key] !== undefined, hasB = parentB[key] !== undefined;
    const source = hasA && hasB ? (Math.random() < 0.5 ? 'A' : 'B') : (hasA ? 'A' : 'B');
    const baseValue = source === 'A' ? parentA[key] : parentB[key];
    const change = 1 + (Math.random() * 0.2 - 0.1); // ±10% (half of normal ±20%)
    const newValue = clamp(baseValue * change, LIMITS[key].min, LIMITS[key].max);
    childDna[key] = Number.isInteger(LIMITS[key].min) ? Math.round(newValue) : parseFloat(newValue.toFixed(3));
    mutations.push({ param: key, from: baseValue, to: childDna[key], source, change_pct: parseFloat(((change - 1) * 100).toFixed(1)) });
  }

  // Copy non-mutable keys from parent A
  for (const key of Object.keys(parentA)) {
    if (!MUTABLE_KEYS.includes(key)) childDna[key] = parentA[key];
  }

  return { childDna, mutations };
}
