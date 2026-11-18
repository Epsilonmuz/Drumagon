export function createFixtureTools() {
  const tau = 2 * Math.PI;

  function randomGenerator(seed) {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  function makeKit(rate, variant = 0) {
    const random = randomGenerator(3201 + 619 * variant);
    const make = (length, sample) => {
      const data = new Float32Array(Math.round(length * rate));
      for (let i = 0; i < data.length; i++) data[i] = sample(i / rate);
      return data;
    };
    const kick = make(0.34, (t) => {
      const phase = (49 + variant * 3) * t + (1 - Math.exp(-31 * t)) * (2.7 + variant * 0.25);
      const click = (random() * 2 - 1) * Math.exp(-t * 630);
      return Math.min(1, t * 690) * (0.89 * Math.sin(tau * phase) *
        Math.exp(-t * (12.5 + variant)) + 0.11 * click);
    });
    let tail = 0;
    const backbeat = make(0.23, (t) => {
      const noise = random() * 2 - 1;
      tail += 0.33 * (noise - tail);
      const clap = 1 + (0.27 + 0.04 * variant) * Math.cos(tau * 115 * t) * Math.exp(-90 * t);
      return Math.min(1, t * 1450) * Math.exp(-t * (19 + variant)) * (
        0.86 * tail * clap + 0.30 * Math.sin(tau * (197 + variant * 12) * t) * Math.exp(-31 * t)
      );
    });
    const metallic = (decay, length) => {
      let previous = 0;
      return make(length, (t) => {
        const fresh = random() * 2 - 1;
        const noise = (fresh - previous) * 0.49;
        previous = fresh;
        const metal = 0.10 * Math.sin(tau * (7811 + 221 * variant) * t) +
          0.07 * Math.sin(tau * (9907 - 193 * variant) * t);
        return Math.min(1, t * 2400) * (noise * 0.78 + metal) * Math.exp(-t * decay);
      });
    };
    return {
      kick, backbeat,
      hat: metallic(63 + variant * 6, 0.115),
      "open-hat": metallic(13 + variant, 0.35),
    };
  }

  function renderHits(hits, rate, duration, origin = 0, variant = 0) {
    const signal = new Float32Array(Math.max(1, Math.ceil(rate * duration)));
    const kit = makeKit(rate, variant);
    for (const { lane, time, velocity } of hits) {
      const drum = kit[lane];
      const start = Math.round((time - origin) * rate);
      const gain = 0.54 * (velocity / 127) ** 1.18;
      const end = Math.min(drum.length, signal.length - start);
      for (let i = Math.max(0, -start); i < end; i++) signal[start + i] += drum[i] * gain;
    }
    for (let i = 0; i < signal.length; i++) signal[i] = Math.tanh(signal[i] * 1.2);
    return signal;
  }

  function fixture({ rate = 44100, bpm = 140, variant = 0, style = "drill", bars = 8 } = {}) {
    const beat = 60 / bpm;
    const downbeat = 0.12;
    const length = downbeat + bars * 4 * beat;
    const events = [];
    const write = (lane, position, offset, velocity) => {
      events.push({ lane, time: downbeat + beat * position + offset, velocity });
    };
    for (let bar = 0; bar < bars; bar++) {
      const grid = bar * 4;
      const variation = bar % 4;
      const kicks = style === "dembow" ? [[0, 1, 2, 3], [0, 1, 2, 2.75, 3]][bar % 2] : [
        [0, 0.75, 1.5, 2.75, 3.5],
        [0, 1.25, 1.75, 3.25],
        [0, 0.75, 2.5, 3.25, 3.75],
        [0, 1.5, 2.75],
      ][variation];
      kicks.forEach((position, index) => write("kick", grid + position, index % 2 ? 0.006 : 0, 117 - index * 7));
      const claps = style === "dembow" ? [0.75, 1.5, 2.75, 3.5] :
        variation === 3 ? [2, 3.75] : [2];
      claps.forEach((position, index) => write("backbeat", grid + position, 0.009 + 0.002 * index, 112 - index * 13));
      for (let step = 0; step < 8; step++) {
        if ((variation === 1 && step === 3) || (variation === 3 && step >= 6)) continue;
        const lane = (step === 7 && variation === 2) || (step === 3 && variation === 0) ? "open-hat" : "hat";
        const velocity = step % 2 ? 64 + (step % 3) * 4 : 93 - (step % 3) * 3;
        write(lane, grid + step / 2, step % 2 ? -0.009 + 0.001 * variant : 0.003, velocity);
      }
      if (variation === 3) {
        for (let i = 0; i < 7; i++) write("hat", grid + 3.25 + i / 12, 0.003 * (i % 3), 95 - 6 * i);
      }
    }
    events.sort((a, b) => a.time - b.time);
    const stem = renderHits(events, rate, length, 0, variant);
    const mix = new Float32Array(stem);
    const accompaniment = new Float32Array(stem.length);
    for (let bar = 0; bar < bars; bar++) {
      const base = downbeat + bar * 4 * beat;
      const first = Math.round(base * rate);
      const last = Math.min(mix.length, Math.round((base + 4 * beat) * rate));
      const fundamental = [51.91, 46.25, 55, 43.65][bar % 4];
      for (let index = first; index < last; index++) {
        const t = (index - first) / rate;
        const bassPosition = t < 1.75 * beat ? t : t - 1.75 * beat;
        const bassNote = t < 1.75 * beat ? fundamental : fundamental * 1.12246;
        const bassEnvelope = Math.min(1, bassPosition * (42 + variant * 13)) * Math.exp(-1.7 * bassPosition);
        const glide = (1 - Math.exp(-23 * bassPosition)) * (0.32 + 0.22 * variant);
        const bass = Math.tanh((1.1 + 0.33 * variant) * Math.sin(tau * (bassNote * bassPosition + glide)));
        const keyTime = t % (beat / 2);
        const keyEnvelope = Math.min(1, keyTime * 50) * Math.exp(-7 * keyTime);
        const tone = Math.sin(tau * fundamental * 6 * t) +
          0.52 * Math.sin(tau * fundamental * 9 * t + 0.3) +
          0.20 * Math.sin(tau * fundamental * 13.5 * t);
        const kickDucking = Math.min(1, 0.44 + (t % beat) * 7);
        const backing = bass * bassEnvelope * (0.11 + variant * 0.025) * kickDucking + 0.034 * tone * keyEnvelope;
        accompaniment[index] = backing;
        mix[index] = Math.tanh((mix[index] + backing) * (1.12 + variant * 0.10));
      }
    }
    return { mix, stem, accompaniment, events, rate, bpm, downbeat, duration: length };
  }

  return { fixture, makeKit, renderHits };
}
