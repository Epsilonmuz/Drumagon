import assert from "node:assert/strict";
import test from "node:test";
import { createDetector } from "../core/detector.mjs";
import { createFixtureTools } from "../core/fixture.mjs";
import { createMidiTools } from "../core/midi.mjs";
import { matchTimes, score } from "../core/score.mjs";

test("timing scorer matches each detection at most once and chooses the nearest reference", () => {
  const error = matchTimes([0, 0.04], [0.022], 0.03);
  assert.equal(error.length, 1);
  assert.ok(Math.abs(error[0] + 0.018) < 1e-10);
  assert.equal(matchTimes([0, 0.04], [0.021, 0.045], 0.03).length, 2);
});

test("a 30 ms shift fails strict timing while scoring at 50 ms", () => {
  const hits = Array.from({ length: 16 }, (_, index) => ({ lane: "hat", time: index * 15 / 140 }));
  const shifted = hits.map((hit) => ({ ...hit, time: hit.time + 0.03 }));
  const rows = score(hits, shifted).filter(({ lane }) => lane === "hat");
  assert.deepEqual(rows.map(({ f1 }) => f1), [0, 0, 1]);
});

test("960 PPQ export keeps leading space, close hits, velocities and simultaneous lanes", () => {
  const midi = createMidiTools();
  const hits = [
    { lane: "hat", time: 1.007, velocity: 62 },
    { lane: "kick", time: 1.007, velocity: 123 },
    { lane: "backbeat", time: 1.04273, velocity: 94 },
    { lane: "hat", time: 1.04273, velocity: 85 },
    { lane: "open-hat", time: 1.07846, velocity: 127 },
    { lane: "kick", time: 2, velocity: 88 },
  ];
  const bytes = midi.write(hits, { bpm: 140, start: 1, end: 2, clap: true });
  const decoded = midi.read(bytes, { offset: 1 });
  assert.equal(new DataView(bytes.buffer).getUint16(12), 960);
  assert.equal(decoded.length, 5);
  for (const hit of hits.slice(0, -1)) {
    const read = decoded.find((event) => event.lane === hit.lane && event.velocity === hit.velocity);
    assert.ok(read);
    assert.ok(Math.abs(read.time - hit.time) < 0.000224);
  }
});

test("silent input produces no hits or invented tempo", () => {
  const result = createDetector().analyze(new Float32Array(48000), 48000);
  assert.deepEqual(result.hits, []);
  assert.equal(result.bpm, null);
});

test("a transient at sample zero survives analysis", () => {
  const { renderHits } = createFixtureTools();
  const detector = createDetector();
  const rate = 48000;
  const audio = renderHits([{ lane: "kick", time: 0, velocity: 115 }], rate, 0.3);
  const found = detector.analyze(audio, rate).hits.find(({ lane }) => lane === "kick");
  assert.ok(found && found.time < 0.015);
});

test("the built-in drill stem retains the seven-note triplet rolls", () => {
  const { fixture } = createFixtureTools();
  const detector = createDetector();
  const clip = fixture();
  const hits = detector.analyze(clip.stem, clip.rate).hits;
  const rolls = clip.events.filter((hit) => hit.lane === "hat" && hit.time > clip.downbeat + 15 * 60 / clip.bpm &&
    hit.time < clip.downbeat + 16 * 60 / clip.bpm);
  const hatTimes = hits.filter(({ lane }) => detector.family(lane) === "hat").map(({ time }) => time);
  assert.equal(rolls.length, 7);
  assert.equal(matchTimes(rolls.map(({ time }) => time), hatTimes, 0.010).length, rolls.length);
});

test("drum-free backing keeps hat and snare false hits out of the demo benchmark", () => {
  const { fixture } = createFixtureTools();
  const { accompaniment, rate } = fixture({ variant: 2 });
  const hits = createDetector().analyze(accompaniment, rate).hits;
  assert.ok(hits.every(({ lane }) => lane === "kick"));
  assert.ok(hits.length <= 8);
});
