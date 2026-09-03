# The Shed

A practice tool for learning parts of audio/video recordings by ear: slow a passage down
without changing its pitch, loop it, and drill it until it sticks. It works on your own
files, or on a YouTube video.

No install and no account. Local files never leave your machine — there's no upload and no
server involved. A YouTube link plays through YouTube's own embedded player, which comes
with the limits listed further down.

## Run it

**For local files**, double-click `index.html` (Chrome or Edge recommended — they have the
best pitch-preserving playback and the widest codec support). Then drag an audio or video
file onto the window, or click **Open file…**.

**For YouTube**, the page has to be served over `http(s)` rather than opened off disk — the
embedded player refuses to talk to a `file://` page, and the app will tell you so. Use the
hosted copy, or serve the folder locally:

    npx http-server -p 8080

Then paste a link into the bar at the top and hit **Load**, drop a link onto the window, or
just paste one anywhere on the page. `watch?v=…`, `youtu.be/…`, `/embed/…`, `/shorts/…`,
`/live/…` and a bare 11-character video id all work, and a `?t=` in the link (`90`, `1m30s`,
`1h2m3s`) starts you at that point.

## What it does

**Slow down** — 20%–200% via the slider, the preset buttons (50/65/75/85/100), or `↑`/`↓`.
"Keep pitch" is on by default, so a solo slowed to 50% stays in the same key. On YouTube the
speed works differently — see below.

**Loop a section** — drag across the waveform to mark a section, or hit `A` and `B` on the
fly while it plays. Drag the A/B markers to adjust, or nudge them in 0.1s steps with the
`−`/`+` buttons (`Q`/`W` for A, `O`/`P` for B). Click anywhere on the waveform to seek;
scroll to zoom in on it, shift-scroll to pan.

**Work through a piece** — once a section is learned, **Next ▶** (`]` or `N`) moves the
whole A→B window on by its own length, so the next passage of the same size is already
looping; **◀ Prev** (`[`) steps it back. Handy for drilling a solo bar by bar. The window
keeps its length and stops at either end of the recording.

**Save sections** — name a section and it's stored: for a file, against its name and size;
for a YouTube video, against its video id. Open the same thing later and your sections,
speed and last position come back with it. Keys `1`–`9` recall the first nine.

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
| `↑` `↓` | speed ±5% (shift: ±1%) — on YouTube, one step along its rate list |
| `0` | speed back to 100% |
| `Q` `W` | nudge A ∓0.1s |
| `O` `P` | nudge B ∓0.1s |
| `Z` / `X` | zoom to loop / zoom out |
| `M` | mute |
| `1`–`9` | recall saved section |
| `?` | shortcuts |

## Working with YouTube

The player is YouTube's, not ours, and it gives up a good deal less than a local file does.
These are real limits of the embed rather than things the app has chosen not to do:

- **Speed is a fixed list.** YouTube plays at 25, 50, 75, 100, 125, 150, 175 and 200% and
  nothing in between, so the slider is swapped for buttons showing the rates it actually
  offers. 65% and 85% — two of the presets that work on files — simply don't exist here.
  `↑`/`↓` step along the list instead of moving in 5% increments.
- **Pitch is always preserved.** There's no switch to turn it off, so "keep pitch" shows
  ticked and disabled.
- **No waveform.** The audio sits in a cross-origin frame and can't be read, so the timeline
  falls back to a plain ruler with the A/B markers on it. Dragging out a section, clicking to
  seek and scrolling to zoom all still work.
- **Loop edges are softer.** The player reports its clock only a few times a second and
  seeking takes a moment, so a loop wraps within about a tenth of a second of B rather than a
  hundredth. Short loops won't feel as tight as they do on a file, and frame stepping with
  `,`/`.` is jumpier.
- **Clicking inside the player hands it the keyboard.** Click the waveform to get the
  shortcuts back.
- Videos whose uploader has disabled embedding can't be played at all, and YouTube may run
  ads. Both are theirs to decide.

If you need exact speeds, a waveform and tight loop points on something that happens to live
on YouTube, practising against a local file is still the better tool.

## Notes

- The waveform is drawn by decoding the file's audio in the browser. Files over 200 MB
  aren't decoded automatically — there's a **Generate waveform** button instead. If a
  container can't be decoded, the timeline, looping and speed control all still work.
- Playback of local files uses the browser's own decoder, so anything Chrome can play works:
  MP3, M4A, WAV, FLAC, OGG, Opus, MP4, MOV, WebM. MKV and some AVI files won't play.
- Saved sections live in this browser's local storage, keyed by file name + size, or by
  YouTube video id. Use **Export** if you want them backed up.

## License

MIT — see [LICENSE](LICENSE). Use it, fork it, ship it.
