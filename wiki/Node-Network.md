# Node Network

Windows and WSL on the same PC, or several machines, can stop being islands. One install is the **server**
(`BRIDGE_ROL=servidor`, needs `BRIDGE_WEB=1`): it keeps the Telegram bot and the web console. The other is a
**node** (`BRIDGE_ROL=nodo`): no token and no console of its own.

## Server and nodes

```bash
# on the server
npm run bridge:nodo -- invitar
# on the node, then restart its daemon
npm run bridge:nodo -- unirse http://127.0.0.1:4518 ABCD-EFGH-JKLM
```

The pairing code is single-use, expires in 10 minutes and dies after 5 wrong tries. After that, both sides prove
who they are with Ed25519 keys on every reconnection, so no secret travels. The server console gets a node selector;
what it may do there is set by the node.

`telegram_notify`, `telegram_ask` and `say`/`narrate` from a Claude session on the node reach your phone through the
server's bot, prefixed with the node name. Plain messages queue while the server is down; voice notes and questions
fail right away. `npm run bridge:nodo -- listar | revocar <name> | estado | salir` manage the pairing.

## What the server may do

`BRIDGE_NODO_PERMITE` on the node decides:

| Level | What it allows |
|---|---|
| `lectura` (default) | Look only |
| `operar` | Board, Soul and schedule changes that launch nothing, use no GPU and delete no work |
| `ejecutar` | Also launch agents, use the GPU, change the model and discard batches |

The server anticipates with a 403, the node enforces it, and every remote action is logged on both sides without the
request text. A message from another node is accepted only with `ejecutar` on the receiver and on the server,
because it makes that session act with its own permissions.

## Souls live on the server

A node (protocol 2) keeps no Souls of its own: `alma`, `say`/`narrate` with a Soul, voice chat and the connector's
memory read the server's, and the console never carries the node prefix in Soul views. By default a node only reads
them; `npm run bridge:nodo -- almas <node> escritura` (on the server) lets it write the diary, upload voice-chat
turns for consolidation, forget, seed and import.

If the server is down, narration goes out without a Soul and pending consolidations wait on the node. Souls, Soul
cards and schedules a node already had move with `npm run bridge:nodo -- migrar-almas [--simular]` on the node:
memories merge without duplicates, a different identity is kept aside as `alma.md.nodo-<name>`, and nothing is
deleted locally until the server confirms. The server keeps a read-only replica of each node's board, so a Soul sees
and annotates cards on every node; the console's **Todos** option shows the board and schedules of the whole network,
with disconnected nodes at their last known state.

## Another machine

Set `BRIDGE_NODOS_ESCUCHAR=<tailscale-ip>:<port>` on the server. It opens a second listener that only serves
`/nodo/*` (the console stays on loopback), only on the Tailscale interface or the WireGuard one named in
`BRIDGE_NODOS_INTERFAZ_CIFRADA`. A `100.x` address on your internet interface (ISP CGNAT) is refused.

The node joins with `unirse http://<name>.ts.net:<port> <code>`, or `--interfaz-cifrada <iface>` for another private
address, and every connection re-checks where the name resolves. Unauthenticated requests are rate-limited per IP.
The firewall rule is yours to add; `invitar` prints it.

The pairing and permissions are part of the security model: see [[Isolation and Security Model]].
