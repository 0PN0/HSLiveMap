# Proposing a marker

You don't need write access to this repo to add a waypoint.

## The easy way (recommended)

1. Open the map site and click **"+ Propose marker"**.
2. Click the spot on the map where the waypoint belongs.
3. Fill in the title, category, an optional image URL, and a comment.
4. Click **"Generate GitHub link"** — this opens GitHub with a new file
   already filled in for you.
5. On GitHub, click **"Propose new file"**. If you don't have write access,
   GitHub automatically forks the repo for you first — just confirm.
6. That's it — you've opened a pull request. It'll show up on the map in
   the "Verified + Pending" view immediately, tagged with your PR.

## The manual way

If you'd rather do it by hand:

1. Fork this repo.
2. Add a new file at `data/markers/your-marker-name.json` (pick any unique
   filename — don't edit an existing marker file, since that can cause
   conflicts with other people's proposals).
3. Use this format:

   ```json
   {
     "title": "Hidden chest behind waterfall",
     "category": "chest",
     "x": 1450,
     "y": 860,
     "image": "https://i.imgur.com/yourimage.jpg",
     "comment": "Need levitation or a running start off the ledge."
   }
   ```

   `x`/`y` are pixel coordinates in the map's own coordinate space — the
   easiest way to get these right is still the in-app click flow above,
   since it fills them in for you.

4. Open a pull request against `main`.

## What happens next

The repo owner reviews your PR like any other — checking the coordinates
make sense and the image isn't broken — then merges it. Once merged, your
marker becomes "verified" and shows up for everyone, all the time.
