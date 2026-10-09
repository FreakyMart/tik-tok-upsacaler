# Explainer Studio — Guide for AI agents

You are editing explainer videos (YouTube, faceless, "Psych2Go-style") **by writing JSON**.
Every video is one file: `projects/<name>/project.json`. The editor in the browser watches that
file and redraws the instant you save it, so the user sees your edit live. Nothing is hidden: what is
in the JSON is exactly what gets rendered, frame for frame.

## Workflow

1. Start the editor (once): `python studio.py serve` → <http://localhost:4100/editor/?project=NAME>
2. Edit `projects/NAME/project.json` (write the whole file or patch it).
3. Check your work:
   - `python studio.py validate NAME` — schema errors, missing files, bad names. **Run it after every edit.**
   - `python studio.py info NAME` — timeline: start/end second of every scene.
   - `python studio.py sheet NAME` — one PNG with a frame of every scene (`exports/NAME-sheet.png`). Look at it.
   - `python studio.py snapshot NAME 12.5` — exact frame at 12.5 s (`exports/NAME-12.50s.png`).
4. Export: `python studio.py render NAME` → `exports/NAME.mp4` (add `--scale 2` for 4K).

`python studio.py catalog` prints every template, animation, easing, shape, theme and transition the
engine supports (parsed from the engine source, so it is always current).

If you drive the browser instead of the file, the page exposes `window.studio`:
`getProject()`, `setProject(p)`, `update('scenes.intro.duration', 6)`,
`patchLayer(sceneId, layerId, {...})`, `addLayer(sceneId, layer)`, `addScene(scene, index)`,
`removeLayer`, `removeScene`, `select`, `seek(t)`, `play()`, `pause()`, `timeline()`, `snapshot(t)`, `undo()`, `redo()`.

## Project file

```jsonc
{
  "version": 1,
  "title": "أنماط التعلق",
  "width": 1920, "height": 1080, "fps": 30,       // 1080x1920 for Shorts
  "theme": "psych",                              // psych | midnight | clean | chalk
  "themeOverrides": { "colors": { "accent": "#FF3366" } },   // optional
  "defaultTransition": { "type": "slide", "duration": 0.7 }, // used when a scene has no transition
  "transitionSfx": "media/sfx/whoosh.mp3",       // optional: sound on every transition
  "audio": [
    { "src": "media/voice.mp3", "role": "voice", "start": 0 },
    { "src": "media/music.mp3", "role": "music", "volume": 0.3, "loop": true, "fadeOut": 2 }
  ],
  "scenes": [ /* played in order */ ]
}
```

Coordinates are project pixels: (0,0) top-left, (1920,1080) bottom-right, **center = (960,540)**.
Every layer is positioned by its **center** (`x`, `y`). Times inside a scene are seconds from the scene start.

Media paths: `media/...` is the shared `media/` folder; any other relative path is inside the project folder.

### Timing model

Scenes play back to back. A transition **overlaps** the end of a scene with the start of the next one,
so the video is shorter than the sum of durations. `studio.py info` prints the real start/end times;
use them to line scenes up with a voice-over.

## Scenes

```jsonc
{
  "id": "secure-list",          // unique, used in commands and overrides
  "duration": 6.5,              // seconds
  "template": "list",           // optional — see Templates
  "props": { ... },             // template content
  "overrides": { "title": { "size": 100, "color": "accent" } },  // tweak template layers by id
  "layers": [ ... ],            // custom layers, drawn on top of the template
  "background": "theme",        // or see Backgrounds
  "camera": { "from": { "zoom": 1 }, "to": { "zoom": 1.08 } },
  "transition": { "type": "glitch", "duration": 0.6 },   // into the NEXT scene
  "sfx": [ { "src": "media/sfx/pop.mp3", "at": 1.2 } ],   // sounds at scene times
  "notes": "voice-over text for this scene"               // free text, not rendered
}
```

### Templates (the fastest way to a professional result)

Prefer templates. They are laid out, timed and animated by the engine; you only provide content.

