# Garden Log

A phone web app for mapping your garden. Walk round with your phone, stand by each plant and tap **Add plant here**: the app saves the plant's GPS position and your photos. Claude then identifies the plant from the photos and writes a care plan for it.

## What it does

- **Map**: satellite map of your garden with a pin (showing a photo) for every plant. **Start walk** records the route you walk.
- **Accurate positions**: while you add a plant it takes several GPS readings and averages the best ones. Phone GPS is usually good to 3–5 m in the open. If a pin lands in the wrong place, use **Drag pin** or **Re-record here** on the plant's page.
- **Identification**: name, scientific name, confidence and other possible matches. It also checks the plant's health from the photos.
- **Care plan**: light, watering, soil, feeding, pruning, pests, winter care, hardiness, toxicity to pets and children, plus a 12-month planner. Timings are based on your hemisphere and the notes you give about your garden.
- **Jobs**: every plant's tasks for the month in one checklist.
- **Private and works offline**: plants and photos are stored on the phone only. Use **Export backup** in Settings to save a copy. Plants added with no signal can be identified later.

## Getting it on your phone

The app is static files with no build step, but phones only allow GPS and camera on HTTPS pages. The simplest free host is GitHub Pages:

1. On GitHub, go to this repo's **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, pick the branch and `/ (root)`, and save.
3. After a minute, open `https://joeaspence.github.io/joeaspence/garden/` on your phone.
4. Add it to your home screen (Safari: Share → Add to Home Screen; Chrome: ⋮ → Add to Home screen) so it opens full screen like an app.
5. Open **Settings** in the app and paste a Claude API key from https://console.anthropic.com. Allow location and camera access when asked.

To run it locally: `cd garden && python3 -m http.server 8000`, then open http://localhost:8000. Browsers treat `localhost` as secure, so GPS works on a laptop too.

## Cost

Each identification is one Claude API call with up to 5 photos. With Claude Opus 5.5 that costs roughly $0.05–0.10 per plant. Sonnet 5.5 (pick it in Settings) costs about half that.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css` | Layout and styling |
| `app.js` | Map, GPS sampling, walk tracking, add-plant flow, plant pages, jobs, backup |
| `ai.js` | Claude call: photos in, structured JSON (ID + care plan) out |
| `db.js` | IndexedDB storage for plants, photos and settings |
| `sw.js`, `manifest.webmanifest` | Offline support and installing to the home screen |
| `vendor/` | Leaflet 1.9.4 and the Anthropic TypeScript SDK 0.131.0, bundled so the app needs no CDN |

Your API key is stored only on your phone and is sent only to Anthropic. Anyone with your phone could read it, so use a key with a low spending limit.
