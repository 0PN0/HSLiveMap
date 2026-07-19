# Map Explorer

A self-hosted, forkable interactive map — like the Genshin Impact map, but for
whatever game you want. Built as a static site (works on GitHub Pages,
Cloudflare Pages, Netlify, or any static host), with no backend: pull
requests *are* the moderation queue.

- **Verified markers** — merged into `main`, visible to everyone.
- **Pending markers** — proposed in an open pull request, shown only in the
  "Verified + Pending" view, tagged with the PR that added them.
- Anyone can propose a marker; only people with write access can merge one.

## One-time setup

1. **Create the repo.** Push this folder to a new GitHub repo. It can be
   public or private — public is simpler if you want the "propose a marker"
   flow to work for people who don't already have collaborator access
   (private repos require them to already be collaborators, since GitHub
   won't silently fork a private repo for a stranger).

2. **Edit `js/config.js`** with your GitHub username, repo name, and default
   branch. This is the only file you must edit before it works.

3. **Host the site.** Any static host works — pick whichever's easiest for
   you:
   - **Cloudflare Pages** (recommended, free): Cloudflare dashboard → Workers & Pages →
     Create → Pages → connect to GitHub → pick this repo → build command
     blank, output directory `/` → Deploy. Auto-redeploys on every push.
     URL looks like `yourproject.pages.dev`.
   - **Netlify** (also free, works with private repos too): New site from
     Git → pick this repo → no build command → publish directory `/` →
     Deploy. URL looks like `yourproject.netlify.app`.
   - **GitHub Pages**, if you do have it available: Settings → Pages →
     Deploy from a branch → `main` → `/ (root)`.

   Whichever you pick, **the repo itself needs to stay public** — the site
   reads verified/pending markers straight from GitHub's public API in each
   visitor's own browser, and that only works unauthenticated on public
   repos. (Owner Mode, below, is the one exception — it lets *you*
   authenticate for writes, but reading the public marker list for every
   visitor still needs the repo to be public.)

4. **Protect `main`.** Repo → Settings → Branches → Add branch protection
   rule for `main` → check "Require a pull request before merging". This is
   what makes markers "pending until you approve them" instead of anyone
   being able to push directly.

5. **Add your map images.** Take your in-game screenshots, put them anywhere
   temporarily, then open `calibrate.html` **locally in your browser**
   (just double-click the file, no server needed) and:
   - Load all your screenshot images
   - Drag and resize them until edges line up
   - Click "Export tiles.json"
   - Move the downloaded file to `data/tiles.json`
   - Copy the actual image files into `images/tiles/` using the same
     filenames referenced in `tiles.json`
   - Commit and push

6. **Delete the example marker** at `data/markers/example.json` once you've
   placed a couple of real ones.

7. Share your site's URL with whoever you want.

## Owner mode (attaching real photos, publishing without a PR)

Click **"Owner mode"** in the top bar and paste a fine-grained GitHub
personal access token (create one at
github.com/settings/personal-access-tokens/new), scoped to just this repo
with **Contents: Read and write**. Once connected, in your own browser only:

- The "+ Propose marker" button becomes **"+ Publish marker"** — your
  markers commit straight to `main`, no pull request needed.
- The marker form gets a working **file picker**. Pick a screenshot, and
  it's resized client-side and uploaded directly into `images/markers/`
  alongside the marker file — no Imgur or external host required.

The token lives only in your browser's local storage and is used only for
requests to `api.github.com` from your device. Don't paste it on a shared
computer. Anyone without a token still goes through the propose-an-image-URL
→ pull request flow described in `CONTRIBUTING.md`.

## How contributors propose a marker

Covered in `CONTRIBUTING.md` — send that link to the people you share the
map with.

## Marking waypoints complete

Every marker popup has a "Mark completed" button. Completion is stored in
`localStorage`, per browser — it's personal progress tracking, not synced
between people or devices, and never touches GitHub.

The **Progress** button in the top bar opens a panel with:
- A completed-count summary
- A one-click **"Uncomplete all chests"** shortcut
- A free-text **"Uncomplete by tag"** field (matches against `category` or
  any entry in `tags`, case-insensitive) plus clickable chips for every
  tag currently in use
- An **"Uncomplete everything"** full reset

## Notes & limits

- Marker/PR data is read live via the public GitHub API, which is rate
  limited to 60 requests/hour per visitor IP. Fine for sharing with a small
  group; if you outgrow that, look into adding a GitHub Action that bakes a
  `manifest.json` on every merge so the site can skip the API entirely.
- Marker photos can be a plain image URL (Imgur, etc.) for contributors
  without repo access — or, if you've connected Owner Mode, an actual file
  upload straight into the repo.
- Everything renders with [Leaflet.js](https://leafletjs.com/) using a
  simple pixel coordinate system (`CRS.Simple`) — no real-world lat/lng
  involved.
