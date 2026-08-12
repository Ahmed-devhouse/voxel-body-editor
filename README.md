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
> Run `python3 -m http.server` in the repo folder and open
> `http://localhost:8000`.

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
| Model ops | Flip X/Y/Z, rotate 90°, shift on any axis, hollow (remove enclosed interior), **centre** on the floor, **trim** the grid down to the model, resize with centering, undo/redo (200 steps) |
| Colours | The game's six (Y O R G B + X wildcard) with the real art hexes, each recolourable and relabellable; **add your own** past those six (see below); swap one colour for another or delete every voxel of a colour across the whole model |
| Import | Unity `.asset` (file or pasted YAML), MagicaVoxel `.vox` (colours mapped to the game palette, near-greys → X wildcard), PNG voxelizer approximating the Unity pipeline |
| Export | Unity `.asset` byte-identical format, robust download fallbacks, copy-as-YAML, PNG screenshot |
| Level design | Layer rules, unit rules, the real 5-column crate board (column-major, per-crate flags, per-column refills) with auto-fill, ammo stats that include the checkered shell the game adds, validation for the traps the format hides (Auto cells inheriting an Empty refill, invalid unit kinds, units on empty cells, out-of-range colours, unit-rule mismatches, disconnected islands) |
| Comfort | Keyboard shortcuts (press `?`), editable display palette, autosave, model library with thumbnails, shared team levels |

## Adding colours past the game's six

The palette's first six entries **are** the game's colours (`Cols` in
`VoxelCore.cs`): `0` Y, `1` O, `2` R, `3` G, `4` B, `5` X — the grey wildcard any
bullet clears. Crates only ever carry `0`–`4` (`Cols.CrateColourCount`).

You can add more colours in the editor (`+ col` in the rail, or **+ colour** on
the Model tab) and paint and export them. They are flagged red, and the Stats
tab reports them as an error, because the **shipped game cannot use them**:
`Palette.Of` renders anything ≥ 6 magenta, and since no crate can ever mint that
colour, such a voxel can never be shot — the level becomes unwinnable.

To make a seventh colour real, change three things in Unity and then one here:

1. `Assets/VoxelVolley/Runtime/Core/VoxelCore.cs` — add the constant to `Cols`,
   and raise `CrateColourCount` **only if** crates should carry it (that constant
   sizes colour arrays across the runtime, the sim and the crate grid UI, which
   is laid out in 5 columns — so raising it is a real design change, not a
   one-liner).
2. `Assets/VoxelVolley/Runtime/Palette.cs` — append the render colour to
   `Palette.Colours`.
3. Re-run the project's tests (`VoxelVolley.Tests.Editor`) and the body
   validator (`Voxel Volley → Validate Voxel Bodies`).
4. Here: raise `GAME_COLOURS` in [`js/palette.js`](js/palette.js). That single
   number is what the red flags and the Stats error are gated on.

Until then, treat the extras as a scratch palette — useful for blocking out a
model before committing it to real game colours.

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
