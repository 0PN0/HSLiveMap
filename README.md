# Map Explorer

A self-hosted, forkable interactive map — like the Genshin Impact map, but for
whatever game you want. Built as a static site (GitHub Pages), with no
backend: pull requests *are* the moderation queue.

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

3. **Turn on GitHub Pages.** Repo → Settings → Pages → Deploy from a branch →
   `main` → `/ (root)`. Your site will be live at
   `https://YOUR_USERNAME.github.io/YOUR_REPO/`.

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

7. Share the Pages URL (`https://YOUR_USERNAME.github.io/YOUR_REPO/`) with
   whoever you want.

## Adding markers yourself (as the owner)

Same flow as everyone else — click "+ Propose marker" on the site, or just
add a new file directly to `data/markers/` and push straight to `main` if
you don't want to go through a PR for your own additions.

## How contributors propose a marker

Covered in `CONTRIBUTING.md` — send that link to the people you share the
map with.

## Notes & limits

- Marker/PR data is read live via the public GitHub API, which is rate
  limited to 60 requests/hour per visitor IP. Fine for sharing with a small
  group; if you outgrow that, look into adding a GitHub Action that bakes a
  `manifest.json` on every merge so the site can skip the API entirely.
- Marker photos can be a plain image URL (Imgur, etc.) — contributors
  without repo access can use this instead of committing a binary file,
  since the "propose marker" link only pre-fills a single text file.
- Everything renders with [Leaflet.js](https://leafletjs.com/) using a
  simple pixel coordinate system (`CRS.Simple`) — no real-world lat/lng
  involved.
