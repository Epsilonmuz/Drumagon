(() => {
  "use strict";

  const detector = createDetector();
  const sounds = createFixtureTools();
  const midi = createMidiTools();
  const ids = [
    "waveform", "wave", "waveRange", "waveCursor", "seek", "trackName", "trackMeta",
    "trackDuration", "playButton", "playIcon", "playLabel", "loopButton", "transportTime",
    "bpm", "halfTempo", "doubleTempo", "anchor", "setAnchor", "analysisSource", "barSpan",
    "previousBars", "nextBars", "selectionLabel", "map", "ruler", "lanes", "gridCursor",
    "analysisStatus", "hitLocation", "editLane", "editTime", "editVelocity", "hitOffset",
    "addHit", "deleteHit", "undoButton", "barChanges", "exportButton", "exportMenu", "exportClap",
    "exportSelection", "exportWhole", "demoButton", "loadButton", "loadStem", "audioFile",
    "stemFile", "dropOverlay", "toast",
  ];
  const ui = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  const auditionButtons = [...document.querySelectorAll("[data-audition]")];
  const state = {
    track: null, stem: null, mode: "mix", results: new Map(), audition: "original",
    bpm: 140, anchor: 0, gridTouched: false, cursor: 0, firstBar: 0, span: 4,
    muted: new Set(), loop: false, selected: null, id: 0,
  };
  let context;
  let analysisWorker;
  let analysisVersion = 0;
  let importVersion = 0;
  let playVersion = 0;
  let player;
  let animation;
  let toastTimer;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const active = () => state.results.get(state.mode);
  const list = () => active()?.hits ?? [];
  const duration = () => state.track?.buffer.duration ?? 0;
  const laneLabel = (id) => detector.lanes.find((lane) => lane.id === id)?.label ?? id;
  const noteName = (hit) => laneLabel(hit.lane) + " at " + (hit.time * 1000).toFixed(1) + " milliseconds";
  const selected = () => list().find((hit) => hit.id === state.selected);
  const formatTime = (time, decimals = false) => {
    const milliseconds = Math.round(Math.max(0, time) * 1000);
    const minutes = Math.floor(milliseconds / 60000);
    const seconds = String(Math.floor(milliseconds % 60000 / 1000)).padStart(2, "0");
    return minutes + ":" + seconds + (decimals ? "." + String(milliseconds % 1000).padStart(3, "0") : "");
  };

  function range() {
    const barSeconds = 240 / state.bpm;
    const total = Math.max(1, Math.ceil((duration() - state.anchor - 0.001) / barSeconds));
    const first = clamp(state.firstBar, 0, total - 1);
    const count = Math.min(state.span, total - first);
    const start = state.anchor + first * barSeconds;
    const width = count * barSeconds;
    return { barSeconds, first, count, total, start, width, end: Math.min(start + width, duration()) };
  }

  function currentContext() {
    const Audio = window.AudioContext ?? window.webkitAudioContext;
    if (!Audio) throw new Error("Open Drumagon in a browser with Web Audio support.");
    return context ??= new Audio();
  }

  function bufferFromPCM(pcm, rate) {
    const buffer = new AudioBuffer({ length: pcm.length, numberOfChannels: 1, sampleRate: rate });
    buffer.copyToChannel(pcm, 0);
    return buffer;
  }

  function mono(buffer) {
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
    if (channels.length === 1) return new Float32Array(channels[0]);
    let summed = 0;
    const energy = channels.map(() => 0);
    for (let index = 0; index < buffer.length; index += 23) {
      let mid = 0;
      channels.forEach((channel, i) => {
        energy[i] += channel[index] ** 2;
        mid += channel[index];
      });
      summed += (mid / channels.length) ** 2;
    }
    const loudest = energy.indexOf(Math.max(...energy));
    if (summed < 0.15 * energy[loudest]) return new Float32Array(channels[loudest]);
    const result = new Float32Array(buffer.length);
    for (const channel of channels) {
      for (let index = 0; index < result.length; index++) result[index] += channel[index] / channels.length;
    }
    return result;
  }

  function notify(message) {
    clearTimeout(toastTimer);
    ui.toast.textContent = message;
    ui.toast.hidden = false;
    toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 3900);
  }

  function stopAnalysis() {
    analysisVersion++;
    if (analysisWorker) {
      analysisWorker.terminate();
      analysisWorker = null;
    }
  }

  function processInputs({ mode, mix, stem }) {
    if (mode === "mix") return detector.analyze(mix.samples, mix.rate);
    const isolated = detector.analyze(stem.samples, stem.rate);
    if (mode === "stem") return isolated;
    return detector.combine(detector.analyze(mix.samples, mix.rate), isolated);
  }

  function finishAnalysis(result, version, mode, setGrid) {
    if (version !== analysisVersion) return;
    const hits = result.hits.filter((hit) => hit.time < duration()).map((hit) => ({
      ...hit, id: "hit-" + (++state.id),
    }));
    state.results.set(mode, { hits, undo: [], detected: hits.length });
    if (setGrid && !state.gridTouched) {
      state.bpm = result.bpm ?? 140;
      // This is a candidate bar start. Use the source playhead for the final bar alignment.
      state.anchor = clamp(result.downbeatCandidate, 0, Math.max(0, duration() - 0.001));
      state.cursor = state.anchor;
      writeGridInputs();
    }
    if (!hits.length && state.audition === "pattern") state.audition = "original";
    render();
  }

  function runAnalysis(mode, setGrid = false) {
    stopAnalysis();
    stopPlayback();
    state.mode = mode;
    state.selected = null;
    ui.analysisSource.value = mode;
    render();
    if (state.results.has(mode) || !state.track) return;
    const version = analysisVersion;
    const track = state.track;
    const stem = state.stem;
    const inputs = () => {
      const payload = { mode };
      if (mode !== "stem") payload.mix = { rate: track.buffer.sampleRate, samples: mono(track.buffer) };
      if (mode !== "mix" && stem) payload.stem = { rate: stem.buffer.sampleRate, samples: mono(stem.buffer) };
      return payload;
    };
    const payload = inputs();
    const fail = (message) => {
      if (version === analysisVersion) ui.analysisStatus.textContent = "Analysis failed. " + message;
    };
    const fallback = (fallbackPayload) => setTimeout(() => {
      if (version !== analysisVersion) return;
      try { finishAnalysis(processInputs(fallbackPayload ?? inputs()), version, mode, setGrid); }
      catch (error) { fail(error.message); }
    }, 0);
    if (!window.Worker) { fallback(payload); return; }
    const script = createDetector.toString() + "\nconst detector = createDetector();\n" +
      processInputs.toString() + "\nself.onmessage = (event) => {\n" +
      "  try { self.postMessage({ result: processInputs(event.data) }); }\n" +
      "  catch (error) { self.postMessage({ error: error.message }); }\n};";
    const url = URL.createObjectURL(new Blob([script], { type: "text/javascript" }));
    let worker;
    try { worker = new Worker(url); }
    catch { fallback(payload); }
    finally { URL.revokeObjectURL(url); }
    if (!worker) return;
    analysisWorker = worker;
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (analysisWorker === worker) analysisWorker = null;
      if (data.error) fail(data.error);
      else finishAnalysis(data.result, version, mode, setGrid);
    };
    worker.onerror = () => {
      worker.terminate();
      if (analysisWorker === worker) analysisWorker = null;
      fallback();
    };
    // The original AudioBuffer is retained for audition. Move the PCM copies to the worker.
    const transfer = [payload.mix?.samples.buffer, payload.stem?.samples.buffer].filter(Boolean);
    try { worker.postMessage(payload, transfer); }
    catch {
      worker.terminate();
      analysisWorker = null;
      fallback();
    }
  }

  function replaceTrack(track, demo = null) {
    stopPlayback();
    stopAnalysis();
    state.track = track;
    state.stem = demo ? { name: "Demo drum stem", buffer: bufferFromPCM(demo.stem, demo.rate) } : null;
    state.mode = "mix";
    state.audition = "original";
    state.results.clear();
    state.muted.clear();
    state.firstBar = 0;
    state.selected = null;
    state.bpm = demo?.bpm ?? 140;
    state.anchor = demo?.downbeat ?? 0;
    state.gridTouched = Boolean(demo);
    state.cursor = state.anchor;
    ui.trackName.textContent = track.name;
    ui.trackMeta.textContent = (track.buffer.sampleRate / 1000).toLocaleString("en-US") + " kHz · " +
      (track.buffer.numberOfChannels === 1 ? "Mono" : track.buffer.numberOfChannels === 2 ? "Stereo" :
        track.buffer.numberOfChannels + " channels") + (demo ? " · Built-in demo" : "");
    ui.trackDuration.textContent = formatTime(duration());
    ui.seek.max = String(Math.max(1, Math.round(duration() * 1000)));
    writeGridInputs();
    drawWave();
    runAnalysis("mix", !demo);
  }

  function loadDemo() {
    importVersion++;
    const demo = sounds.fixture();
    replaceTrack({ name: "Drill Pocket Study", buffer: bufferFromPCM(demo.mix, demo.rate) }, demo);
  }

  async function openFile(file, isStem = false) {
    if (!file) return;
    if (isStem && !state.track) { notify("Open the full mix first."); return; }
    const version = ++importVersion;
    try {
      const audio = await currentContext().decodeAudioData(await file.arrayBuffer());
      if (version !== importVersion) return;
      if (isStem) {
        stopPlayback();
        state.stem = { name: file.name, buffer: audio };
        state.results.delete("stem");
        state.results.delete("combined");
        const alignedLength = Math.abs(audio.duration - duration()) < 0.18;
        notify(alignedLength ? "Drum stem added." : "Stem and source lengths differ. Check that their first samples align.");
        runAnalysis("stem");
      } else {
        replaceTrack({ name: file.name, buffer: audio });
      }
    } catch {
      if (version === importVersion) notify("This audio could not be opened. Try a WAV or MP3 file.");
    }
  }

  function writeGridInputs() {
    ui.bpm.value = String(state.bpm);
    ui.anchor.value = state.anchor.toFixed(3);
  }

  function setGrid(bpm, anchor) {
    if (!Number.isFinite(bpm) || !Number.isFinite(anchor)) { writeGridInputs(); return; }
    stopPlayback();
    state.bpm = clamp(Math.round(bpm * 10) / 10, 20, 400);
    state.anchor = clamp(anchor, 0, Math.max(0, duration() - 0.001));
    state.gridTouched = true;
    state.firstBar = clamp(state.firstBar, 0, range().total - 1);
    if (state.cursor < state.anchor) state.cursor = state.anchor;
    writeGridInputs();
    render();
  }

  function drawWave() {
    const view = ui.wave.getBoundingClientRect();
    const w = Math.round(view.width * Math.min(devicePixelRatio, 2));
    const h = Math.round(view.height * Math.min(devicePixelRatio, 2));
    if (!w || !h) return;
    ui.wave.width = w;
    ui.wave.height = h;
    const canvas = ui.wave.getContext("2d");
    canvas.strokeStyle = "#303238";
    canvas.beginPath();
    canvas.moveTo(0, h / 2);
    canvas.lineTo(w, h / 2);
    canvas.stroke();
    if (!state.track) return;
    const buffer = state.track.buffer;
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    const bars = Math.max(1, Math.round(view.width / 2.6));
    const stride = Math.ceil(buffer.length / bars);
    const levels = new Float32Array(bars);
    let peak = 0;
    for (let bar = 0; bar < bars; bar++) {
      for (let index = bar * stride; index < Math.min((bar + 1) * stride, buffer.length); index += Math.max(1, Math.round(stride / 54))) {
        for (const pcm of channels) levels[bar] = Math.max(levels[bar], Math.abs(pcm[index]));
      }
      peak = Math.max(peak, levels[bar]);
    }
    const tint = canvas.createLinearGradient(0, 0, 0, h);
    tint.addColorStop(0, "#878e99");
    tint.addColorStop(0.50, "#c1c5ce");
    tint.addColorStop(1, "#777e89");
    canvas.fillStyle = tint;
    for (let bar = 0; bar < bars; bar++) {
      const size = Math.max(1, (levels[bar] / Math.max(0.04, peak)) ** 0.82 * h * 0.40);
      canvas.fillRect((bar + 0.25) * w / bars, h / 2 - size, Math.max(1, w / bars * 0.53), 2 * size);
    }
  }

  function renderCursor() {
    const time = state.cursor;
    ui.seek.value = String(Math.round(time * 1000));
    ui.seek.setAttribute("aria-valuetext", formatTime(time, true));
    ui.transportTime.value = formatTime(time, true);
    ui.waveCursor.style.left = 100 * time / Math.max(0.01, duration()) + "%";
    const view = range();
    const phase = (time - view.start) / view.width;
    ui.gridCursor.hidden = phase < 0 || phase >= 1;
    if (!ui.gridCursor.hidden) {
      ui.gridCursor.style.left = "calc(var(--lane-width) * " + (1 - phase) + " + " + phase * 100 + "%)";
    }
  }

  function renderTransport() {
    ui.playLabel.textContent = player ? "Pause" : "Play";
    ui.playIcon.textContent = player ? "Ⅱ" : "▶";
    ui.playButton.setAttribute("aria-label", player ? "Pause playback" : "Play selection");
    ui.loopButton.setAttribute("aria-pressed", String(state.loop));
    ui.playButton.disabled = !state.track;
    ui.loadStem.disabled = !state.track;
    ui.loadStem.textContent = state.stem ? "Replace stem" : "Add drum stem";
    ui.loadStem.title = state.stem?.name ?? "Open a drum stem with the same start time as the source audio";
    for (const button of auditionButtons) {
      button.disabled = button.dataset.audition === "stem" ? !state.stem :
        button.dataset.audition === "pattern" ? !list().length : !state.track;
      button.setAttribute("aria-pressed", String(button.dataset.audition === state.audition));
    }
  }

  function renderInspector() {
    const hit = selected();
    ui.editTime.disabled = !hit;
    ui.editVelocity.disabled = !hit;
    ui.deleteHit.disabled = !hit;
    ui.addHit.disabled = !active() || !duration();
    ui.editTime.max = String(Math.max(0, (duration() - 0.0001) * 1000));
    ui.editTime.value = hit ? (hit.time * 1000).toFixed(1) : "";
    ui.editVelocity.value = hit ? String(hit.velocity) : "";
    if (!hit) {
      ui.hitLocation.textContent = "Select a hit on the grid.";
      ui.hitOffset.value = "—";
      return;
    }
    ui.editLane.value = hit.lane;
    const view = range();
    const subdivision = view.barSeconds / 16;
    const fromStart = hit.time - state.anchor;
    const offset = (fromStart - Math.round(fromStart / subdivision) * subdivision) * 1000;
    ui.hitLocation.textContent = "Bar " + (Math.floor(fromStart / view.barSeconds) + 1) + " · " +
      (hit.evidence === "edited" ? "Edited hit" : hit.evidence === "review" ? "Review suggested" : "Detected hit");
    ui.hitOffset.value = (offset >= 0 ? "+" : "−") + Math.abs(offset).toFixed(1) + " ms";
  }

  function renderChanges(visible, view) {
    const slots = Array.from({ length: view.count }, () => new Set());
    for (const hit of visible) {
      const phase = (hit.time - view.start) / view.barSeconds;
      const step = Math.min(15, Math.round((phase - Math.floor(phase)) * 16));
      slots[Math.min(view.count - 1, Math.floor(phase))].add(hit.lane + ":" + step);
    }
    const base = slots[0];
    const nodes = [];
    for (let index = 1; index < slots.length; index++) {
      const added = [...slots[index]].filter((key) => !base.has(key)).length;
      const removed = [...base].filter((key) => !slots[index].has(key)).length;
      const row = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = "Bar " + (view.first + index + 1);
      const detail = document.createElement("span");
      detail.textContent = added || removed ? "+" + added + " / −" + removed + " steps" : "Same steps";
      row.title = "Compared at sixteenth-note resolution";
      row.append(title, detail);
      nodes.push(row);
    }
    if (!nodes.length || !visible.length) {
      const row = document.createElement("li");
      row.textContent = visible.length ? "Show two or more bars to compare." : "Patterns appear after detection.";
      ui.barChanges.replaceChildren(row);
    } else {
      ui.barChanges.replaceChildren(...nodes);
    }
  }

  function renderGrid(view) {
    const last = view.first + view.count;
    ui.selectionLabel.textContent = view.count === 1 ? "Bar " + last :
      "Bars " + (view.first + 1) + "–" + last + " of " + view.total;
    ui.previousBars.disabled = view.first === 0;
    ui.nextBars.disabled = last >= view.total;
    ui.map.style.setProperty("--bar", 100 / view.count + "%");
    ui.map.style.setProperty("--beat", 100 / (4 * view.count) + "%");
    ui.map.style.setProperty("--step", 100 / (16 * view.count) + "%");
    ui.ruler.replaceChildren(...Array.from({ length: view.count }, (_, index) => {
      const bar = document.createElement("span");
      bar.textContent = String(view.first + index + 1).padStart(2, "0");
      return bar;
    }));
    const visible = list().filter((hit) => hit.time >= view.start && hit.time < view.end);
    const rows = detector.lanes.map((lane) => {
      const hits = visible.filter((hit) => hit.lane === lane.id);
      const row = document.createElement("div");
      row.className = "lane-row";
      const label = document.createElement("button");
      label.type = "button";
      label.className = "lane-label";
      label.dataset.mute = lane.id;
      label.setAttribute("aria-pressed", String(state.muted.has(lane.id)));
      label.setAttribute("aria-label", "Mute " + lane.label + " in rebuilt playback");
      label.title = "Mute or unmute in rebuilt playback";
      const name = document.createElement("span");
      name.textContent = lane.label;
      const count = document.createElement("span");
      count.className = "lane-count readout";
      count.textContent = String(hits.length);
      label.append(name, count);
      const track = document.createElement("div");
      track.className = "lane-track" + (state.muted.has(lane.id) ? " is-muted" : "");
      track.dataset.lane = lane.id;
      track.title = "Click to seek. Double-click to add a hit.";
      for (const hit of hits) {
        const button = document.createElement("button");
        const percent = 100 * (hit.time - view.start) / view.width;
        button.type = "button";
        button.className = "hit" + (percent < 0.6 ? " at-start" : "");
        button.dataset.hit = hit.id;
        button.dataset.evidence = hit.evidence;
        button.setAttribute("aria-label", noteName(hit));
        button.setAttribute("aria-pressed", String(hit.id === state.selected));
        button.title = noteName(hit) + " · Velocity " + hit.velocity +
          (hit.evidence === "review" ? " · Review suggested" : "");
        button.style.left = percent + "%";
        button.style.setProperty("--height", Math.round(12 + hit.velocity / 127 * 21) + "px");
        track.append(button);
      }
      row.append(label, track);
      return row;
    });
    ui.lanes.replaceChildren(...rows);
    renderChanges(visible, view);
  }

  function render() {
    const view = range();
    ui.waveRange.style.left = 100 * view.start / Math.max(0.01, duration()) + "%";
    ui.waveRange.style.width = 100 * Math.max(0, view.end - view.start) / Math.max(0.01, duration()) + "%";
    ui.analysisSource.options[1].disabled = !state.stem;
    ui.analysisSource.options[2].disabled = !state.stem;
    const result = active();
    const review = list().filter((hit) => hit.evidence === "review").length;
    ui.analysisStatus.textContent = result ?
      result.detected + " detected · " + list().length + " in session" +
        (review ? " · " + review + " to review" : "") :
      "Analyzing " + (state.mode === "mix" ? "full mix" : state.mode === "stem" ? "drum stem" : "mix and stem") + "…";
    ui.undoButton.disabled = !result?.undo.length;
    ui.exportButton.disabled = !list().length;
    renderTransport();
    renderGrid(view);
    renderInspector();
    renderCursor();
  }

  function stopPlayback() {
    playVersion++;
    cancelAnimationFrame(animation);
    if (player) {
      const source = player.source;
      player = null;
      source.onended = null;
      try { source.stop(); } catch {}
      source.disconnect();
    }
    renderTransport();
  }

  function animate() {
    if (!player) return;
    const span = player.end - player.start;
    const passed = Math.max(0, context.currentTime - player.clock);
    state.cursor = player.loop ? player.start + (player.from - player.start + passed) % span :
      Math.min(player.end, player.from + passed);
    renderCursor();
    animation = requestAnimationFrame(animate);
  }

  async function startPlayback() {
    const version = ++playVersion;
    try {
      const audio = currentContext();
      await audio.resume();
      if (version !== playVersion || !state.track) return;
      const view = range();
      let buffer = state.audition === "stem" ? state.stem?.buffer : state.track.buffer;
      const end = Math.min(view.end, state.audition === "pattern" ? view.end : buffer?.duration ?? 0);
      if (end <= view.start) { notify("Choose a range with audio."); return; }
      let anchor = 0;
      if (state.audition === "pattern") {
        const hits = list().filter((hit) => hit.time >= view.start && hit.time < end && !state.muted.has(hit.lane));
        buffer = bufferFromPCM(sounds.renderHits(hits, audio.sampleRate, end - view.start, view.start), audio.sampleRate);
        anchor = view.start;
      }
      const from = state.cursor >= view.start && state.cursor < end - 0.014 ? state.cursor : view.start;
      const source = audio.createBufferSource();
      source.buffer = buffer;
      source.connect(audio.destination);
      source.loop = state.loop;
      source.loopStart = view.start - anchor;
      source.loopEnd = end - anchor;
      const clock = audio.currentTime + 0.012;
      player = { source, start: view.start, end, from, loop: state.loop, clock };
      source.onended = () => {
        if (player?.source !== source) return;
        source.disconnect();
        player = null;
        state.cursor = end;
        renderTransport();
        renderCursor();
      };
      if (state.loop) source.start(clock, from - anchor);
      else source.start(clock, from - anchor, end - from);
      renderTransport();
      animate();
    } catch (error) {
      stopPlayback();
      notify(error.message || "Audio playback could not start.");
    }
  }

  function changeCursor(time, followBars = false) {
    const playing = Boolean(player);
    stopPlayback();
    state.cursor = clamp(time, 0, duration());
    const view = range();
    if (followBars && (state.cursor < view.start || state.cursor >= view.end)) {
      const bar = clamp(Math.floor((state.cursor - state.anchor) / view.barSeconds), 0, view.total - 1);
      state.firstBar = Math.floor(bar / state.span) * state.span;
      render();
    } else {
      renderCursor();
    }
    if (playing) void startPlayback();
  }

  function selectHit(id) {
    state.selected = id;
    const hit = selected();
    if (hit) changeCursor(hit.time);
    for (const button of ui.lanes.querySelectorAll(".hit")) {
      button.setAttribute("aria-pressed", String(button.dataset.hit === id));
    }
    renderInspector();
  }

  function edit(next, selectedId = state.selected) {
    const result = active();
    if (!result) return;
    stopPlayback();
    result.undo.push({ hits: result.hits, selected: state.selected });
    if (result.undo.length > 50) result.undo.shift();
    result.hits = next.sort((a, b) => a.time - b.time);
    state.selected = selectedId;
    render();
  }

  function addHit(lane, time) {
    if (!active() || !duration()) return;
    const hit = { id: "hit-" + (++state.id), lane, time: clamp(time, 0, duration() - 0.0001),
      velocity: 92, evidence: "edited" };
    edit([...list(), hit], hit.id);
  }

  function updateHit(change) {
    const hit = selected();
    if (!hit) return;
    const changed = { ...hit, ...change, evidence: "edited" };
    edit(list().map((current) => current.id === hit.id ? changed : current));
  }

  function moveBars(step) {
    const view = range();
    stopPlayback();
    state.firstBar = clamp(view.first + step * state.span, 0, view.total - 1);
    state.cursor = range().start;
    state.selected = null;
    render();
  }

  function seekInGrid(event, element) {
    const rect = element.getBoundingClientRect();
    const view = range();
    const time = view.start + view.width * (event.clientX - rect.left) / rect.width;
    changeCursor(time);
    return time;
  }

  function menu(open) {
    ui.exportMenu.hidden = !open;
    ui.exportButton.setAttribute("aria-expanded", String(open));
  }

  function exportMidi(whole) {
    menu(false);
    const view = range();
    const start = whole ? 0 : view.start;
    const end = whole ? duration() : view.end;
    const hits = list().filter((hit) => hit.time >= start && hit.time < end);
    if (!hits.length) { notify("The selected range has no hits to export."); return; }
    const bytes = midi.write(hits, { bpm: state.bpm, start, end, clap: ui.exportClap.checked });
    const url = URL.createObjectURL(new Blob([bytes], { type: "audio/midi" }));
    const link = document.createElement("a");
    const name = state.track.name.replace(/\.[^./]+$/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
    link.href = url;
    link.download = (name || "Drumagon") + (whole ? "-full.mid" : "-bars-" + (view.first + 1) + "-" + (view.first + view.count) + ".mid");
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    notify("MIDI exported with the current hit timings.");
  }

  for (const { id, label } of detector.lanes) ui.editLane.add(new Option(label, id));
  ui.demoButton.onclick = loadDemo;
  ui.loadButton.onclick = () => ui.audioFile.click();
  ui.loadStem.onclick = () => ui.stemFile.click();
  ui.audioFile.onchange = () => { void openFile(ui.audioFile.files[0]); ui.audioFile.value = ""; };
  ui.stemFile.onchange = () => { void openFile(ui.stemFile.files[0], true); ui.stemFile.value = ""; };
  ui.playButton.onclick = () => { if (player) stopPlayback(); else void startPlayback(); };
  ui.loopButton.onclick = () => {
    const playing = Boolean(player);
    stopPlayback();
    state.loop = !state.loop;
    renderTransport();
    if (playing) void startPlayback();
  };
  for (const button of auditionButtons) button.onclick = () => {
    const playing = Boolean(player);
    stopPlayback();
    state.audition = button.dataset.audition;
    renderTransport();
    if (playing) void startPlayback();
  };
  ui.seek.oninput = () => changeCursor(Number(ui.seek.value) / 1000, true);
  ui.bpm.onchange = () => setGrid(ui.bpm.valueAsNumber, state.anchor);
  ui.anchor.onchange = () => setGrid(state.bpm, ui.anchor.valueAsNumber);
  ui.halfTempo.onclick = () => setGrid(state.bpm / 2, state.anchor);
  ui.doubleTempo.onclick = () => setGrid(state.bpm * 2, state.anchor);
  ui.setAnchor.onclick = () => setGrid(state.bpm, state.cursor);
  ui.analysisSource.onchange = () => runAnalysis(ui.analysisSource.value);
  ui.barSpan.onchange = () => {
    stopPlayback();
    state.span = Number(ui.barSpan.value);
    render();
  };
  ui.previousBars.onclick = () => moveBars(-1);
  ui.nextBars.onclick = () => moveBars(1);
  ui.ruler.onclick = (event) => seekInGrid(event, ui.ruler);
  ui.lanes.onclick = (event) => {
    const button = event.target.closest("[data-hit]");
    if (button) { selectHit(button.dataset.hit); return; }
    const mute = event.target.closest("[data-mute]");
    if (mute) {
      const lane = mute.dataset.mute;
      const playing = Boolean(player);
      stopPlayback();
      if (state.muted.has(lane)) state.muted.delete(lane);
      else state.muted.add(lane);
      render();
      if (playing) void startPlayback();
      return;
    }
    const lane = event.target.closest(".lane-track");
    if (lane) seekInGrid(event, lane);
  };
  ui.lanes.ondblclick = (event) => {
    if (event.target.closest("[data-hit]")) return;
    const lane = event.target.closest(".lane-track");
    if (lane) addHit(lane.dataset.lane, seekInGrid(event, lane));
  };
  ui.editLane.onchange = () => updateHit({ lane: ui.editLane.value });
  ui.editTime.onchange = () => {
    if (Number.isFinite(ui.editTime.valueAsNumber)) {
      updateHit({ time: clamp(ui.editTime.valueAsNumber / 1000, 0, duration() - 0.0001) });
    } else renderInspector();
  };
  ui.editVelocity.onchange = () => {
    if (Number.isFinite(ui.editVelocity.valueAsNumber)) {
      updateHit({ velocity: clamp(Math.round(ui.editVelocity.valueAsNumber), 1, 127) });
    } else renderInspector();
  };
  ui.addHit.onclick = () => addHit(ui.editLane.value, state.cursor);
  ui.deleteHit.onclick = () => edit(list().filter((hit) => hit.id !== state.selected), null);
  ui.undoButton.onclick = () => {
    const result = active();
    const previous = result?.undo.pop();
    if (!previous) return;
    stopPlayback();
    result.hits = previous.hits;
    state.selected = previous.selected;
    render();
  };
  ui.exportButton.onclick = () => menu(ui.exportMenu.hidden);
  ui.exportSelection.onclick = () => exportMidi(false);
  ui.exportWhole.onclick = () => exportMidi(true);
  document.addEventListener("click", (event) => { if (!event.target.closest(".export-wrap")) menu(false); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { menu(false); return; }
    if (event.code === "Space" && !event.target.closest("button,input,select") && state.track) {
      event.preventDefault();
      ui.playButton.click();
    }
  });
  window.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    ui.dropOverlay.hidden = false;
    event.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", (event) => {
    if (!event.relatedTarget || !event.clientX && !event.clientY) ui.dropOverlay.hidden = true;
  });
  window.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    ui.dropOverlay.hidden = true;
    void openFile(event.dataTransfer.files[0]);
  });
  if (window.ResizeObserver) new ResizeObserver(drawWave).observe(ui.waveform);
  else window.addEventListener("resize", drawWave);
  loadDemo();
})();
