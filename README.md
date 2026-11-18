# Drumagon 0.1.0

Drumagon is an offline Epsilon Sounds drum transcription prototype. It finds drum attacks in WAV and MP3 audio, shows where they land on an editable bar grid, and exports the timing and velocities to MIDI. The included Drill Pocket Study has a distorted bass layer, off-grid hats, and two seven-hit triplet rolls.

## Open the app

1. Unzip the folder and open **Drumagon.html** in Chrome on your Mac. The compiled file contains the app, fonts and demo and runs without a server or installation.
2. Press **Play** to hear the demo. Switch between **Original**, **Stem**, and **Rebuilt** to compare the mix, the isolated demo drums, and the detected timing played by a synthesized kit.
3. Select **Open audio** or drop a WAV or MP3 onto the page. Check the suggested BPM and adjust **Bar 1** in seconds or choose **Set at playhead**. Use **×2** or **÷2** for a half-time or double-time reading.
4. If you have a separately rendered drum stem, choose **Add drum stem**. Both files should start at the same point. Try **Full mix**, **Drum stem**, and **Combined** under Detection to see how the results differ. Edits are kept with the active detection input for the current session.
5. Select a hit to edit its instrument, time, or velocity. Double-click an empty place on a lane to insert a hit. Use the bar arrows and **Loop** to listen to a section. Clicking the waveform seeks through the track.

Open **Control guide** in the toolbar for color diagrams and explanations of the controls.

## Take the pattern to FL Studio

Choose **Export MIDI**, then **Selected bars** or **Whole track**. A selected export starts at the selected bar. A full export starts at audio time zero and includes any hits that precede bar 1. The export preserves detector offsets and user edits along with the current tempo and 4/4 metadata. If you want a pickup before the selected bar, include an earlier bar or export the whole track.

Use **Import MIDI file** in the Piano Roll for FPC. Assign your kit to GM pitches 36 (kick), 38 (snare), 42 (closed hat) and 46 (open hat). Turn on the export menu's clap option to use pitch 39 for the snare/clap lane. Match the project tempo to the source to audition timing in milliseconds. Keep *Realign events* unchecked when preserving silence before the first hit. Drumagon writes 960 PPQ. The event resolution in the FL Studio project can affect what you hear after import. [Image-Line MIDI import](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/pianoroll_midi.htm) · [FPC pad mapping](https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/plugins/FPC.htm)

## Accuracy at this stage

The app uses a multiband transient detector. It analyzes kicks, snare/clap, and hats within the direct audio signal. It can incorporate a stem that you load. Open and closed hats and relative velocity are estimates. The grid assumes fixed tempo and 4/4. The BPM suggestion may identify the half-time pulse, and the first kick is a candidate for bar 1.

The first benchmark measures kick, snare/clap and hat detections at ±10, ±20 and ±50 ms, with one-to-one matches. Both hat articulations count toward the hat score. The timed reference is the original list of events used to synthesize each test clip. Clean scores on those clips test the engine and its timing. Released records and your FL Studio projects provide the next accuracy test.

| Synthetic clip | Input | Kick F1 | Snare/Clap F1 | Hat F1 |
| --- | --- | --- | --- | --- |
| Drill Pocket Study, 140 BPM | Full mix | 1.000 | 1.000 | 1.000 |
| Dembow, louder backing | Full mix | 1.000 | 1.000 | 1.000 |
| Drill, stronger bass and different kit | Full mix | 0.970 | 1.000 | 1.000 |
| Drill, stronger bass and different kit | Supplied drum stem | 1.000 | 1.000 | 1.000 |

The table uses a ±20 ms match window. All three clips were used while developing the detector. The stronger-bass mix missed two kicks and the supplied stem recovered those hits. The drum-free bass and keys test still produces a small number of false kicks.

## Rebuild and measure

Node.js is needed for the source and benchmark commands.

```sh
node tools/build.mjs
node --test tests/core.test.mjs
node tools/benchmark.mjs
```

Export your **full mix**, **drum-only stem**, and **drum-only MIDI** for the same stretch of an FL Studio project. Keep their starting points aligned. Use General MIDI pitches for the reference. If the MIDI clip begins later than the WAV, enter its start time in seconds as the last argument.

```sh
node tools/benchmark.mjs "full-mix.wav" "drums.wav" "drums.mid"
```

Replace the stem path with `-` to score the mix alone. Use a JSON reference file for audio onset labels when sample attacks start later than their MIDI triggers. JSON contains an array of objects with `lane` (`kick`, `backbeat`, `hat`, or `open-hat`) and `time` in seconds.

The project includes the synthesis fixture, score matching, MIDI codec, background-worker detector, and browser UI source. The Epsilon Sounds hallmark, Epsilon Dial typefaces, and graphite, platinum and champagne controls follow the supplied brand pack. The typeface license is included in `assets/LICENSE.txt`.
