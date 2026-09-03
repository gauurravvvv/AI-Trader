# `reference/` — vendored upstream sources

Six read-only third-party repositories, vendored so this workspace is a single
self-contained tree. **Nothing here is imported, linked, or compiled into the
application.**

- **What each one contributed** and the file-by-file reading guide: [MANIFEST.md](MANIFEST.md)
- **Licences, pinned commits, and the AGPL handling rule:** [../NOTICE.md](../NOTICE.md)
- **Reproduce or update:** `../scripts/sync-reference.sh`

Each copy has its upstream `.git` stripped — provenance is the pinned SHA in the
manifest, not a submodule. If you add a seventh source, strip its `.git` too, or
git records a gitlink and a fresh clone gets an empty directory.

> `openalgo/` is **AGPL-3.0**. Read it; run it as a separate self-hosted HTTP
> service if ever needed. Never import, link, or copy from it.
