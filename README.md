# Recall Notes (Revara)

Android shell for the Recall Notes web app, rebuilt from the released APK (version 2.0.4).

- `app/src/main/assets/www/` — the web app (HTML, CSS, JS, fonts, pdf.js), unchanged.
- `MainActivity.kt` — WebView host and the `RecallNative` bridge: `postJson`, `saveFile`, `setReminder`, `requestNotifications`.
- `Reminders.kt` — daily study reminder (AlarmManager + notification), restored after reboot.

## Build

Push to GitHub: the **Build APK** workflow builds a debug APK and publishes it under Releases as `RecallNotes.apk`.
Or locally with JDK 17: `./gradlew assembleDebug`.

## Notes

- Builds are signed with `app/debug.keystore` (in this repo) so each build installs over the last one.
  This is not the key the original APK was signed with, so the original must be uninstalled first.
  **Export a backup from the app before uninstalling — uninstalling deletes its notes.**
- For a Play Store release, sign with your own release key instead.
