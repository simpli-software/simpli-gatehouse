# Simpli Gatehouse config builder

A single static page that builds the workflow and config files for **Simpli Gatehouse**, the two
open-source GitHub Actions from Simpli Software:

- [simpli-review](https://github.com/simpli-software/simpli-review): AI pull-request review, plus an optional scheduled AI security scan.
- [simpli-guard](https://github.com/simpli-software/simpli-guard): security scanning of every pull request and, nightly, of the repository and live sites.

Pick the settings on the Review or Guard tab. The page shows the files with their exact paths
(`.github/workflows/...`, `.simpli-review/config.json`, `.simpli-guard/config.json`) and gives each a
Copy and a Download button. The config JSON holds only the settings that differ from the tools'
defaults; with everything at its default the file is `{}` and optional.

Published with GitHub Pages at <https://simpli-software.github.io/simpli-gatehouse/>.

## Privacy

The page runs in your browser. It does not store what you type (no cookies, no `localStorage`), has no
analytics and loads no external scripts, fonts or images. Its only network calls go to
`api.github.com`, to find the latest release of each action and resolve its tag to a commit hash. The
`<meta>` Content-Security-Policy in `index.html` enforces this (`connect-src https://api.github.com`).

## Pinning

On load the page reads `releases/latest` of each repository and resolves the tag to its commit
(annotated tags are dereferenced), then writes `uses: simpli-software/<repo>@<full-sha> # <tag>`.
If the lookup fails (offline, rate-limited, nothing released), the files keep the
`<commit-sha> # v1.x` placeholder from the examples and the page says so.

## Run it locally

The page uses ES modules, which browsers do not load from `file://`. Serve the folder:

```bash
python -m http.server 8000
# open http://localhost:8000/
```

No build step and no dependencies.

## Tests

```bash
node --test          # same as: npm test
```

Needs Node 20 or newer, nothing to install. (From Node 23 on, `node --test tests/` with a directory
argument no longer works; use `node --test` or `node --test tests/*.test.mjs`.)

`tests/generate.test.mjs` checks that:

- every generated workflow equals the matching example from the action repositories **byte for byte**,
  apart from the pinned `uses:` ref and the heading and label names the user changes;
- the default settings produce an empty config, and a changed setting produces only that field;
- the validators reject non-https URLs, non-ISO or impossible `expires` dates, empty reasons, duplicate
  rule ids and empty scope globs;
- tag resolution handles lightweight and annotated tags and fails closed.

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | The page: markup, light and dark styles, DOM glue |
| `generate.js` | Pure generators and validators (no DOM); imported by `app.js` and the tests |
| `templates.js` | The example workflows as strings. Generated, do not edit by hand |
| `tests/fixtures/*.yml` | Copies of the example workflows from the action repositories |
| `scripts/build-templates.mjs` | Rebuilds `templates.js` from the fixtures |

## When an example workflow changes

Copy the new example over the matching file in `tests/fixtures/` (keep LF line endings), run
`node scripts/build-templates.mjs`, then `node --test`. If the change moves a line the generator edits
(the heading, label or `types:` line), the test fails with the name of the missing line.

## License

MIT, see [LICENSE](LICENSE). Built by Simpli Software.
