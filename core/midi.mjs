export function createMidiTools() {
  const ppq = 960;
  const noteByLane = { kick: 36, backbeat: 38, hat: 42, "open-hat": 46 };
  const laneByNote = { 35: "kick", 36: "kick", 38: "backbeat", 39: "backbeat", 40: "backbeat",
    42: "hat", 44: "hat", 46: "open-hat" };

  function quantity(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0x0fffffff) {
      throw new RangeError("MIDI delta is out of range.");
    }
    const result = [value & 0x7f];
    while ((value >>>= 7) > 0) result.unshift((value & 0x7f) | 0x80);
    return result;
  }

  function write(hits, { bpm, start, end, clap = false }) {
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 400 || !Number.isFinite(start) ||
        !Number.isFinite(end) || end <= start) {
      throw new RangeError("Choose a valid BPM and time range.");
    }
    const tempo = Math.round(60000000 / bpm);
    const ticksPerSecond = 1000000 * ppq / tempo;
    const clipTicks = Math.max(1, Math.round((end - start) * ticksPerSecond));
    const tracks = new Map();
    for (const hit of hits) {
      const note = hit.lane === "backbeat" && clap ? 39 : noteByLane[hit.lane];
      if (note === undefined || !Number.isFinite(hit.time) || hit.time < start || hit.time >= end) continue;
      const tick = Math.min(clipTicks - 1, Math.round((hit.time - start) * ticksPerSecond));
      const velocity = Math.max(1, Math.min(127, Math.round(hit.velocity || 90)));
      if (!tracks.has(note)) tracks.set(note, new Map());
      const byTick = tracks.get(note);
      byTick.set(tick, Math.max(velocity, byTick.get(tick) ?? 0));
    }
    const messages = [];
    for (const [note, byTick] of tracks) {
      const starts = [...byTick.entries()].sort((a, b) => a[0] - b[0]);
      starts.forEach(([tick, velocity], index) => {
        const next = starts[index + 1]?.[0] ?? clipTicks;
        const off = Math.min(next, tick + Math.max(1, Math.round(0.024 * ticksPerSecond)));
        messages.push({ tick, note, velocity }, { tick: off, note, velocity: 0 });
      });
    }
    messages.sort((a, b) => a.tick - b.tick || Number(a.velocity > 0) - Number(b.velocity > 0) || a.note - b.note);
    const track = [
      0, 0xff, 0x51, 3, tempo >>> 16, (tempo >>> 8) & 255, tempo & 255,
      0, 0xff, 0x58, 4, 4, 2, 24, 8,
    ];
    let last = 0;
    for (const { tick, note, velocity } of messages) {
      track.push(...quantity(tick - last), velocity ? 0x99 : 0x89, note, velocity);
      last = tick;
    }
    track.push(...quantity(clipTicks - last), 0xff, 0x2f, 0);
    const file = new Uint8Array(22 + track.length);
    const view = new DataView(file.buffer);
    file.set([0x4d, 0x54, 0x68, 0x64], 0);
    view.setUint32(4, 6);
    view.setUint16(8, 0);
    view.setUint16(10, 1);
    view.setUint16(12, ppq);
    file.set([0x4d, 0x54, 0x72, 0x6b], 14);
    view.setUint32(18, track.length);
    file.set(track, 22);
    return file;
  }

  function read(bytes, { offset = 0 } = {}) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header = 0x4d546864;
    const trackTag = 0x4d54726b;
    if (view.byteLength < 14 || view.getUint32(0) !== header) throw new Error("Invalid MIDI header.");
    const headerLength = view.getUint32(4);
    const format = view.getUint16(8);
    const trackCount = view.getUint16(10);
    const division = view.getUint16(12);
    if (headerLength < 6 || format > 1 || !division || division & 0x8000) {
      throw new Error("Use a type 0 or 1 MIDI file with quarter-note timing.");
    }
    let position = 8 + headerLength;
    const notes = [];
    const tempos = [{ tick: 0, tempo: 500000 }];
    for (let track = 0; track < trackCount; track++) {
      if (position + 8 > bytes.length || view.getUint32(position) !== trackTag) {
        throw new Error("MIDI track header is missing.");
      }
      const end = position + 8 + view.getUint32(position + 4);
      if (end > bytes.length) throw new Error("MIDI track is truncated.");
      position += 8;
      const readByte = () => {
        if (position >= end) throw new Error("MIDI event is truncated.");
        return bytes[position++];
      };
      const readQuantity = () => {
        let value = 0;
        for (let i = 0; i < 4; i++) {
          const byte = readByte();
          value = value * 128 + (byte & 127);
          if (byte < 128) return value;
        }
        throw new Error("Invalid MIDI delta.");
      };
      let tick = 0;
      let running = 0;
      while (position < end) {
        tick += readQuantity();
        let status = readByte();
        if (status < 128) {
          position--;
          status = running;
          if (!running) throw new Error("Invalid MIDI running status.");
        }
        if (status === 0xff) {
          const type = readByte();
          const size = readQuantity();
          if (position + size > end) throw new Error("MIDI metadata is truncated.");
          if (type === 0x51 && size === 3) {
            const tempo = bytes[position] * 65536 + bytes[position + 1] * 256 + bytes[position + 2];
            if (tempo) tempos.push({ tick, tempo });
          }
          position += size;
          if (type === 0x2f) break;
        } else if (status === 0xf0 || status === 0xf7) {
          const size = readQuantity();
          position += size;
          running = 0;
          if (position > end) throw new Error("MIDI system message is truncated.");
        } else if (status >= 0x80 && status < 0xf0) {
          running = status;
          const type = status & 0xf0;
          const first = readByte();
          const second = type === 0xc0 || type === 0xd0 ? 0 : readByte();
          const lane = laneByNote[first];
          if (type === 0x90 && second && lane) notes.push({ tick, lane, velocity: second });
        } else {
          throw new Error("Unsupported MIDI message.");
        }
      }
      position = end;
    }
    tempos.sort((a, b) => a.tick - b.tick);
    notes.sort((a, b) => a.tick - b.tick);
    let tempoIndex = 0;
    let seconds = offset;
    return notes.map(({ tick, lane, velocity }) => {
      while (tempoIndex + 1 < tempos.length && tempos[tempoIndex + 1].tick <= tick) {
        const current = tempos[tempoIndex];
        const next = tempos[++tempoIndex];
        seconds += (next.tick - current.tick) * current.tempo / (division * 1000000);
      }
      const current = tempos[tempoIndex];
      return { time: seconds + (tick - current.tick) * current.tempo / (division * 1000000), lane, velocity };
    });
  }

  return { write, read, ppq };
}
