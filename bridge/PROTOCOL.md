# Nox bridge protocol (host ⇄ extension)

Transport: Chrome native messaging — 4-byte little-endian length + UTF-8 JSON.
Host→extension messages are capped at **1 MiB**; extension→host at 64 MiB.
Everything larger leaving the host rides chunk framing (below).

## Envelopes

### Health
```jsonc
// ext → host
{"t":"ping"}
// host → ext
{"t":"pong","node":"v24…","platform":"win32","pid":1234,
 "codex":{"found":true,"version":"0.149.0","path":"…"},
 "spawn":{"state":"running","restarts":0,"uptimeMs":42000},
 "stderrTail":"…last 4 KiB…","maxMessageBytes":1048576}
```

### Requests from the extension to Codex
```jsonc
{"t":"rpc","cid":"c12","method":"turn/start","params":{…}}
// reply:
{"t":"resp","cid":"c12","result":{…}}          // or "error":{code,message}
{"t":"notify","method":"initialized","params":{}}
```
`cid` is opaque to the bridge; it correlates replies. The bridge assigns its own
fresh integer ids toward Codex and never reuses them.

### Requests from Codex to the extension
```jsonc
{"t":"req","rid":9,"method":"item/tool/call","params":{…}}
// ext answers:
{"t":"tool-response","rid":9,"result":{"success":true,"contentItems":[…]}}
```
If the extension port dies before answering, the bridge declines on its behalf
(`{"decision":"decline"}`) so Codex never hangs.

### Codex notifications forwarded verbatim
```jsonc
{"t":"notif","method":"item/completed","params":{…}}
```

### Lifecycle status
```jsonc
{"t":"status","state":"spawning|running|exited|restarting|dead","detail":{…}}
```
`detail` carries `exitCode`/`signal`/`attempt`/`codexPath`. After `dead` the host
keeps answering `ping` (health only); a new session requires reopening the panel.

## Chunk framing (host → ext)

Any envelope whose serialized length exceeds `SAFE_CHUNK` (512 KiB) is split:

```jsonc
{"t":"chunk","id":41,"data":"<slice>"}        // 1..n messages, in order
{"t":"chunkEnd","id":41,"totalChars":2097152,"chunks":4}
```

The receiver concatenates all slices for `id`, validates `totalChars`, then treats
the joined string as one JSON envelope. Ids increase monotonically per host process.

## Extension → host oversize

Not needed for V1: dynamicTools schemas stay well under 64 MiB. The bridge rejects
single inbound frames above 32 MiB defensively.
