# Voxel Volley — Body Editor

A free, static, web-based level editor for **Voxel Volley** `VoxelBody` assets.
Designers build voxel models cube-by-cube in 3D (or layer-by-layer from the
bottom up), set up the crate economy, and export a Unity `.asset` file that
drops straight into the project — the exporter reproduces the Unity YAML
format **byte-for-byte** (verified against a real asset round-trip).

Everything runs in the browser. No accounts, no server, no build step, no
paid services: host it on GitHub Pages for free.

![Editor screenshot](docs/screenshot.png)

## Quick start (hosting on GitHub Pages)

1. Create a GitHub repository and push this folder to it:

   ```bash
   cd voxel-body-editor
   git init -b main            # if not already a repo
   git add -A && git commit -m "Voxel body editor"
   git remote add origin https://github.com/<you>/voxel-body-editor.git
   git push -u origin main
   ```

2. In the repo: **Settings → Pages → Source: Deploy from a branch**,
   branch `main`, folder `/ (root)`. Save.

3. After a minute the editor is live at
   `https://<you>.github.io/voxel-body-editor/`. Share that URL with the team.

> Local development: ES modules need an HTTP server (not `file://`).
> Run `npm start` (or `python3 -m http.server`) in the repo folder and open
> `http://localhost:8000`.
>
> Tests: `npm test` runs the dependency-free suite (format round-trip against
> every asset in the Unity project, the slice-axis mapping, edit operations).
> `npm run test:browser` drives the real UI in headless Chrome and needs
> `npm i --no-save playwright-core` plus Google Chrome.

## Team workflow (2–3 people, all free)

- **Designers** open the Pages URL, build models, and click **Export .asset**.
- The exported file goes into the Unity project's `Assets/` folder next to the
  existing VoxelBody assets, then into the levels list. Unity generates the
  `.meta`; the asset already carries the right script GUID.
- **Shared levels:** commit `.asset` files into this repo (e.g. under
  `levels/`) and list them in [`levels/index.json`](levels/index.json):

  ```json
  [
    { "name": "Bird (sample)", "path": "samples/bird.asset" },
    { "name": "Rocket v2",     "path": "levels/rocket_v2.asset" }
  ]
  ```

  Everyone then sees them in the editor's **Library → Team levels** tab and
  can load them with one click. Git is the source of truth and the review
  trail.
- Each browser also keeps a private **library** (IndexedDB) with thumbnails,
  and **autosaves** the open model continuously, so a closed tab or crash
  loses nothing.

## Features

| Area | What you get |
|---|---|
| 3D editing | Click a face (or the floor grid) to place a cube, right-click to remove; ghost preview; orbit/pan/zoom camera; auto-spin; slice highlighting; **isolate** to hide everything past the current slice so you can build *inside* a solid body; PNG screenshots |
| Slice editing | Cut along **any axis** — top view (stack layers bottom-up), front view (the elevation a sprite is drawn in), side view — with onion skin, occupancy strip, coordinate overlay, and a **tracing image** you can load behind the grid to draw over |
| Tools | Build, paint, rectangle, **line**, erase, flood fill (slice area / 3D connected region), colour picker, unit placement; **brush sizes 1–4**; mirror-X / mirror-Z symmetry with live preview of every mirrored footprint |
| Slice ops | Copy / paste a slice, duplicate it onto the neighbour and follow (hand extrusion), fill or empty a slice in one click |
| Build grid | Any cube size (slider, number field or presets) — see below; the model keeps its place when you resize and nothing that fits is ever cut |
| Model ops | Flip X/Y/Z, rotate 90°, shift on any axis, hollow (remove enclosed interior), **centre** on the floor, **trim** the grid down to the model, undo/redo (memory-bounded history) |
| Colours | The game's six (Y O R G B + X wildcard) with the real art hexes, each recolourable and relabellable; **ship your colours inside the asset** so the game renders exactly what you see (see below); add your own past those six; swap one colour for another or delete every voxel of a colour model-wide |
| Import | Unity `.asset` (file or pasted YAML), MagicaVoxel `.vox` (colours mapped to the game palette, near-greys → X wildcard), PNG voxelizer approximating the Unity pipeline |
| Export | Unity `.asset` byte-identical format, robust download fallbacks, copy-as-YAML, PNG screenshot |
| Level design | Layer rules, unit rules, the real 5-column crate board (column-major, per-crate flags, per-column refills) with auto-fill, ammo stats that include the checkered shell the game adds, validation for the traps the format hides (Auto cells inheriting an Empty refill, invalid unit kinds, units on empty cells, out-of-range colours, unit-rule mismatches, disconnected islands) |
| Comfort | Keyboard shortcuts (press `?`), editable display palette, autosave, model library with thumbnails, shared team levels |

## Build grid size

The **Model** tab sets the grid: type a size, drag the slider, or take a preset
(7 … 96). The model keeps its position when you resize, and shrinking only warns
when voxels genuinely have to be cut — anything that still fits is preserved, so
a body resting on the floor survives being shrunk. `trim` resizes to fit the
model exactly without losing anything.

Sizes are **not** capped to `VoxelBody.size`'s `[Range(3, 24)]`. That attribute
only limits the inspector slider, not what deserializes, and `VoxelCore` is
written for a variable grid — so any size imports and plays. Raise that `Range`
in `VoxelBody.cs` if you want to drag the size in the inspector too, since a
slider capped at 24 would otherwise snap a larger value down and leave `IsBaked`
false.

