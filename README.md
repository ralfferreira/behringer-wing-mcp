# Behringer WING MCP

Model Context Protocol (MCP) server for Behringer WING digital mixers.

The server exposes a small, practical toolset for controlling a WING, WING
Compact, or WING Rack from an MCP client. It talks to the console over OSC/UDP
and uses stateless request/response calls so it can coexist with other WING
integrations on the same network.

## Current status

This is an early open-source implementation. The typed tools cover common strip
operations:

- set fader level
- adjust fader level relatively
- mute or unmute a strip
- set pan
- set scribble-strip name
- find/list strips by scribble-strip name
- set bus send level from typed source/destination fields
- read a small strip status snapshot
- read or write a raw OSC address as an escape hatch

The code can be built and tested without a console. Actual OSC calls require a
WING on the same network.

## Requirements

- Node.js 20 or newer
- A Behringer WING-family console reachable on the network
- OSC enabled and unlocked on the console

The WING OSC service uses UDP port `2223` by default. The console also has a
TCP control surface on port `2222`, but this MCP server uses OSC only.

## Install from source

```bash
git clone https://github.com/ralfferreira/behringer-wing-mcp.git
cd behringer-wing-mcp
npm ci
npm run build
```

## Configure the console

On the WING touchscreen open **Setup → Remote** and check:

1. OSC remote control is enabled
2. **Remote Lock for OSC is OFF** (if this stays ON, the assistant can read the desk but mute/fader changes do nothing)
3. The console IP is reachable from the computer running this MCP server

If someone says “the AI answered OK but the fader did not move,” check Remote Lock first.

Avoid exposing the console network to the public internet. The OSC control
surface is intended for trusted local networks.

## Surface names vs stored names

The WING keeps two labels on many strips:

- **Surface name** (`/$name`). What the operator sees on the desk scribble.
- **Stored name** (`/name`). An internal label that can be different.

Example from a live show: surface **VIOLAO** was stored as `SPDS L`, and surface
**SPDS** was stored as `GUITARRA L`. If an assistant mutes “SPDS” using an old
channel number from chat memory, it can hit the wrong instrument.

`find_strip_by_name` and `list_strips` prefer the surface name and expose
`storedName` when it differs.

## How assistants should control the desk

This server is meant for non-technical operators talking to an AI assistant.
Assistants must follow this loop on every named change:

1. Call `find_strip_by_name` with the words the operator used (VS, Caixa, SPDS, Violao, Guitar).
2. Read `name`, `storedName`, `kind`, and `index` from that fresh result.
3. If `ambiguous` is true, or several matches share the top score, ask which strip before writing.
4. Only then call `set_mute`, `set_fader`, `adjust_fader`, `set_pan`, or `set_name`.

Do **not**:

- Reuse `ch/12` (or any index) remembered from earlier in the conversation
- Assume the stored `/name` matches the scribble on the surface
- Mute or move a fader from a stale `list_strips` snapshot without finding again

Several independent writes in one turn (different strips) are fine. Do not fire
two writes at the same strip address at once.

## Configure an MCP client

Build the project first, then point your MCP client at `dist/index.js`.

Example:

```json
{
  "mcpServers": {
    "wing": {
      "command": "node",
      "args": ["/absolute/path/to/behringer-wing-mcp/dist/index.js"],
      "env": {
        "WING_HOST": "192.168.1.50"
      }
    }
  }
}
```

Windows example path:

```json
{
  "mcpServers": {
    "wing": {
      "command": "node",
      "args": ["C:/Users/USER/Documents/Code/behringer-wing-mcp/dist/index.js"],
      "env": {
        "WING_HOST": "192.168.1.50"
      }
    }
  }
}
```

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `WING_HOST` | yes | - | Console IP address or hostname. |
| `WING_PORT` | no | `2223` | OSC UDP port. |
| `WING_TIMEOUT_MS` | no | `1500` | Timeout for one OSC request/response. |
| `WING_READ_ONLY` | no | `false` | Set to `true`, `1`, `yes`, or `on` to block write tools. |

## Tools

