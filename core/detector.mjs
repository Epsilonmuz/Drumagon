export function createDetector() {
  const lanes = [
    { id: "kick", label: "Kick", note: 36 },
    { id: "backbeat", label: "Snare / Clap", note: 38 },
    { id: "hat", label: "Closed Hat", note: 42 },
    { id: "open-hat", label: "Open Hat", note: 46 },
  ];

  const limit = (value, min, max) => Math.max(min, Math.min(max, value));
  const family = (lane) => lane === "open-hat" ? "hat" : lane;

  function filter(rate, mode, frequency, q = Math.SQRT1_2) {
    const angle = 2 * Math.PI * Math.min(frequency / rate, 0.44);
    const cosine = Math.cos(angle);
    const alpha = Math.sin(angle) / (2 * q);
    const scale = 1 / (1 + alpha);
    const b0 = (mode === "lp" ? (1 - cosine) / 2 :
      mode === "hp" ? (1 + cosine) / 2 : alpha) * scale;
    const b1 = mode === "lp" ? 2 * b0 : mode === "hp" ? -2 * b0 : 0;
    const b2 = mode === "bp" ? -b0 : b0;
    const a1 = -2 * cosine * scale;
    const a2 = (1 - alpha) * scale;
    let z1 = 0;
    let z2 = 0;
    return (input) => {
      const output = b0 * input + z1;
      z1 = b1 * input - a1 * output + z2;
      z2 = b2 * input - a2 * output;
      return output;
    };
  }

  function bandEnvelopes(audio, rate) {
    const hop = Math.max(1, Math.round(rate * 0.0025));
    const length = Math.ceil(audio.length / hop);
    const bands = Array.from({ length: 4 }, () => new Float32Array(length));
    const low = filter(rate, "lp", 145);
    const body = filter(rate, "bp", 420, 0.85);
    const snap = filter(rate, "bp", 1850, 0.72);
    const air = filter(rate, "hp", 5600);
    for (let frame = 0; frame < length; frame++) {
      const left = frame * hop;
      const right = Math.min(left + hop, audio.length);
      let a = 0;
      let b = 0;
      let c = 0;
      let d = 0;
      for (let index = left; index < right; index++) {
        const x = audio[index];
        const v = low(x);
        const w = body(x);
        const y = snap(x);
        const z = air(x);
        a += v * v;
        b += w * w;
        c += y * y;
        d += z * z;
      }
      const span = right - left;
      bands[0][frame] = Math.sqrt(a / span);
      bands[1][frame] = Math.sqrt(b / span);
      bands[2][frame] = Math.sqrt(c / span);
      bands[3][frame] = Math.sqrt(d / span);
    }
    return { bands, hopSeconds: hop / rate, length };
  }

  function average(values, from, to) {
    if (to <= from) return 0;
    let sum = 0;
    for (let i = Math.max(0, from); i < Math.min(values.length, to); i++) sum += values[i];
    return sum / (to - from);
  }

  function risingEnergy(band, frame) {
    const attack = average(band, frame, frame + 2);
    const floor = average(band, frame - 6, frame - 1);
    return Math.max(0, attack - floor);
  }

  function scoreBands(envelopes) {
    const { bands, length } = envelopes;
    const scores = Array.from({ length: 3 }, () => new Float32Array(length));
    const trackLevel = Math.max(...bands.map((band) => percentile(band, 0.98)));
    const lowEnvelope = new Float32Array(length);
    for (let frame = 0; frame < length; frame++) {
      let power = 0;
      for (let offset = -2; offset <= 2; offset++) {
        power += (bands[0][frame + offset] ?? 0) ** 2;
      }
      lowEnvelope[frame] = Math.sqrt(power / 5);
    }
    for (let frame = 0; frame < length; frame++) {
      const low = risingEnergy(lowEnvelope, frame);
      const body = risingEnergy(bands[1], frame);
      const snap = risingEnergy(bands[2], frame);
      const air = risingEnergy(bands[3], frame);
      const kickAttack = Math.max(0, low - 0.17 * body - 0.14 * snap);
      const broadband = limit((2.2 * body + 0.8 * snap) / Math.max(0.00001, low), 0, 1);
      const attackLevel = average(lowEnvelope, frame + 2, frame + 7);
      const pastLevel = average(lowEnvelope, frame - 14, frame - 4);
      const tailLevel = frame + 33 < length ? average(lowEnvelope, frame + 19, frame + 33) : pastLevel;
      // A kick makes a short low-frequency crest. A sustained bass note often keeps rising.
      const decay = limit((attackLevel - Math.max(pastLevel, tailLevel)) / Math.max(0.00001, attackLevel), 0, 1);
      const bodyTop = average(bands[1], frame + 1, frame + 6);
      const bodyRest = Math.max(average(bands[1], frame - 10, frame - 3), average(bands[1], frame + 10, frame + 19));
      const strike = limit((1 - bodyRest / Math.max(0.00001, bodyTop) - 0.16) * 4, 0, 1);
      scores[0][frame] = kickAttack * (0.28 + 0.72 * broadband) * strike * limit((decay - 0.06) * 4, 0, 1);

      // Require upper-mid attack energy so a pitched kick body does not become a snare.
      const midLevel = average(bands[2], frame, frame + 4);
      const airLevel = average(bands[3], frame, frame + 4);
      const bodyLevel = average(bands[1], frame, frame + 4);
      const hatLike = airLevel > 2.5 * midLevel && bodyLevel < 0.30 * midLevel;
      if (midLevel >= 0.082 * trackLevel && !hatLike) {
        scores[1][frame] = Math.max(0, snap - 0.33 * body - 0.16 * air - 0.09 * low);
      }
      if (airLevel >= 0.027 * trackLevel) {
        scores[2][frame] = Math.max(0, air - 0.57 * snap - 0.28 * body);
      }
    }
    return scores;
  }

  function percentile(values, fraction) {
    const sorted = Array.from(values).sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0;
  }

  function pickPeaks(values, distance, sensitivity, laneIndex) {
    const floor = percentile(values, 0.985);
    const top = percentile(values, 0.999);
    const multipliers = [0.45, 0.48, 0.41];
    const threshold = Math.max(0.000025, floor * multipliers[laneIndex], top * 0.08) /
      (0.52 + sensitivity * 0.94);
    const peaks = [];
    for (let frame = 0; frame < values.length; frame++) {
      const strength = values[frame];
      if (strength < threshold || strength < (values[frame - 1] ?? 0) ||
          strength <= (values[frame + 1] ?? 0)) continue;
      const last = peaks.at(-1);
      if (last && frame - last.frame < distance) {
        if (strength > last.strength) peaks[peaks.length - 1] = { frame, strength };
      } else {
        peaks.push({ frame, strength });
      }
    }
    return { peaks, threshold };
  }

  function refine(energy, frame, hopSeconds) {
    const floor = average(energy, frame - 7, frame - 3);
    const peak = Math.max(...energy.slice(frame, frame + 4));
    const threshold = floor + (peak - floor) * 0.18;
    let start = frame;
    while (start > Math.max(0, frame - 4) && energy[start - 1] >= threshold) start--;
    return Math.max(0, (start + 0.1) * hopSeconds);
  }

  function tempoSuggestion(hits, length) {
    if (hits.length < 8 || length < 2.5) return null;
    const binsPerSecond = 100;
    const bins = new Float32Array(Math.ceil(Math.min(length, 90) * binsPerSecond) + 4);
    for (const hit of hits) {
      const index = Math.round(hit.time * binsPerSecond);
      if (index >= bins.length) break;
      const weight = hit.lane === "kick" ? 1 : hit.lane === "backbeat" ? 0.8 : 0.42;
      bins[index] += weight;
      if (index > 0) bins[index - 1] += 0.5 * weight;
      if (index + 1 < bins.length) bins[index + 1] += 0.5 * weight;
    }
    const correlations = new Float32Array(221);
    for (let lag = 14; lag < correlations.length; lag++) {
      let products = 0;
      for (let index = lag; index < bins.length; index++) products += bins[index] * bins[index - lag];
      correlations[lag] = products / (bins.length - lag);
    }
    const scores = new Float32Array(109);
    let best = 0;
    for (let lag = 29; lag <= 103; lag++) {
      const score = correlations[lag] + 0.35 * correlations[2 * lag] +
        0.15 * correlations[Math.round(lag / 2)];
      scores[lag] = score * (lag >= 35 && lag <= 72 ? 1.08 : 1);
      if (scores[lag] > (scores[best] || 0)) best = lag;
    }
    if (best === 0) return null;
    const left = scores[best - 1];
    const right = scores[best + 1];
    const curve = left - 2 * scores[best] + right;
    const offset = curve < 0 ? limit(0.5 * (left - right) / curve, -0.5, 0.5) : 0;
    return Math.round(60000 / (best + offset)) / 10;
  }

  function analyze(audio, rate, sensitivity = 0.5) {
    if (!(audio instanceof Float32Array) || !audio.length || !Number.isFinite(rate) || rate < 8000) {
      throw new TypeError("Audio must contain mono PCM at 8 kHz or higher.");
    }
    const envelopes = bandEnvelopes(audio, rate);
    const { bands, hopSeconds } = envelopes;
    const scores = scoreBands(envelopes);
    const distances = [0.036, 0.026, 0.023];
    const all = [];
    for (let laneIndex = 0; laneIndex < scores.length; laneIndex++) {
      const { peaks, threshold } = pickPeaks(
        scores[laneIndex], Math.ceil(distances[laneIndex] / hopSeconds),
        limit(sensitivity, 0, 1), laneIndex,
      );
      const referenceLevel = percentile(peaks.map((peak) => peak.strength), 0.9);
      const energy = bands[laneIndex === 0 ? 0 : laneIndex === 1 ? 2 : 3];
      peaks.forEach(({ frame, strength }, index) => {
        const time = refine(energy, frame, hopSeconds);
        let lane = lanes[laneIndex].id;
        if (laneIndex === 2) {
          const next = peaks[index + 1]?.frame ?? energy.length;
          const decayStart = frame + Math.round(0.042 / hopSeconds);
          const decayEnd = Math.min(next - 2, frame + Math.round(0.090 / hopSeconds));
          const floor = average(energy, frame - 9, frame - 2);
          const attack = average(energy, frame, frame + 4);
          const decay = average(energy, decayStart, decayEnd);
          if (decayEnd - decayStart >= 5 && decay - floor > 0.26 * (attack - floor)) lane = "open-hat";
        }
        const velocity = limit(Math.round(15 + 92 * (strength / referenceLevel) ** 0.48), 1, 127);
        all.push({
          lane, time, velocity,
          evidence: strength >= 2.3 * threshold ? "strong" : "review",
        });
      });
    }
    all.sort((a, b) => a.time - b.time || a.lane.localeCompare(b.lane));
    return {
      hits: all,
      bpm: tempoSuggestion(all, audio.length / rate),
      downbeatCandidate: all.find((hit) => hit.lane === "kick")?.time ?? 0,
    };
  }

  function combine(mix, stem) {
    const hits = stem.hits.map((hit) => ({ ...hit, input: "stem" }));
    const stemByFamily = new Map(lanes.slice(0, 3).map(({ id }) => [id, []]));
    hits.forEach((hit) => stemByFamily.get(family(hit.lane)).push(hit));
    const duplicates = new Set();
    for (const hit of mix.hits) {
      const nearby = stemByFamily.get(family(hit.lane));
      let left = 0;
      let right = nearby.length;
      while (left < right) {
        const middle = (left + right) >>> 1;
        if (nearby[middle].time < hit.time - 0.018) left = middle + 1;
        else right = middle;
      }
      const candidate = nearby[left];
      if (candidate && candidate.time < hit.time + 0.018 && !duplicates.has(candidate)) {
        candidate.input = "both";
        duplicates.add(candidate);
      } else if (hit.evidence === "strong" && (!candidate || candidate.time >= hit.time + 0.018)) {
        hits.push({ ...hit, input: "mix", evidence: "review" });
      }
    }
    hits.sort((a, b) => a.time - b.time || a.lane.localeCompare(b.lane));
    return { hits, bpm: stem.bpm ?? mix.bpm, downbeatCandidate: stem.downbeatCandidate };
  }

  return { analyze, combine, lanes, family };
}
