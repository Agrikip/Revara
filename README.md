# Recall Notes (Revara)

A study app: put notes into units, and Recall Notes turns them into flashcards and quizzes, schedules reviews,
and lets you search your notes. It works offline. An AI service for written answers is optional and off by default.

Version 2.1.0. Android 7.0 and later.

## Getting the best out of it

1. **One unit per topic.** "Cell division", not "Biology". Small units make better quizzes.
2. **Write notes as `Term: meaning`**, one per line. Each line becomes a flashcard. You can also import text files and PDFs.
3. **Open Today every day and tap Start review.** Cards you find hard come back sooner. Grade honestly: Again, Hard, Good or Easy.
4. **Turn on the daily reminder** (Settings → Reminders) and set an exam date so Today counts down to it.
5. **Use Ask to search your notes.** It runs on the phone. For written answers, add your own AI service and key in
   Settings → Ask your notes. Answers are labelled as AI-generated and shown with the passages they came from, so check them.
6. **Back up before changing phones** (Settings → Data → Back up now). Backups are the only copy outside the phone.
7. Use the Focus timer on the Cards tab for timed study blocks.

## What changed in 2.1.0

| Area | Change |
| --- | --- |
| Bug | The tab row is now hidden on Settings (it was meant to be; a style rule overrode it). |
| Touch | Every tab, chip and small button is at least 44px tall. An automated check found 62 undersized controls across 8 screens before and 3 after (all hidden file inputs). |
| Contrast | "Delete", "Erase" and "×" text went from about 3.9:1 to above 4.5:1. |
| Motion | Press feedback on buttons, list rows arrive in sequence, the toast and sheets animate in and out, a right quiz answer pulses. All of it switches off with the phone's reduced-motion setting. |
| Numbers | Counts and timers use fixed-width digits so they do not jiggle. |
| Background | A light paper grain instead of a flat fill. |
| AI | A loading state while the AI writes, and every AI answer (including saved ones) is labelled. |
| Privacy | A Privacy page in Settings → Data. "Erase everything" now also removes the AI key. Android cloud backup of app data is off, so "everything stays on this phone" is true. |

### Checked and left as it was

- User text is escaped everywhere it is shown, and the page has a strict Content-Security-Policy.
- The AI key is entered by you, stays on the phone, is only sent to the https endpoint you set, and is left out of backups.
- No account, analytics, ads, subscriptions, reviews or uploads, so those checklist items do not apply.

## How it is built

- `app/src/main/assets/www/` — the app itself: `index.html`, `app.css`, `app.js`, fonts and pdf.js. No framework.
- `MainActivity.kt` — WebView host and the `RecallNative` bridge (`postJson`, `saveFile`, `setReminder`, `requestNotifications`).
- `Reminders.kt` — the daily reminder (AlarmManager and a notification), restored after a restart.

## Build

Push to GitHub: the **Build APK** workflow builds a debug APK and publishes it under Releases as `RecallNotes.apk`.
Locally, with JDK 17: `./gradlew assembleDebug`.

## Installing and signing

- Builds are signed with `app/debug.keystore` from this repo, so each build installs over the previous one.
- That is not the key the original 2.0.4 APK was signed with. To move from the original, **save a backup in the old
  app first**, uninstall it, install this one, then restore the backup. Uninstalling deletes the notes.
- This repo is public, so the debug key is public too. For a Play Store release, sign with a private release key.

## Known limits

- With Android backup off, notes do not move to a new phone by themselves. Use Back up now and Restore.
- Reminders use an inexact daily alarm, so they can arrive some minutes late.
- The changes were tested in a desktop browser at phone size and the APK builds on GitHub. It has not been run on a phone here.