The only ceiling here is `MAX_N` in [`js/state.js`](js/state.js), currently
**128**, and it is about browser memory rather than the format or the game.
Measured round-trip cost (all byte-identical):

| grid | cells | .asset | export | parse |
|---|---|---|---|---|
| 32³ | 32,768 | 0.1 MB | 4 ms | 3 ms |
| 64³ | 262,144 | 1.0 MB | 30 ms | 16 ms |
| 96³ | 884,736 | 3.4 MB | 89 ms | 45 ms |
| 128³ | 2,097,152 | 8.0 MB | 228 ms | 90 ms |

Undo keeps whole-grid snapshots, so its history is bounded by bytes as well as by
step count — at 14³ that is the full 200 steps, and on a very large grid it keeps
as many as fit rather than exhausting the tab. Raise `MAX_N` if you need more; it
is one number.

Remember that every body spans the same world size in game
(`VoxelCore.ModelWorldSize`), so a bigger grid means **finer voxels**, not a
bigger model — and with `wrapInShell` on, the shell scales with it too (the Model
tab shows both counts).

## Colours: indices, and the palette that resolves them

A voxel stores a **colour index**, one byte, never a hex code — and that is not a
storage trick. The index is the key the core mechanic matches on:

```csharp
// VoxelCore.cs — a bullet can only destroy a voxel it matches
Matches(byte bullet, byte voxel) => bullet == Cols.W || voxel == Cols.X || bullet == voxel;
```

Crates are minted in a colour index too (`CrateSpec.Colour`), and
`Cols.CrateColourCount` sizes the demand arrays in `BalanceSim` and
`CratePlanAnalysis`. So a voxel's colour has to come from a small closed set —
with arbitrary RGB there would be 16.7M possible voxel colours and a bullet could
essentially never equal one.

What each index **looks like** is a separate question, and the asset can answer it.
Tick **Ship colours with this asset** on the Model tab (editing any swatch ticks it
for you) and the palette is written into the `.asset` as `VoxelBody.palette`, a
`Color32` per index:

```yaml
  palette:
  - {r: 232, g: 201, b: 58, a: 255}
  - {r: 245, g: 146, b: 11, a: 255}
  - {r: 0, g: 255, b: 0, a: 255}      # this body's R renders bright green
  ...
```

`Palette.SetActive` points rendering at it when the level is built, so the game
draws exactly the colours you picked — no code change per palette. Untick it and
the body falls back to the shared `Palette.cs`, and the field is dropped from the
asset entirely, which is why every asset authored before this still exports
byte-for-byte as imported.

Adding colours **past the six** works the same way, with one caveat that the
palette cannot fix: `Cols` still has no constant for index 6, so no crate can be
minted in it and the voxel can never be shot. Those swatches are flagged red and
Stats reports them as an error. To make a seventh colour fully real:

1. `Runtime/Core/VoxelCore.cs` — add the constant to `Cols`, and raise
   `CrateColourCount` **only if** crates should carry it (that constant sizes
   colour arrays across the runtime, the sim and the 5-column crate grid, so it is
   a real design change).
2. Raise `GAME_COLOURS` in [`js/palette.js`](js/palette.js).
3. Re-run the project's tests and `Voxel Volley → Validate Voxel Bodies`.

`Palette.Colours` no longer needs touching for a new colour if the body ships its
own palette — only `Cols` does, because that is the gameplay half.

## Editing the format

`js/asset.js` is the single place that reads/writes the Unity YAML. The
exporter mirrors the exact field order of assets produced by the Unity tool.
If `VoxelBody.cs` gains fields, extend `parseAsset`/`exportAsset` together and
re-verify a round-trip (import a Unity-made asset, export, `diff`).

Grid layout (verified against the Unity project's `VoxelCore.CellIdx` and the
ECS renderer): the `colours`/`units` hex strings encode a `size³` cube, two hex
chars per cell, index `(x*size + y)*size + z` where **x = width, y = height
(y 0 = bottom), z = depth**. Colour bytes: `ff` empty, `00`–`04` = Y O R G B,
`05` = X grey wildcard (any bullet colour destroys it). Unit bytes: `00` none,
`01` armoured, `04` hidden — bomb/rocket are boosters, never voxels. `depth`
is only the voxelizer parameter stored on the asset. The script GUID is
editable under **Model → Unity wiring**.

## Tech

Plain ES modules — no framework, no bundler, nothing to install. Three.js
(vendored in `vendor/`, MIT) renders the 3D view with an instanced mesh and
raycast picking. State lives in one module with an event bus; every mutation
goes through it, so undo/autosave/views can't drift apart.

```
index.html          app shell + import map
css/style.css
js/state.js         state, undo, events, (de)serialization
js/asset.js         Unity .asset YAML read/write (format-critical)
js/tools.js         all edit operations + symmetry + transforms
js/editor3d.js      Three.js 3D editor
js/slice.js         layer editor
js/palette.js       display palette (localStorage)
js/voxelize.js      PNG → voxels
js/vox.js           MagicaVoxel .vox import
js/library.js       IndexedDB library + autosave + team levels
js/crates.js        crate economy UI
js/stats.js         balance stats + validation
js/ui.js            toasts, modals, download/clipboard fallbacks
js/main.js          wiring/boot
```

## License

MIT (see [LICENSE](LICENSE)). Three.js is MIT (see `vendor/THREE-LICENSE`).