| Tool | Description |
| --- | --- |
| `set_fader` | Set a strip fader level in dB. Find by surface name first when the operator names a strip. |
| `adjust_fader` | Change a strip fader relatively by a dB delta. Find first when named. |
| `set_mute` | Mute or unmute a strip. Find first when named. |
| `set_pan` | Set strip pan from `-100` left to `100` right. Find first when named. |
| `set_name` | Set a strip stored scribble `/name`. Find first when named. |
| `get_strip_status` | Read surface name, stored name, fader, mute, and pan for one strip. |
| `find_strip_by_name` | Find strips by surface name (and stored name). Required before named writes. |
| `list_strips` | List strip IDs with surface names, optionally with status. Overview only. |
| `set_bus_send` | Set a channel, aux, or bus send level to a bus destination. |
| `osc_get` | Read any raw OSC address. |
| `osc_set` | Write any raw OSC address, then read it back. |

Supported typed strip kinds:

| Kind | Range | Notes |
| --- | --- | --- |
| `ch` | `1-40` | Main input channels. |
| `aux` | `1-8` | Aux input channels. Together, `ch` + `aux` map to the WING-family 48 input channels. |
| `bus` | `1-16` | Buses. |
| `main` | `1-4` | Main buses. |
| `mtx` | `1-8` | Matrices. |
| `dca` | `1-16` | DCAs in the remote-control model. |

## Natural-language helper examples

These tools are meant to let MCP clients work from plain prompts without
needing to know every OSC leaf.

```text
find_strip_by_name query="violao"
set_mute kind="ch" index=11 muted=true
adjust_fader kind="ch" index=15 delta_db=-3
list_strips kinds=["ch","aux","bus"] include_status=false
set_bus_send source_kind="ch" source_index=1 bus=5 db=-12 enabled=true
```

Always run `find_strip_by_name` in the same turn as the write when the operator
names a strip. The find result includes `kind`, `index`, `id`, `name` (surface),
optional `storedName`, and `score`. If multiple matches have the same top score,
ask which strip before writing.

`list_strips` performs live request/response reads. By default it reads strip
names only for a compact map of IDs to labels; set `include_status=true` to also
read fader, mute, and pan values. Treat it as an overview, not as a substitute
for a fresh find before a write.

`set_bus_send` writes `/<source>/<index>/send/<bus>/lvl` and accepts source
kinds `ch`, `aux`, and `bus`. When `enabled` is provided, it also writes the
send `on` state. Like every write helper, it is blocked by `WING_READ_ONLY=true`.

## Raw OSC examples

Use raw OSC tools for parameters not yet covered by typed tools:

```text
osc_get address="/ch/1/fdr"
osc_set address="/ch/1/mute" value=1 force_type="i"
osc_set address="/ch/1/name" value="Lead Vox" force_type="s"
```

Raw writes can affect a live mix immediately. Use `WING_READ_ONLY=true` when
you only want to inspect values.

## Development

```bash
npm ci
npm test
npm run build
```

Useful scripts:

- `npm run build` compiles TypeScript into `dist/`
- `npm test` builds and runs offline unit tests
- `npm run dev` starts TypeScript watch mode
- `npm start` runs the built server

To try the server with the MCP Inspector:

```bash
WING_HOST=192.168.1.50 npx @modelcontextprotocol/inspector node dist/index.js
```

PowerShell:

```powershell
$env:WING_HOST = "192.168.1.50"
npx @modelcontextprotocol/inspector node dist/index.js
```

## Project layout

```text
src/index.ts       MCP server and tool definitions
src/osc.ts         Minimal OSC encoder/decoder and UDP client
src/wing.ts        WING address helpers and typed operations
src/*.test.ts      Offline tests for OSC and address helpers
```

## References

- [Behringer WING product page](https://www.behringer.com/wing)
- [Behringer WING Rack documentation list](https://www.behringer.com/wing/wing-rack)
- [Patrick-Gilles Maillot WING remote-control resources](https://sites.google.com/site/patrickmaillot/wing)
- [Bitfocus Companion Behringer WING module](https://github.com/bitfocus/companion-module-behringer-wing)

## License

MIT
