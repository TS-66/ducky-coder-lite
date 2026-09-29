# The reference, as read from the screenshots

The three Cursor screenshots this UI was rebuilt from are not in the repository.
They lived on a removable ChromeOS mount that has since been disconnected, which
is a mistake worth recording plainly: a design reference that the build depends
on belongs next to the build, not on a volume that can go away.

This file is what survives of them. Everything here was read directly off the
images -- dimensions from their structure, colours sampled from regions -- and it
is the source `scripts/conformance.mjs` checks against. If the screenshots come
back, re-verify these numbers against them and correct any that drifted.

**Paths they were read from:** `/mnt/chromeos/MyFiles/Downloads/ui/`
(`ui.1.jpeg` 559x311, `ui.2.jpeg` 601x332, `ui.3.jpeg` 700x438).

---

## What could not be recovered

The JPEGs are compressed at a quality that lifts every near-black to `#191919`.
Every surface in all three images reads as the same value, so **the reference
cannot tell you what its editor background is**, only that it is near-black.

Surface colours therefore come from the written specification, not the images:

| Surface | Value | Source |
|---|---|---|
| Editor | `#0B0B0C` | spec |
| Sidebar, tabs, AI panel | `#121214` | spec |
| Activity dock | `#09090A` | spec |
| Terminal | `#050506` | spec |
| Inputs, capsules | `#18181C` | spec |
| Border / strong / input | `#1F1F23` / `#26262B` / `#2C2C32` | spec |
| Accent | `#38BDF8` | spec |
| Strong / muted text | `#F4F4F6` / `#8E8E93` | spec |
| Gutter, ghost text | `#3A3A3C` / `#5A5A62` | spec |
| Brand purple | `#5D53E7` | **sampled from ui.3** -- the status bar's account block |

The two diff colours *were* recoverable, because they are saturated enough to
survive the compression. They dominated 81% and 84% of their blocks:

| Block | Sampled |
|---|---|
| Removed | `#511C22` |
| Added | `#1F431F` |

Both are desaturated on purpose. A diff hunk covers a dozen lines of screen, and
a fully saturated red or green at that size stops reading as "changed" and starts
reading as an error.

## Geometry

Scale is unrecoverable -- the images are downscaled by an unknown factor -- so
the column widths come from the specification, which is authoritative for them.

```
title bar      44px
activity dock  48px   (icon slots are 48px too, not 44)
sidebar       240px   (resizable)
AI panel      380px   (resizable)
tab strip     35px
status bar    22px
```

---

## ui.3 -- the full window

The most useful of the three: one complete Cursor window with the terminal open.

**Title bar.** Thin, full width. Left: a row of small layout icons, then `←` `→`.
Centre: a **bordered, rounded, centred pill** containing a magnifier and the
project name -- the command centre, not a breadcrumb. Right: three icons, then a
gear.

**Below the tabs.** A separate breadcrumb row: `crypto-converter > src > App.js >
App`, with `>` chevrons, the trailing segment carrying an icon.

**Tab strip.** `App.js` with a dirty dot and a file icon. Active tab shares the
editor's background. A split-editor icon and `···` on the right.

**Editor.** Dim gutter, syntax highlighting, a red block for the replaced region
and a green block for the added one, and a `⏎ ⌘⏎` badge on the right edge where
the two meet.

**Floating over the code.** The `Cmd+K` island: a bordered multi-line box with
the instruction, a row of actions carrying keycaps, a
*Don't ask again for such edits* link, and a close `✕`.

**Sidebar.** Root in uppercase and muted, folders nested, file sizes right-aligned
in a dimmed column, the selected row on a lighter background. Pinned to the foot:

```
› OUTLINE
› TIMELINE
```

Collapsed, uppercase, dimmed.

**Terminal drawer.** Tabs `PROBLEMS | OUTPUT | DEBUG CONSOLE | TERMINAL | PORTS`,
with the active one underlined. Right: the session name, then `+ ⌄`, split, trash,
`···`, `^`, `✕`. Body is darker than the editor.

**Status bar.** Opens with a small filled **purple** block -- the account tier --
then the branch, then error and warning counts. Right: `Ln 33, Col 1`,
`Spaces: 2`, `UTF-8`, `LF`, `{}`, `JavaScript`, `Cursor Tab`.

## ui.2 -- the review state

A full window in diff-review mode, with the AI panel open.

**AI panel header.** `CHAT | COMPOSER` in **uppercase**. Below it an `Auto mode`
row with a switch. Body: the user's question, then the answer with inline code.
At the foot a `Files changed 1` section naming the file with `+43 -1`, and
`Accept | Accept all | Discard`.

**Diff header row.** Pill buttons: `Run`, `Accept and stage`, `Pin ⌘P`,
`Optimize…`. The file header carries the path and `4 +` / `1 -` counters.

**A notice banner** above the actions, with a `Dismiss` link and a close `✕`.

## ui.1 -- the model menu

The whole image is one popup, which is why it is the most precise reference for
that component.

Structure, top to bottom, with hairline rules between the three groups:

1. A keybinding hint, dimmed.
2. `Auto-select` and `Thinking`, each with a switch on the right.
3. The model list, with a tick on the one in use. A qualifier -- `MAX` -- set
   smaller and dimmer beside the name.

Below the popup, in the composer: the agent control, then the selected model in a
pill with a chevron.

---

## What this build does *not* reproduce

Named here so the gaps are visible rather than mistaken for oversights:

- **Model names.** The reference lists six named models. This build offers only
  what the provider configuration actually names, because offering a model the
  user cannot select is worse than a short list.
- **Auto mode.** The reference's `Auto mode` is a routing policy. The `Auto-select`
  switch here means "let the model menu choose", which is a different thing and is
  labelled accordingly.
- **The notice banner and the `Accept and stage` pill row.** These belong to a
  code-review workflow this build does not have; a diff is opened and reviewed
  directly.
