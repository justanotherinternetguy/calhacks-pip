# Privacy summary (plain language)

**What the app does.** On a night out, the app watches your phone's motion, where you are relative to
home, and (if you allow it) sound *categories* around you. It uses these to notice when you might not
be able to ask for help. It first asks *you*. Only if you do not answer does it tell the friends you chose.

## What stays on your phone

- Your home and other saved places. Never uploaded.
- Your walking and typing baselines. Stored encrypted. Never uploaded.
- Microphone audio. The microphone is off unless something already happened (a fall, a dropped
  phone, a grab, a missed check-in, unsteady walking at night). Then it listens for about 10 minutes.
  The app analyzes the audio in memory for scream / shout / snoring labels and a loudness level, then
  discards it. No recordings, ever.
- Your private keys.

## What leaves your phone, and who can read it

| Data | Who can read it |
|---|---|
| Your location (every 1 to 5 min during night mode) | **Nobody**, until an incident. Your phone encrypts it with a key that only your phone has. Your friends get the key only in these cases:<br>• You do not respond to a check-in.<br>• You tap "I need help" / SOS.<br>• A friend asks for it while an alert about you is already in progress. Your phone shares it at once and tells you who asked.<br>• Your phone goes offline and at least 2 friends agree to unlock.<br>The company never has the key. |
| Whether night mode is on, your battery level, whether an alert is in progress | Your group's friends and the server (every 2 min, no location) |
| Whether you are near or apart from your friends | Your group. The server sees only a yes/no. It never sees coordinates. |
| That a check-in / heads-up / unlock happened, with a short reason ("a hard fall, then down for 2 min") | Your group and the server |
| Every time anyone unlocks your location | **You** see it, and so does the whole group. |

The server deletes encrypted locations after 6 hours. Keys are destroyed at the end of each day.

## Your controls

- Night mode: auto, on, off, or paused for tonight.
- Turn off the microphone, learning, or any sensor. The app keeps working with less signal.
- Leave a group instantly and silently. Your keys rotate at once.
- Delete your account: this removes all server rows for you.

## Who can add you to a group

Only someone you meet in person and scan a QR code with. Both sides must accept.

## Not an emergency service

This app is **not** an emergency or medical service. It does not contact police, ambulance, or campus
safety on its own. It may fail to detect an incident, or it may raise false alarms. Friends decide what
to do. The app only makes it easy to call for help. If you are in danger, call your local emergency
number.

## Terms outline (v1)

1. **18+ only.** Users confirm they are 18 or older.
2. **No guarantee.** Detection is probabilistic. We do not promise to detect any event or deliver
   any alert. Carriers, OS background limits, and battery affect delivery.
3. **Not an emergency service**, see above. Friends, not the app, decide to escalate.
4. **Consent.** Joining a group is mutual. The group owner may remove members. Anyone may leave at
   any time.
5. **Data.** As described above. We do not sell data. We may use aggregate, anonymized detection
   statistics to improve the model.
6. **Misuse.** You must not use the app to track someone without their knowledge or against their
   wishes. This use is prohibited, and the person being tracked can see it.
7. **Research builds** (`tools/collect`) require a separate signed consent.
