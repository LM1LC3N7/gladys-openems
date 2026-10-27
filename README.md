# gladys-openems

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for
**FENECON FEMS** and **OpenEMS** storage systems, read locally through the
JSON-RPC WebSocket API of the OpenEMS Edge (port 8085). Read-only. Not
affiliated with FENECON nor the OpenEMS Association.

**Never tested with a real device.** Feedback welcome.

- State of charge, battery, grid, production and house powers.
- Lifetime energy counters (production, house, grid bought and sold, battery
  charge and discharge), each guarded: never 0, never a drop nor an
  implausible jump without a two-click acceptance (one case aside, a system
  clock wrong by hours across a restart: see the user guide).
- A production index for the Gladys energy monitoring (or "Sensor only").
- System state and grid mode.
- No cloud, one connection per read, never faster than the interval (except
  right after a new address or password is saved).

User guide: [English](docs/en.md) · [Français](docs/fr.md).

## Development

```bash
npm install
npm test
npm run lint && npm run format:check
```

See [CLAUDE.md](CLAUDE.md) for the architecture and the rules,
[TODO.md](TODO.md) for the decisions and what is left to check on a real
system.

## License

Apache-2.0 (see `LICENSE`). Logic ported from
[ha_openems](https://github.com/Lamarqe/ha_openems) (Apache-2.0); see
`THIRD_PARTY_NOTICES.md`. OpenEMS itself is not used nor ported: only its
network API is called.
