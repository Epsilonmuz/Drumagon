const chartLanes = ["kick", "backbeat", "hat"];
const family = (lane) => lane === "open-hat" ? "hat" : lane;

export function matchTimes(reference, detected, tolerance) {
  const n = reference.length;
  const m = detected.length;
  const direction = new Uint8Array(n * m);
  let previousCount = new Uint32Array(m + 1);
  let currentCount = new Uint32Array(m + 1);
  let previousCost = new Float64Array(m + 1);
  let currentCost = new Float64Array(m + 1);
  const better = (count, cost, bestCount, bestCost) =>
    count > bestCount || (count === bestCount && cost < bestCost);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      let count = previousCount[j];
      let cost = previousCost[j];
      let step = 1;
      if (better(currentCount[j - 1], currentCost[j - 1], count, cost)) {
        count = currentCount[j - 1];
        cost = currentCost[j - 1];
        step = 2;
      }
      const error = Math.abs(reference[i - 1] - detected[j - 1]);
      const pairedCount = previousCount[j - 1] + 1;
      const pairedCost = previousCost[j - 1] + error;
      if (error <= tolerance + 1e-12 && better(pairedCount, pairedCost, count, cost)) {
        count = pairedCount;
        cost = pairedCost;
        step = 3;
      }
      currentCount[j] = count;
      currentCost[j] = cost;
      direction[(i - 1) * m + j - 1] = step;
    }
    [previousCount, currentCount] = [currentCount, previousCount];
    [previousCost, currentCost] = [currentCost, previousCost];
  }
  const errors = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const step = direction[(i - 1) * m + j - 1];
    if (step === 3) {
      errors.push(detected[j - 1] - reference[i - 1]);
      i--;
      j--;
    } else if (step === 2) {
      j--;
    } else {
      i--;
    }
  }
  return errors.reverse();
}

function timingSummary(errors) {
  if (!errors.length) return { biasMs: null, medianMs: null, p95Ms: null };
  const abs = errors.map(Math.abs).sort((a, b) => a - b);
  const middle = Math.floor(abs.length / 2);
  const median = abs.length % 2 ? abs[middle] : (abs[middle - 1] + abs[middle]) / 2;
  return {
    biasMs: 1000 * errors.reduce((sum, error) => sum + error, 0) / errors.length,
    medianMs: 1000 * median,
    p95Ms: 1000 * abs[Math.ceil(0.95 * abs.length) - 1],
  };
}

export function score(reference, detected, windows = [10, 20, 50]) {
  const perLane = (hits, lane) => hits
    .filter((hit) => family(hit.lane) === lane && Number.isFinite(hit.time))
    .map((hit) => hit.time)
    .sort((a, b) => a - b);
  return chartLanes.flatMap((lane) => {
    const targets = perLane(reference, lane);
    const predictions = perLane(detected, lane);
    return windows.map((windowMs) => {
      const errors = matchTimes(targets, predictions, windowMs / 1000);
      const matches = errors.length;
      const total = targets.length + predictions.length;
      return {
        lane, windowMs, reference: targets.length, detected: predictions.length, matches,
        precision: predictions.length ? matches / predictions.length : null,
        recall: targets.length ? matches / targets.length : null,
        f1: total ? 2 * matches / total : null,
        ...timingSummary(errors),
      };
    });
  });
}