| template | props |
|---|---|
| `title` | `kicker`, `title`, `subtitle`, `highlight` (words to color) |
| `chapter` | `number` ("01"), `title`, `subtitle` |
| `list` | `title`, `items` (2–5 short strings) — items appear one by one across the scene |
| `statement` | `text` (one strong sentence), `highlight` (words to mark) |
| `quote` | `text`, `author` |
| `compare` | `leftTitle`, `left` (strings), `rightTitle`, `right` (strings) — ✓ vs ✗ columns |
| `image` | `src`, `caption`, `full` (true = full-bleed with caption bar) |
| `stat` | `value` (number, counts up), `prefix`, `suffix`, `label` |
| `outro` | `title`, `subtitle`, `cta` |

Template layer ids you can override (with `overrides`, or hide with `{"hidden": true}`):
- title: `kicker`, `title`, `underline`, `subtitle`
- chapter: `number`, `circle`, `title`, `subtitle`
- list: `title`, `titleLine`, `bullet1..n`, `num1..n`, `item1..n`
- statement: `text` · quote: `mark`, `text`, `author`
- compare: `divider`, `aTitle`, `bTitle`, `aMark1..n`, `aItem1..n`, `bMark1..n`, `bItem1..n`
- image: `image`, `caption` (+ `shade` when full) · stat: `value`, `label`, `underline`
- outro: `title`, `subtitle`, `cta`

## Layers

Common properties (all optional except `id` and `type`):

| prop | meaning |
|---|---|
| `x`, `y` | center position (px) |
| `scale`, `rotate` (deg), `opacity` (0–1), `blur` (px) | transform |
| `start`, `end` | visible from/to (scene seconds); default whole scene |
| `in`, `out` | `{ "type": ANIMATION, "duration": 0.7, "delay": 0, "ease": "outCubic", "distance": 70 }` |
| `loop` | `{ "type": "float"|"pulse"|"shake"|"spin"|"sway", "amount": n, "speed": n }` |
| `keyframes` | `[{ "t": 0, "x": 300 }, { "t": 2, "x": 900, "ease": "inOutCubic" }]` — props x, y, scale, rotate, opacity, blur |
| `shadow` | `true` or `{ "color", "blur", "y" }` |
| `blend` | canvas blend mode, e.g. `"multiply"` |
| `hidden`, `locked` | hide / prevent mouse edits |

Animations (`in`/`out`): `fade fadeUp fadeDown fadeLeft fadeRight slideLeft slideRight slideUp slideDown
zoomIn zoomOut pop blurIn reveal revealRtl draw typewriter words spin drop`.
`words` = word-by-word (best for titles), `typewriter` = letter by letter, `draw` = shapes draw themselves,
`reveal`/`revealRtl` = wipe in (use `revealRtl` for Arabic).

Easings: `linear`, `in/out/inOut` + `Quad Cubic Quart Expo Sine Back`, `outElastic`, `outBounce`.

### text
```json
{ "id": "t1", "type": "text", "text": "خوف من الهجر", "x": 960, "y": 540,
  "font": "display", "size": 80, "weight": 800, "color": "ink",
  "align": "center", "maxWidth": 1400, "lineHeight": 1.3,
  "highlight": ["الهجر"], "highlightStyle": "marker", "highlightColor": "accent",
  "box": { "color": "accent", "radius": 16, "padding": [14, 34] },
  "stroke": { "color": "bg", "width": 8 },
  "in": { "type": "words", "duration": 1 } }
```
- `font`: `display` (headings) / `body` / a family name (`Cairo`, `Tajawal`). Arabic is detected automatically (RTL).
- `highlightStyle`: `color` | `marker` | `underline`.
- Counter: `"count": { "from": 0, "to": 72, "suffix": "%", "duration": 1.6, "separator": ",", "arabicDigits": false }` (text is generated).

