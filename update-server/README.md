# Update server

A small Rust (axum) server for **Unity Project Sync**. It runs at <https://ups.umami-creative.app/> and does three things:

- It answers the app's **update check** (Tauri updater, "dynamic server" protocol).
- It shows a **download page** with the latest release, release notes, install steps, the SHA-256 checksum and older versions.
- It **serves the setup files**.

Releases are plain folders that you build on your PC and upload into the container's mounted storage. There is no database, no upload API, no CI and no cache: the folder is read again on every request.

The page is self-contained. The Geist font (SIL OFL 1.1, licence text at `/assets/Geist-OFL.txt`), the icon, CSS and JS are compiled into the binary, so nothing is loaded from third-party hosts. There are no cookies, no analytics and no IP logging.

The header has GitHub-style **Star** and **Fork** buttons for the repository, with counts. The server itself fetches the counts from the GitHub API (`api.github.com/repos/<owner>/<name>`, unauthenticated, every 30 minutes, every 5 minutes after a failure) and keeps them in memory. Visitors' browsers never contact GitHub. Until the first fetch succeeds, the buttons are shown without counts. On narrow screens only Star is shown; the footer always links the source code.

## Release folder format

`scripts/release.ps1` (in the repo root) builds and signs the app and writes `release/<version>/`. That folder holds exactly two files:

```
release/0.2.0/
  Unity-Project-Sync_0.2.0_x64-setup.exe
  release.json
```

`release.json` is UTF-8 without a BOM (the server also accepts one):

```json
{
  "version": "0.2.0",
  "pub_date": "2026-11-23T14:05:00Z",
  "notes": "Markdown text (may be empty)",
  "file": "Unity-Project-Sync_0.2.0_x64-setup.exe",
  "size": 4567890,
  "sha256": "<lowercase hex>",
  "signature": "<content of the .exe.sig file written by tauri build>"
}
```

A release is **valid** only if all of the following hold:

- The folder name does not start with `.` or `_`.
- `release.json` parses.
- `version` is valid semver and equals the folder name exactly.
- `file` is a plain file name: no `/`, `\` or `..`, and it does not start with `.`.
- The file exists and its size in bytes equals `size`. Otherwise the upload is treated as incomplete.
- The server can open the file. A file it cannot read (for example mode `600` owned by another user) would otherwise be offered with a URL that returns 404.
- `signature` is not empty.

Invalid releases are skipped and logged once as a warning; they never crash the server.

Two fields are optional:

- `pub_date` must be RFC 3339. The Tauri updater rejects the whole response for a bad date, so a date that is not RFC 3339 is left out and logged.
- `sha256` must be 64 hex digits to be shown.

The **latest** release is the valid one with the highest semver. A pre-release sorts below its own release: `1.0.0-beta.2` < `1.0.0`. But a pre-release of a *newer* version is the latest: with `1.0.0` and `1.1.0-beta.1` uploaded, every installed app is offered `1.1.0-beta.1` and the landing page downloads it (see "Publishing a release" for staging privately). Build metadata counts too (`0.2.0+hotfix` > `0.2.0`, the same order the app uses), so avoid it in versions.

> `version` must be the version the exe was built with (from `src-tauri/tauri.conf.json`). The signature carries that version, and the app rejects an update whose announced version differs from the signed one.

## Routes

| Route | Response |
| --- | --- |
| `GET /` | Landing page. Shows a "No release yet" state while there is no valid release. |
| `GET /api/update/{target}/{arch}/{current_version}` | `400` JSON if `current_version` is not semver. Otherwise `204` unless `target` = `windows`, `arch` = `x86_64` and the latest release is newer than `current_version`. Then `200` with `{version, notes, pub_date, url, signature}`; `url` is absolute and percent-encoded. |
| `GET /api/releases/latest` | `{version, pub_date, notes, file, size, sha256, url}`, or `404` with `{"error": …}`. |
| `GET /download` | `302` to the latest release file, or a `404` HTML page. |
| `GET /releases/{version}/{file}` | Streams the file (supports HEAD and Range). See the rules below. |
| `GET /healthz` | `200 ok` |
| `GET /assets/…`, `/favicon.ico` | Embedded icon, font, CSS and JS. |
| anything else | `404` HTML page. |

Rules for `GET /releases/{version}/{file}`:

- It serves the file only when `{version}` is a valid release and `{file}` is exactly that release's `file`.
- It sends `Content-Type: application/octet-stream`. Coolify's Traefik gzip middleware skips that type; with any other type it would compress the download on the fly and break `Content-Length` and Range.
- It sends `Content-Disposition: attachment` and `Cache-Control: public, max-age=31536000, immutable`.
- Every other path returns `404`, including `release.json`, other files, traversal attempts and directory listings.

The landing page and the API send `Cache-Control: no-cache`. HTML pages carry a strict CSP (`default-src 'none'`, self-hosted styles, scripts, fonts and images only).

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port. The server binds `0.0.0.0`. |
| `RELEASES_DIR` | `/data/releases` | Folder with the release folders. The server only reads it. |
| `PUBLIC_URL` | unset | Absolute base URL, e.g. `https://ups.umami-creative.app`. Used for the update and download URLs. When unset, the scheme comes from `X-Forwarded-Proto` (default `http`) and the host from `X-Forwarded-Host`, else `Host`. |
| `IMPRINT_URL` | unset | Footer link "Imprint" (Impressum). Shown only when set. |
| `PRIVACY_URL` | unset | Footer link "Privacy" (Datenschutz). Shown only when set. |
| `GITHUB_REPO` | `Umami-Creative-GmbH/unity-project-sync` | `owner/name` for the Star/Fork buttons and the footer's "Source code" link. `off` hides them and stops the API calls. |

