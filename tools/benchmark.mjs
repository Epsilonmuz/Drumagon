import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createDetector } from "../core/detector.mjs";
import { createFixtureTools } from "../core/fixture.mjs";
import { createMidiTools } from "../core/midi.mjs";
import { score } from "../core/score.mjs";

const detector = createDetector();
const midi = createMidiTools();

function decodeWave(file) {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const label = (offset) => file.toString("ascii", offset, offset + 4);
  if (file.length < 12 || label(0) !== "RIFF" || label(8) !== "WAVE") {
    throw new Error("Benchmark audio must be a RIFF WAV file.");
  }
  let format;
  let data;
  for (let offset = 12; offset + 8 <= file.length;) {
    const id = label(offset);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + size > file.length) throw new Error("WAV file is truncated.");
    if (id === "fmt " && size >= 16) {
      let codec = view.getUint16(start, true);
      if (codec === 0xfffe && size >= 40) codec = view.getUint16(start + 24, true);
      format = {
        codec, channels: view.getUint16(start + 2, true),
        rate: view.getUint32(start + 4, true),
        stride: view.getUint16(start + 12, true), bits: view.getUint16(start + 14, true),
      };
    }
    if (id === "data" && !data) data = { start, size };
    offset = start + size + (size & 1);
  }
  if (!format || !data) throw new Error("WAV data or format is missing.");
  const { channels, rate, stride, bits, codec } = format;
  if (!channels || !stride || stride < channels * (bits / 8) ||
      (codec !== 1 || ![16, 24, 32].includes(bits)) && (codec !== 3 || bits !== 32)) {
    throw new Error("Use a 16-, 24-, or 32-bit PCM or 32-bit float WAV.");
  }
  const sample = (offset) => {
    if (codec === 3) return view.getFloat32(offset, true) || 0;
    if (bits === 16) return view.getInt16(offset, true) / 32768;
    if (bits === 32) return view.getInt32(offset, true) / 2147483648;
    const value = view.getUint16(offset, true) | (view.getInt8(offset + 2) << 16);
    return value / 8388608;
  };
  const audio = new Float32Array(Math.floor(data.size / stride));
  for (let index = 0; index < audio.length; index++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      sum += sample(data.start + index * stride + channel * bits / 8);
    }
    audio[index] = sum / channels;
  }
  return { audio, rate };
}

function compare(name, mix, stem, reference) {
  const start = performance.now();
  const full = detector.analyze(mix.audio, mix.rate);
  const results = [["mix", full]];
  if (stem) {
    const isolated = detector.analyze(stem.audio, stem.rate);
    results.push(["stem", isolated], ["combined", detector.combine(full, isolated)]);
  }
  const elapsed = Math.round(performance.now() - start);
  console.log(JSON.stringify({
    fixture: name, seconds: mix.audio.length / mix.rate, analysisMs: elapsed,
    modes: results.map(([mode, result]) => ({
      mode, estimatedBpm: result.bpm, hits: result.hits.length,
      falseHitsPerMinute: reference.length ? undefined : result.hits.length * 60 * mix.rate / mix.audio.length,
      scores: score(reference, result.hits),
    })),
  }, null, 2));
}

const args = process.argv.slice(2);
if (!args.length) {
  const { fixture } = createFixtureTools();
  for (const [name, options] of [
    ["Drill, 140 BPM", {}],
    ["Dembow, louder backing", { style: "dembow", bpm: 108, rate: 48000, variant: 1 }],
    ["Drill, stronger bass and different kit", { bpm: 147, variant: 2 }],
  ]) {
    const demo = fixture(options);
    compare(name, { audio: demo.mix, rate: demo.rate }, { audio: demo.stem, rate: demo.rate }, demo.events);
  }
  const pilot = fixture({ variant: 2 });
  compare("Bass and keys without drums", { audio: pilot.accompaniment, rate: pilot.rate }, null, []);
} else {
  const [mixPath, stemPath, refPath, offsetText = "0"] = args;
  if (!refPath || !Number.isFinite(Number(offsetText))) {
    throw new Error("Usage: npm run bench -- mix.wav stem.wav|- reference.mid|reference.json [midiOffsetSeconds]");
  }
  const [mixFile, stemFile, refFile] = await Promise.all([
    readFile(mixPath), stemPath === "-" ? null : readFile(stemPath), readFile(refPath),
  ]);
  const reference = /\.json$/i.test(refPath) ? JSON.parse(refFile.toString("utf-8")) :
    midi.read(refFile, { offset: Number(offsetText) });
  if (!Array.isArray(reference) || !reference.length || reference.some(hit =>
    !["kick", "backbeat", "hat", "open-hat"].includes(hit?.lane) || !Number.isFinite(hit?.time),
  )) {
    throw new Error("Reference must contain mapped drum MIDI notes or an array of labeled hit times.");
  }
  compare(mixPath, decodeWave(mixFile), stemFile && decodeWave(stemFile), reference);
}
