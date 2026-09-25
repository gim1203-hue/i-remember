# I Remember

A day-by-day calendar app: click any day to set its mood color, add up to
100 photos, capture a quick front/back camera moment, record a video
(up to 5 minutes / 45 MB), record a voice note (up to 30 minutes / 45 MB), and jot what happened. Tap
"Play memory reel" to replay a day as a slideshow.

This is a static frontend with Supabase authentication, database, and private
storage. `index.html` contains the UI and client code; Supabase is the backend.

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
- A recording must remain in the open browser tab until it finishes uploading.
  On mobile, locking the screen or switching apps can stop capture early.
- Run `supabase-migration.sql` in the Supabase SQL editor to apply the app's
  supporting tables and set the media bucket's server-side limit to 50 MB.

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