URLs must be absolute `http(s)` URLs; anything else is ignored with a warning.

## Develop and run locally

```powershell
cd update-server
cargo test
cargo clippy --all-targets -- -D warnings

# serve the release folders that scripts/release.ps1 wrote
$env:RELEASES_DIR = "..\release"; $env:PORT = "8080"; cargo run
# http://localhost:8080/  and  http://localhost:8080/api/update/windows/x86_64/0.1.0
```

Docker (from the repo root):

```powershell
docker build -t ups-update-server ./update-server
docker run --rm -p 8080:8080 -v "${PWD}\release:/data/releases:ro" -e PUBLIC_URL=http://localhost:8080 ups-update-server
```

About the image:

- It is a static musl binary on `alpine:3.24`, about 16 MB.
- It runs as the non-root user `10001:10001`.
- It stops gracefully on SIGTERM.
- It has a Dockerfile `HEALTHCHECK` that calls `/healthz` with busybox `wget`.

## Coolify setup (one time)

The repository is public, but use a GitHub App source (or a deploy key plus a webhook) anyway, so that pushes trigger deploys.

1. **Source.**
   - **GitHub App (recommended):** *Sources → + Add → GitHub App → Automated installation*. Set Organization to `Umami-Creative-GmbH`, and set the webhook endpoint to the public Coolify URL. Install it on **only this repository**. Then *+ New → Private Repository (with GitHub App)*.
   - **Deploy key:** *Keys & Tokens → Private Keys → Generate* (ED25519). Add the public key under the GitHub repo's *Settings → Deploy keys*, read-only. Then *+ New → Private Repository (with Deploy Key)* with `git@github.com:Umami-Creative-GmbH/unity-project-sync.git`. On the app's *Webhooks* page, set a GitHub webhook secret (16+ characters) and copy the "Manual Git webhooks" GitHub URL. On GitHub, go to *Settings → Webhooks → Add webhook*: payload URL = that URL, content type `application/json`, the same secret, "Just the push event".
