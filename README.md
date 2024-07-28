# koice.js

Node.js SDK to stream audio content to a KOOK voice channel.

## How to use

```typescript
import Koice from 'koice';
```

You must have `ffmpeg` in your PATH, or you can specify one

```typescript
const kasumi = new Kasumi({
    type: "websocket",
    token: "Your KOOK bot token",
})
const koice = await Koice.create(kasumi, "Id of the channel to stream to", {
    // all entries are optional

    // password to the channel if exists
    password: "12345678"
    // use the same port and socket for both RTP and RTCP
    // issues may occur if set to true
    rtcpMux: false,
    // apply factor to official defined bitrate for the voice channel
    // use smaller value to avoid being kicked for overrate
    bitrateFactor: 0.9,
    // force koice.js to stream realtime
    // required if not pushing audio contents at appropriate rate (eg. entire track at once)
    forceRealSpeed: false
});
```

```typescript
const fileHead: Buffer = ...;
const chunk: Buffer = ...;
// IMPORTANT: push file head separately first
// this will be used to determine your file format
// when reconnecting to the channel once network problems occured
koice.push(fileHead);

// starts pushing the rest of your audio file
koice.push(chunk);
```

```typescript
import * as fs from 'fs';

const kasumi = new Kasumi({
    type: "websocket",
    token: "Your KOOK bot token",
})
const koice = await Koice.create(kasumi, "Id of the channel to stream to", {
    password: "12345678"
    rtcpMux: false,
    bitrateFactor: 0.9,
    forceRealSpeed: false
});

const fileHead: Buffer = ...;
const chunk: Buffer = ...;

koice.push(fileHead);
koice.push(chunk);
```

You can refer to [kook-arisa](https://github.com/saltcute/kook-arisa) for usage of this package in real world application.

---

© 2022-2024 salt, [Koice.js](https://github.com/saltcute/Koice.js) and [kook-arisa](https://github.com/saltcute/kook-arisa), released under [the MIT license](https://github.com/saltcute/Koice.js/blob/main/LICENSE).