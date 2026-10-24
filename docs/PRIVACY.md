# Privacy summary (plain language)

**What the app does.** On a night out it watches your phone's motion, where you are relative to
home, and (if you allow it) sound *categories* around you, to notice when you might not be able to
ask for help. It first asks *you*. Only if you don't answer does it tell the friends you chose.

## What stays on your phone

- Your home and other saved places. Never uploaded.
- Your walking and typing baselines. Stored encrypted; never uploaded.
- Microphone audio. The microphone is off unless something already happened (a fall, a dropped
  phone, a grab, a missed check-in, unsteady walking at night); then it listens for about 10 minutes.
  Audio is analyzed in memory for scream / shout / snoring labels and a loudness level, then discarded.
  No recordings, ever.
- Your private keys.

## What leaves your phone, and who can read it

| Data | Who can read it |
|---|---|
| Your location (every 1–5 min during night mode) | **Nobody**, until an incident. It is encrypted with a key only your phone has. Your friends get the key only if you don't respond to a check-in, you tap "I need help" / SOS, a friend asks for it while an alert about you is already in progress (your phone shares it at once and tells you who asked), or your phone goes offline and at least 2 friends agree to unlock. The company never has the key. |
| Whether night mode is on, your battery level, whether an alert is in progress | Your group's friends and the server (every 2 min, no location) |
| Whether you are near or apart from your friends | Your group. The server sees only a yes/no; it never sees coordinates. |
| That a check-in / heads-up / unlock happened, with a short reason ("a hard fall, then down for 2 min") | Your group and the server |
| Every time anyone unlocks your location | **You** see it, and so does the whole group. |

Encrypted locations are deleted from the server after 6 hours. Keys are destroyed at the end of
each day.

## Your controls

- Night mode: auto, on, off, or paused for tonight.
- Turn off microphone, learning, or any sensor; the app keeps working with less signal.
- Leave a group instantly and silently; your keys rotate at once.
- Delete your account: all server rows for you are removed.

## Who can add you to a group

Only someone you meet in person and scan a QR code with. Both sides must accept.

## Not an emergency service

This app is **not** an emergency or medical service, does not contact police, ambulance or campus
safety on its own, and may fail to detect an incident or may raise false alarms. Friends decide what
to do; the app only makes it easy to call for help. If you are in danger, call your local emergency
number.

## Terms outline (v1)

1. **18+ only.** Users confirm they are 18 or older.
2. **No guarantee.** Detection is probabilistic. We do not promise to detect any event or deliver
   any alert; carriers, OS background limits and battery affect delivery.
3. **Not an emergency service**, see above. Friends, not the app, decide to escalate.
4. **Consent.** Joining a group is mutual. Members may be removed by the group owner; anyone may
   leave at any time.
5. **Data.** As described above. We do not sell data. Aggregate, anonymized detection statistics
   may be used to improve the model.
6. **Misuse.** Using the app to track someone without their knowledge or against their wishes is
   prohibited and is visible to the person being tracked.
7. **Research builds** (`tools/collect`) require a separate signed consent.
