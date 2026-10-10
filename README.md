# scala-sdk

The engine of [Scala](https://github.com/vpavlin/scala), the local-first, end-to-end-encrypted shared
calendar on Logos/Loam, as a TypeScript library for React Native (Expo) apps. Any app that includes it
reads and writes the same calendars as the Scala app: same wire format, same encryption, same signed
event log, same sync over the device's shared Loam node.

It is the mobile half of Scala's SDK. The desktop half is the `scala` Basecamp core module. The contract
both follow (event types, fields, invariants) is Scala's [`docs/sdk.md`](https://github.com/vpavlin/scala/blob/main/docs/sdk.md).

## What's in it

| File | What |
|---|---|
| `calendar.ts` | The app-facing API: create/join/share calendars, create/update/delete events, RSVP, comments (`postExt`/`deleteExt`), start syncing, `onChange` |
| `store.ts` | Local storage of each calendar's event log + the folded state (AsyncStorage) |
| `engine.ts` | The pure fold: event log → calendar state. Byte-identical to Scala's C++ fold (parity-tested in the Scala repo) |
| `scala-sync.ts`, `catchup.ts`, `snapshot.ts`, `syncstatus.ts` | Sync over Loam: sealed messages, catch-up for devices that were offline, snapshots |
| `crypto.ts`, `crypto-derive.ts`, `identity.ts`, `identities.ts`, `loam-signer.ts`, `loam-keycard/` | Encryption and signing: per-calendar keys, device / Loam / Keycard identities |
| `invite-link.ts` | `scala://join` links and invite tickets |
| `recur.ts`, `clashes.ts`, `filters.ts` | Recurrence expansion, overlap warnings, field and date filters |
| `ics.ts`, `logos-storage.ts` | iCalendar import/export, attachments in Logos Storage |
| `loam-transport-pkg/` | [loam-transport](https://github.com/vpavlin/loam-transport) (submodule): the shared delivery node client |

App-specific code (notifications, home-screen widgets, UI) stays in each app.

## Using it

Add it as a submodule at `src/lib` (the Scala app does exactly this), with its own submodule:

```sh
git submodule add https://github.com/vpavlin/scala-sdk mobile/src/lib
git submodule update --init --recursive
```

Install the peer dependencies listed in `package.json` (Expo crypto and secure store, AsyncStorage, the
noble libraries, base64-js; the Keycard libraries only if you use Keycard identities), and register
loam-transport's Expo config plugin in `app.json`:

```json
"plugins": ["./src/lib/loam-transport-pkg/plugins/withDeliveryClient.js"]
```

Then, as in Scala's [SDK guide](https://github.com/vpavlin/scala/blob/main/docs/sdk.md#22-mobile-typescript--the-minimal-integration):

```ts
import { startSyncing, createEvent, onChange } from "./src/lib/calendar";
import { store } from "./src/lib/store";

await startSyncing(true, (status) => setSyncLabel(status));
const off = onChange(async () => render(await store.listEvents()));
```

Your app's own data rides in each calendar's custom fields and in `ext` items under your own namespace
(Scala ADRs 0005 and 0021); never add fields the fold doesn't know about to the wire format.

## Changing it

The fold in `engine.ts` must stay byte-identical to Scala's C++ fold. Change both together, in the Scala
repo's branch that bumps this submodule, and run its parity tests (`cd mobile && npm test`).

## Licence

Dual-licensed under [MIT](LICENSE-MIT) or [Apache 2.0](LICENSE-APACHE), at your option.
