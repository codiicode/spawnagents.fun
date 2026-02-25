const LIMITS = {
  aggression: { min: 0.05, max: 0.95 },
  patience: { min: 0.05, max: 0.95 },
  risk_tolerance: { min: 0.05, max: 0.95 },
  buy_threshold_holders: { min: 50, max: 5000 },
  buy_threshold_volume: { min: 100, max: 50000 },
  sell_profit_pct: { min: 5, max: 200 },
  sell_loss_pct: { min: 3, max: 50 },
  max_position_pct: { min: 5, max: 80 },
};
const MUTABLE_KEYS = Object.keys(LIMITS);
function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
export function mutate(parentDna) {
  const childDna = { ...parentDna };
  const mutations = [];
  const numMutations = Math.random() > 0.5 ? 2 : 1;
  const usedKeys = new Set();
  for (let i = 0; i < numMutations; i++) {
    let key;
    do { key = MUTABLE_KEYS[Math.floor(Math.random() * MUTABLE_KEYS.length)]; } while (usedKeys.has(key));
    usedKeys.add(key);
    const oldValue = childDna[key];
    const change = 1 + (Math.random() * 0.4 - 0.2);
    const newValue = clamp(childDna[key] * change, LIMITS[key].min, LIMITS[key].max);
    childDna[key] = Number.isInteger(LIMITS[key].min) ? Math.round(newValue) : parseFloat(newValue.toFixed(3));
    mutations.push({ param: key, from: oldValue, to: childDna[key], change_pct: parseFloat(((change - 1) * 100).toFixed(1)) });
  }
  return { childDna, mutations };
}
