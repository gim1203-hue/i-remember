# I Remember

A day-by-day calendar app: click any day to set its mood color, add up to
100 photos, capture a quick front/back camera moment, record a video
(up to 12 hours), record a voice note (up to 12 hours), and jot what happened. Tap
"Play memory reel" to replay a day as a slideshow.

This is a static frontend with Supabase authentication, database, and private
storage. `index.html` contains the UI and client code; Supabase is the backend.
`admin.html` is the support desk for approved administrators.

## Run it locally

Just open `index.html` in a browser, or serve it so camera/mic permissions
behave normally:

```bash
npx serve .
# or
python3 -m http.server 8000
```

Then visit the printed local URL.

## Deploy to Vercel

1. Push this folder to a GitHub repo (see below).
2. Go to vercel.com, sign in with GitHub, click **Add New → Project**.
3. Select this repo. Framework preset: **Other** (static site) — no build
   command needed.
4. Click **Deploy**. You'll get a live URL like `i-remember.vercel.app`
   that works on any phone, tablet, or computer.
5. On a phone, open that URL and choose "Add to Home Screen" (iOS Safari)
   or accept the install prompt (Android Chrome) to make it launch like an
   app icon.

## Push to GitHub

```bash
cd i-remember-app
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<your-username>/i-remember-app.git
git push -u origin main
```

## Notes on data

- Mood, notes, photos, voice notes, videos, and camera moments are saved to the
  signed-in user's Supabase account and private storage.
- Photos are downscaled and compressed client-side before upload.
- The app's PIN/background-only lock keeps recording, its indicator, and live
  camera preview running. Switching tabs does not deliberately stop capture.
  The operating system can still suspend a browser or end camera/microphone
  access when the device itself locks; this web app cannot guarantee recording
  through a physical phone lock. Screen wake lock is requested when supported.
- Video and voice recordings use compressed, independently playable one-minute
  parts (also rotated near 5 MB). The camera/microphone stream stays open across
  parts. Playback groups them into one session with automatic next-part playback
  and a part selector; file transitions can have a brief playback pause.
- Finished parts are stored in IndexedDB before account upload. Offline parts
  retry every 30 seconds, on reconnection, and when the same account signs in.
  **Retry recording uploads** retries immediately. Do not clear site data while
  uploads are pending. A crash can lose the unfinished current minute.
- Video targets 640 × 360 at 15 fps, 500 kbps video and 32 kbps audio; voice
  targets 32 kbps. Twelve hours is approximately 2.9 GB of video or 173 MB of
  voice, plus container overhead. Actual size varies by browser. Small files
  keep memory and individual uploads manageable; they do not remove the total
  storage requirement. Keep the device powered and allow enough account/device
  storage. If local storage fails, recording stops and exposes download links
  for unsaved finished parts.
- Capture moment takes and saves a front photo followed by an exact rear-camera
  photo, when the device has one. Video recording is the separate **Start
  recording** control. Capture and recording cannot use the camera concurrently.
- Run `supabase-migration.sql` in the Supabase SQL editor to apply the app's
  supporting tables and set the media bucket's server-side limit to 50 MB.
- To enable the support desk, run the updated `supabase-migration.sql` in the
  Supabase SQL editor. Sign in to the app once with the Google account you want
  to use as an administrator, then run the commented `support_admins` insert at
  the bottom of that SQL file after replacing `YOUR_ADMIN_EMAIL` with that
  account's email. Only allowlisted accounts can use `admin.html` or list
  members. Users can open **Get help** in the app to message support; replies
  appear in the same private conversation. The admin page is available at
  `/admin.html` after deployment.

## Recording checks

```bash
npm test
npm run test:browser
```

The unit suite simulates the complete 12-hour video/voice timelines and tests
file rotation, final-part saving, durable upload recovery, and photo cleanup.
The browser suite uses headless Microsoft Edge with simulated camera/microphone
input and a local mock backend; it never writes to the production account.
It checks real JPEG/video/audio generation, playback, capture controls,
reopening saved media, offline recovery, and basic mood/note/photo/PIN controls.
Install Edge or change the Playwright browser channel for your machine.
These tests do not replace a physical-device endurance test or validation of
the live Supabase policies and available storage.

## Turning this into a native app

To get this into the Apple App Store or Google Play, the web version needs
to be wrapped as a native shell (e.g., with [Capacitor](https://capacitorjs.com))
so it can request real camera/mic/background permissions outside the
browser sandbox.

```bash
npm install
npx cap init "I Remember" "com.yourname.iremember" --web-dir .
npx cap add ios
npx cap add android
```

This repo already includes `capacitor.config.json` and `package.json` with
the Capacitor dependencies listed. After `cap add` generates the `ios/`
and `android/` project folders, copy the permission snippets from
`platform-config/` into each platform's config file:

- `platform-config/ios-Info-plist-additions.xml` → paste into
  `ios/App/App/Info.plist`
- `platform-config/android-manifest-additions.xml` → paste into
  `android/app/src/main/AndroidManifest.xml`
- `platform-config/PRIVACY.md` → a starting privacy policy draft; host it
  publicly and link it in both store listings (required, since this app
  requests camera and microphone access)

From there:

- **iOS**: Apple Developer Program ($99/yr), open with `npx cap open ios`,
  set your app icon, archive and upload via Xcode, test via TestFlight,
  submit for review.
- **Android**: Google Play Console ($25 one-time), open with
  `npx cap open android`, generate a signed app bundle, fill out the store
  listing, submit for review.

See the full step-by-step deployment guide artifact for the complete
walkthrough of both stores.
