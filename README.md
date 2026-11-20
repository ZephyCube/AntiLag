<p align="center"><img src="logo.png" alt="ZephyCube" width="160"></p>

# ZephyCubeLag v1.4.4

Finds laggy chunks, caps mobs per chunk, clears mobs and items on low TPS and removes over-long redstone lines. TPS is measured from real time.

> [!NOTE]
> This add-on is built for, and tuned specifically for, [WhitemaneSMP](https://whitemane.fun/). Every feature is a separate module, so you can turn off anything you do not need with `/zc:lagmodules <module> off` (run `/zc:lagmodules` to list the modules).

## Install

Download `ZephyCubeLag-v1.4.4.mcpack` from the Releases page and open it. Or install by hand: copy the `ZephyCubeLag` folder into your world's `behavior_packs` folder and add its `uuid` and `version` (from `manifest.json`) to the world's `world_behavior_packs.json`. Needs `@minecraft/server` 2.8.0.

## Features (modules)
`/zc:lagmodules <module> off|on` (no argument lists them). Saved in the world.

| Module | What it does |
| --- | --- |
| `alerts` | When TPS stays under 16, players with the alert tag get the TPS, entity breakdown and top 3 chunks (at most every 5 min) |
| `mobcap` | Every 5 s, removes (no drops) same-type mobs above a cap inside a 9-block radius. Caps: piglins 20, brutes 10, hoglins/zoglins 12, zombie/skeleton 40, creeper/spider 30, enderman 20, witch 15, blaze/magma cube/slime 25, cow/pig/sheep 40, chicken 50, rabbit/goat/horse/mooshroom 30 |
| `antiredstone` | Every 5 s, removes redstone lines longer than 30 blocks (dust, repeaters, comparators, torches) within 16 blocks of each player (y +-8), plus 3 random far chunks. Sends the player a message with the location. Skipped for players with the bypass. Merged from Utility Anti Redstone by FEBERNAISYSTUDIOS, slimmed down |
| `autoclear` | Automatic clear: average TPS under 15 for 10 s and 400+ entities starts a 60 s chat countdown, then removes mobs and ground items (farm animals keep 20 per chunk). Cancels if TPS goes back above 17. 5 min cooldown |

Never cleared: players, thrown tridents, villagers, zombie villagers, wandering traders, golems, armor stands, bosses, ender crystals, bees, allays, leashes, paintings, item frames, NPCs, happy ghasts, nautiluses, armadillos. Mobs tagged `zc:keep`, named, tamed, saddled, with a chest, leashed or ridden are never removed by the mob cap.

## Commands
| Command | Who | Use |
| --- | --- | --- |
| `/zc:lag` | operators | Show TPS now, average and minimum |
| `/zc:lag list` | operators | Scan chunks by entity load (top 10) |
| `/zc:lag tp <n>` | operators | Teleport to hotspot n of the last list |
| `/zc:lag clear` | operators | Start the clear countdown now (works with `autoclear` off) |
| `/zc:lag cancel` | operators | Cancel a running countdown |
| `/zc:lagmodules [module] [on\|off]` | operators | List or toggle modules |

## Tags
| Tag | On | Effect |
| --- | --- | --- |
| `zc:lag_alert` | player | Receives low-TPS and mob-cap alerts (also in the AdminTools bitmask `zc:p.<hex>`, bit 10) |
| `zc:keep` | mob | Never removed by the mob cap |
| `zc:redstone_bypass` | player | Redstone lines near this player are not removed (also in the AdminTools bitmask `zc:p.<hex>`, bit 14) |

## Storage
World property `wl:modules`.

## License

MIT, see `LICENSE`.
