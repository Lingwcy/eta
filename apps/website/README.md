# Eta website

Eta's static product website, built with Astro. English lives at `/` and
Simplified Chinese at `/zh/`. Both pages share the same components and
localized content in `src/content/site.ts`.

From the repository root:

```sh
vp install
vp run dev:website
```

The development server prints its local URL. To validate and build:

```sh
vp run @eta/website#typecheck
vp run build:website
vp run @eta/website#preview
```

Deploy `apps/website/dist/` to any static host. Once a production domain is
chosen, set `SITE_URL` to its absolute origin in the build environment to
generate canonical URLs, language alternates, and social image metadata.

Download buttons point to GitHub Releases so installer names and version
numbers do not become stale. The Bot link leads to its setup guide.
The product video and its poster live in `public/media/`. The silent demo was
captured from the real desktop app using a new, dedicated demo conversation and
workspace. It shows reading a brief, writing release notes, and drafting a launch
post. Existing conversations and project lists are excluded. The muted video
loops while visible, with no player controls. Click, tap, Enter, or Space toggles
playback. It pauses offscreen and in background tabs; reduced-motion preferences
disable automatic playback.

The visual system uses monochrome marble sculpture, condensed display type,
monospaced labels, and dotted rules. The decorative hero artwork is
`src/assets/hero-wing.png`, with its generation prompt alongside it.
Motion uses a staggered hero entrance,
one-time scroll reveals, and brief hover and FAQ transitions. Sparse particles
drift in a separate foreground layer using transform and opacity animations; they pause
offscreen and in background tabs, and mobile shows fewer particles. Motion honors
reduced-motion preferences and keeps content visible without JavaScript.