2. **Build.** Build pack **Dockerfile**, **Base Directory `/update-server`**, **Dockerfile Location `/Dockerfile`**. The Dockerfile location is relative to the base directory, so do **not** enter `/update-server/Dockerfile`: Coolify would look for `update-server/update-server/Dockerfile` and fail with `lstat …/update-server/update-server: no such file or directory`. Leave "Docker Build Stage Target" empty.
3. **Watch Paths** (*General → Build*): `update-server/**` (one pattern per line). Only pushes that change the server rebuild the container; app-only commits are ignored.
4. **Network.** *Ports Exposes* `8080`. Do **not** set Port Mappings: they bypass the proxy and disable rolling updates.
5. **Domain.** Add `https://ups.umami-creative.app` (port and path empty) and enable **Redirect HTTP to HTTPS**. The DNS A/AAAA record must point at the server, and ports 80/443 must be open. Coolify's proxy gets the Let's Encrypt certificate.
6. **Persistent storage.** *Configuration → Persistent Storage → Add → Directory Mount*: Source Directory **`/srv/ups/releases`** → Destination Directory **`/data/releases`**.
   - Prepare the folder on the host first: `mkdir -p /srv/ups/releases && chmod 755 /srv/ups/releases`, owned by the user you upload with.
   - The container runs as uid **10001** and only **reads**. Folders need `o+rx` and files need `o+r`. SFTP/scp uploads with the default umask 022 (755/644) already meet that; no `chown` is needed.
   - Do not use a Docker *Volume Mount*. Its files live under `/var/lib/docker/volumes/…`, which is awkward to upload to and can be wiped by "Delete Unused Volumes".
   - Deleting the Directory Mount in the Coolify UI can delete the host folder.
7. **Environment variables.** Set these, each with Build time = *Not available during build* (runtime only):
   - `PUBLIC_URL=https://ups.umami-creative.app`
   - `IMPRINT_URL=…` (the company's Impressum page)
   - `PRIVACY_URL=…` (the privacy policy page)

   `PORT` and `RELEASES_DIR` can stay unset. Coolify sets `PORT` to the first exposed port, which is `8080`. Changing runtime variables only needs a **Restart**.
8. **Health check.** Leave the dashboard *Healthcheck* **disabled**, so Coolify uses the Dockerfile `HEALTHCHECK` (`/healthz`). If you enable it anyway, use Host `127.0.0.1`, Port `8080`, Path `/healthz`.
9. **Gzip.** Nothing to do. The exe is served as `application/octet-stream`, which Coolify's gzip middleware skips. (Setting *Advanced → Gzip compression* to off is also fine.)
10. **Deploy.** *Advanced → Deployment → Auto deploy* stays on ("Deploy on push"). From then on, every push to `main` that touches `update-server/` redeploys.

## Publishing a release

1. Write the release notes (Markdown) into a file, e.g. `notes.md`.
2. In the repo root, run `scripts\release.ps1 -Version 0.2.0 -NotesFile notes.md`. It bumps the version in `src-tauri/tauri.conf.json`, `package.json` and `src-tauri/Cargo.toml`, builds, signs and writes `release/<version>/`. Without `-NotesFile`/`-Notes` the release has empty notes. See "Releases & updates" in the [root README](../README.md#releases--updates) for all options.
3. Upload the **whole folder** `release/<version>` into `/srv/ups/releases/` on the Coolify host:
   - **WinSCP** (SFTP): drag `release\0.2.0` into `/srv/ups/releases/`.
   - **scp** (Windows OpenSSH): `scp -r release\0.2.0 root@<coolify-host>:/srv/ups/releases/`
4. Done. No redeploy or restart is needed. Check <https://ups.umami-creative.app/api/releases/latest>.

Notes:

- **Partial uploads are harmless.** While the exe is missing or smaller than `size`, the release is ignored, so the app never sees a half-uploaded file. That covers WinSCP's `*.filepart` temp files too. To be extra safe, upload as `.0.2.0` (dot folders are ignored) and rename it to `0.2.0` when the upload is done.
- **Pre-releases go to everyone.** Any valid folder with a higher version than the latest stable, `1.1.0-beta.1` included, is offered to every installed app and becomes the landing-page download. To keep a pre-release private, stage it as `_1.1.0-beta.1` or `.1.1.0-beta.1` (ignored), or don't upload it.
- **Unpublish:** delete (or rename to `_0.2.0`) the folder. The next request falls back to the previous version.
- **Fix release notes:** edit `notes` in `/srv/ups/releases/<version>/release.json` in place. Keep it valid JSON. The change is live immediately.
- **Never replace the exe of a published version.** Its URL is cached as immutable. Publish a new version instead.
