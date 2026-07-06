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
- mute or unmute a strip
- set pan
- set scribble-strip name
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

On the console, open the remote/network settings and make sure:

- OSC remote control is enabled
- OSC remote lock is off
- the console has an IP address reachable from the machine running the MCP server

Avoid exposing the console network to the public internet. The OSC control
surface is intended for trusted local networks.

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
| `set_fader` | Set a strip fader level in dB. |
| `set_mute` | Mute or unmute a strip. |
| `set_pan` | Set strip pan from `-100` left to `100` right. |
| `set_name` | Set a strip scribble-strip name. |
| `get_strip_status` | Read name, fader, mute, and pan for one strip. |
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