### image / video
```json
{ "id": "photo", "type": "image", "src": "media/couple.jpg", "x": 960, "y": 500,
  "width": 1200, "height": 680, "fit": "cover", "radius": 24, "mask": "circle",
  "kenburns": { "from": 1, "to": 1.15, "fromX": 0.5, "toX": 0.6 },
  "border": { "color": "surface", "width": 12 }, "shadow": true, "filter": "grayscale(1)" }
```
Video adds: `trim` (start offset in the file), `speed`, `volume`, `muted`, `repeat`. Video audio is mixed into the export.

### shape
```json
{ "id": "arrow1", "type": "shape", "shape": "arrow", "points": [[1140, 470], [1430, 300]], "curve": -0.15,
  "stroke": "ink", "strokeWidth": 6, "rough": true, "in": { "type": "draw", "duration": 0.6 } }
```
Shapes: `rect circle ellipse line arrow underline highlight check cross`.
Sized shapes use `width`/`height` (+ `radius` for rect). Lines/arrows use `points` (absolute px) or `width`.
`rough: true` = hand-drawn look (Rough.js; `roughness`, `seed`, `fillStyle`: hachure|solid|zigzag|cross-hatch|dots).
`fill` + `stroke` take colors. `highlight` is a translucent marker block (put it *before* the text in `layers`).

## Colors, themes, backgrounds

Colors are theme tokens — `bg surface ink muted accent accent2 accent3 line` — or any CSS color.
Use tokens so the whole video can be restyled by changing `theme`.

Backgrounds (`scene.background`):
- `"theme"` (default) or a color string
- `{ "type": "gradient", "colors": ["bg", "surface"], "angle": 135 }`
- `{ "type": "radial", "colors": ["surface", "bg"] }`
- `{ "type": "pattern", "pattern": "dots"|"grid"|"lines", "color": "line", "bg": "bg", "size": 40 }`
- `{ "type": "image"|"video", "src": "...", "dim": 0.3, "blur": 6, "tint": "accent", "kenburns": { "from": 1, "to": 1.1 } }`

Camera (moves the whole scene): `{ "from": { "zoom": 1, "x": 0, "y": 0, "rotate": 0 }, "to": {...}, "ease": "inOutSine" }`
or keyframes `[{ "t": 0, "zoom": 1.2, "x": -200 }, { "t": 3, "zoom": 1 }]` (x/y shift the view in px).

## Transitions

`scene.transition = { "type": NAME, "duration": 0.8, "ease": "inOutSine", "params": {...} }` — into the next scene.
Friendly names: `cut fade dissolve fadeblack fadewhite zoom zoomin zoomout slide slideleft slideright slideup
slidedown push wipe wipeleft wiperight wipeup wipedown warp glitch glitch2 datamosh blur circle circleclose burn
filmburn ink pixel ripple swirl cube flip page doorway morph dreamy tv static blinds squares hexagon heart radial
wind mosaic overexposure whip`. Any of the ~120 gl-transitions shader names also works
(`python studio.py catalog --full` lists them with their params).

## Audio

`project.audio[]`: `{ src, role: voice|music|sfx, start, trim, duration, volume, fadeIn, fadeOut, loop, duck }`.
Music is automatically ducked (lowered) under `voice` tracks in the export. A ready whoosh lives at `media/sfx/whoosh.mp3`.

## Making it look professional (explainer style rules)

- Change something on screen every 2–4 s: a new item, a camera move, a highlight, an arrow drawing in.
- One idea per scene; short on-screen text (it supports the voice, it does not repeat it).
- Use a `chapter` scene to open each section, `list`/`compare` for content, `statement` for key sentences.
- Vary transitions but keep them short (0.5–0.9 s); `glitch`/`whip` for energy, `fade`/`dissolve`/`ink` for calm.
- Give every scene a subtle camera move (`zoom` 1 → 1.06) so nothing is ever fully static.
- Time scenes to the voice-over: put the script in `notes`, then match `duration`s using `studio.py info`.
- Arabic text: use `revealRtl` (not `reveal`), `align: "right"` for paragraphs, `direction: "rtl"` on underline/arrow shapes that should draw right-to-left.
- Always finish with `validate` and look at the `sheet` before telling the user it is done.
