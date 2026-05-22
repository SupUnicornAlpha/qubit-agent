# python_connectors/wheels/

Pre-downloaded wheel cache for offline / poor-network bootstrap.

When `bun src/cli.ts bootstrap` (or `POST /system/bootstrap`) creates the
`python-venv`, it checks this directory:

- If any `*.whl` exists here, the installer runs
  `pip install --no-index --find-links wheels/ -r requirements.txt`,
  which never touches PyPI. Cold installs go from ~60s to a few seconds.
- If the directory is empty (default), the installer falls back to the
  usual network `pip install -r requirements.txt`.

## How to populate

Run on the same platform you intend to ship for:

```bash
# Local platform (recommended for dev / single-platform install bundles)
scripts/build-python-wheels.sh

# Cross-platform (publish multiple wheel sets and ship the union)
scripts/build-python-wheels.sh macosx_11_0_arm64
scripts/build-python-wheels.sh macosx_11_0_x86_64
scripts/build-python-wheels.sh manylinux2014_x86_64
scripts/build-python-wheels.sh win_amd64
```

Wheels themselves are git-ignored; only this README is tracked.
