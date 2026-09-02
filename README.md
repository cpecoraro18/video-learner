# The Shed

A practice tool for learning parts of audio/video recordings by ear: slow a passage down
without changing its pitch, loop it, and drill it until it sticks.

No install, no server, no upload — it's a plain web page and your files never leave your machine.

## Run it

Double-click `index.html` (Chrome or Edge recommended — they have the best
pitch-preserving playback and the widest codec support).

Then drag an audio or video file onto the window, or click **Open file…**.

## What it does

**Slow down** — 20%–200% via the slider, the preset buttons (50/65/75/85/100), or `↑`/`↓`.
"Keep pitch" is on by default, so a solo slowed to 50% stays in the same key.

**Loop a section** — drag across the waveform to mark a section, or hit `A` and `B` on the
fly while it plays. Drag the A/B markers to adjust, or nudge them in 0.1s steps with the
`−`/`+` buttons (`Q`/`W` for A, `O`/`P` for B). Click anywhere on the waveform to seek;
scroll to zoom in on it, shift-scroll to pan.

**Save sections** — name a section and it's stored for that file. Reopen the file later
(same name and size) and your sections, speed and last position come back. Keys `1`–`9`
recall the first nine.

**Practice helpers**
- *Rep counter* — how many times you've been through the loop.
- *Speed ramp* — start at, say, 60% and add 5% every 3 reps up to 100%. The app raises
  the speed for you as you repeat, so you work up to tempo without touching anything.
- *Rest between reps* — a 1–2s pause at the top of each loop to reset your hands.

**Export / Import** — writes all your saved sections to a JSON file, for backup or for
moving to another browser or machine.

## Keyboard

| | |
|---|---|
| `Space` | play / pause |
| `A` / `B` | set loop start / end |
| `L` | toggle looping |
| `C` | clear loop |
| `R` | jump to loop start |
| `S` | save current section |
| `←` `→` | seek 5s (shift: 1s, alt: 0.1s) |
| `,` `.` | step one frame |
| `↑` `↓` | speed ±5% (shift: ±1%) |
| `0` | speed back to 100% |
| `Q` `W` | nudge A ∓0.1s |
| `O` `P` | nudge B ∓0.1s |
| `Z` / `X` | zoom to loop / zoom out |
| `M` | mute |
| `1`–`9` | recall saved section |
| `?` | shortcuts |

## Notes

- The waveform is drawn by decoding the file's audio in the browser. Files over 200 MB
  aren't decoded automatically — there's a **Generate waveform** button instead. If a
  container can't be decoded, the timeline, looping and speed control all still work.
- Playback uses the browser's own decoder, so anything Chrome can play works: MP3, M4A,
  WAV, FLAC, OGG, Opus, MP4, MOV, WebM. MKV and some AVI files won't play.
- Saved sections live in this browser's local storage, keyed by file name + size.
  Use **Export** if you want them backed up.

## License

MIT — see [LICENSE](LICENSE). Use it, fork it, ship it.
