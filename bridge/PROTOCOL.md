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

## Codex stdout framing (codex → host)

Newline-delimited JSON over stdio, decoded as a UTF-8 stream with a persistent
`StringDecoder` per child process: pipe-chunk boundaries are not character
boundaries, so a 2/3/4-byte sequence split across `data` events must survive.
Decoder and pending-line state reset on restart; a truncated final line (no
newline, or an incomplete UTF-8 sequence at EOF) is discarded with a bounded
stderr diagnostic and pending work fails — never silent corruption. One line is
bounded at 8 MiB UTF-16 code units (`MAX_CODEX_LINE_CHARS`); overlong data is
discarded and resyncs at the next newline. Malformed JSON lines are discarded
with a bounded (200-char) diagnostic preview.

## Chunk framing (host → ext)

Any envelope whose serialized length exceeds `SAFE_CHUNK` (256 Ki UTF-16 code units) is split:

```jsonc
{"t":"chunk","id":41,"data":"<slice>"}        // 1..n messages, in order
{"t":"chunkEnd","id":41,"totalChars":2097152,"chunks":4}
```

Byte versus character counts: `SAFE_CHUNK`/`totalChars` count UTF-16 code units
(`string.length`/`slice`), while the wire caps count UTF-8 framed bytes (host→ext
1 MiB per native message, extension→host 32 MiB per inbound frame). A 256 Ki-unit
slice of CJK/emoji stays well under the 1 MiB byte cap (2–3 bytes per unit, no
JSON-escape expansion for those scripts); ASCII slices with heavy quoting stay
under it via the 6x-escape headroom. The receiver validates both `totalChars`
and `chunks` plus byte/age budgets before joining.

The receiver concatenates all slices for `id`, validates `totalChars`, then treats
the joined string as one JSON envelope. Ids increase monotonically per host process.

## Extension → host oversize

Not needed for V1: dynamicTools schemas stay well under 64 MiB. The bridge rejects
single inbound frames above 32 MiB UTF-8 bytes defensively.

## Configuration inspection

For `config/read` responses, the host returns only `config.web_search` and MCP server
names/enabled states. Raw layers, provider configuration, environment variables,
headers, and hooks are deliberately omitted. This prevents credentials crossing into
Chrome during Nox tool-isolation checks. Other RPC envelopes retain their wire shape.
