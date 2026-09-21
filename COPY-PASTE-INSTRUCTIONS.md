# I Remember updated copy

This folder is a new copy. The supplied original files were not overwritten.

## Install

1. In Supabase, open **SQL Editor**, paste all of `supabase-migration.sql`, and run it once.
2. Copy the files in this folder into a new VS Code project folder, or copy only `index.html` into a duplicate of the original project.
3. Keep the original Supabase `entries`, `media`, `profiles`, and `media` storage bucket. The migration only adds new tables and a private `documents` bucket.
4. Run `npm install`, then `npm start`.

## Important limits

- Ordinary web pages cannot guarantee alarms or audio/video recording after the browser is closed, suspended, or the phone is locked. The app keeps recording during its own calendar/panel navigation and uses a wake lock when supported, but the OS remains in control.
- Worldwide station availability depends on the community Radio Browser directory and each station's stream. HTTPS/browser audio rules can still reject individual streams.
- The language selector includes a localization foundation and several translated core labels. Full translation of all saved and live content needs a translation service/API.
- The horoscope is a deterministic daily reflection generated locally, not a claim of live astronomical forecasting.
- Search is live-as-you-type across saved dates, mood, legacy notes, separate notes, and folder names. It is private client-side matching, not a paid generative-AI service.

## Safety

- The original Notes field is preserved.
- Existing prayer times and weather remain.
- Prayer and custom event reminders trigger 10 minutes before the scheduled time while the app is active.
- Moon mode hides the interface with CSS only. It does not reload the page or intentionally stop recordings or radio.
