# Agent Firehose site

The marketing page served at `https://treetopdevs.github.io/llm-firehose/`.
Plain HTML, CSS and one script: no build step, no dependencies, no third-party
requests.

- `index.html`: the page. The terminal block is a static snapshot, so the page
  is complete without JavaScript.
- `styles.css`: tokens at the top (`:root`), light by default, dark under
  `prefers-color-scheme: dark`.
- `demo.js`: copy buttons, the margin trace, the altitudes viewer and the
  terminal demo. Both terminals show invented fixture events only; never paste
  real captured data here. The viewer replaces the static three-step ladder in
  `index.html`, which stays as the no-script version, so keep the two in step.
- `fonts/`: Martian Grotesk and Martian Mono, self-hosted under the SIL Open
  Font License (licence texts alongside).

## Preview

The page is served from a subpath, so preview it from one. All links and
assets are relative.

```sh
mkdir -p /tmp/fh-site && ln -sfn "$PWD/site" /tmp/fh-site/llm-firehose
python3 -m http.server 4731 --bind 127.0.0.1 --directory /tmp/fh-site
# open http://127.0.0.1:4731/llm-firehose/
```

## Deploy

`.github/workflows/pages.yml` publishes this folder on pushes to `main` that
touch `site/**`. One-time setup: repository Settings, Pages, Source: GitHub
Actions.

## When a release ships

Update the release link and version in `index.html` (search for `v0.6.0`), and
the sources table if `firehose install` gains or loses a target.
