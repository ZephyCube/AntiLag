// Anti-redstone module: removes redstone lines longer than MAX_CHAIN blocks (redstone dust, repeaters, comparators,
// redstone torches), a common cause of redstone lag machines.
// Based on "Utility Anti Redstone" by FEBERNAISYSTUDIOS. Slimmed down: the original scanned a 33x17x33 cube around every
// player in all dimensions every 2 seconds (and filled the world with air on an empty server). This version checks only each
// player's own dimension, every 5 seconds, time-sliced with runJob, and does nothing while nobody is online.
import { world, system, BlockPermutation } from "@minecraft/server";

const MAX_CHAIN = 30;       // longest allowed connected redstone line
const NEAR_RANGE = 16;      // blocks around each player (x/z); y is +-8
const FAR_RANGE_CHUNKS = 32;
const CHECK_INTERVAL = 100; // ticks (5 s)

const REDSTONE = new Set([
    "minecraft:redstone_wire", "minecraft:repeater", "minecraft:comparator",
    "minecraft:redstone_torch", "minecraft:redstone_wall_torch",
]);
const isRedstone = (b) => !!b && REDSTONE.has(b.typeId);
const key = (l) => `${l.x},${l.y},${l.z}`;
const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];

function chainLength(start, dim) {
    const seen = new Set();
    const queue = [start];
    let count = 0;
    for (let i = 0; i < queue.length; i++) {
        const b = queue[i];
        const k = key(b.location);
        if (seen.has(k)) continue;
        seen.add(k);
        if (!isRedstone(b)) continue;
        if (++count > MAX_CHAIN) return count;
        for (const d of DIRS) {
            try {
                const n = dim.getBlock({ x: b.location.x + d[0], y: b.location.y + d[1], z: b.location.z + d[2] });
                if (n && isRedstone(n)) queue.push(n);
            } catch { }
        }
    }
    return count;
}

function* checkNearPlayer(player, dim, hasBypass) {
    if (hasBypass(player)) return;
    const pos = player.location;
    let n = 0;
    for (let x = -NEAR_RANGE; x <= NEAR_RANGE; x++) {
        for (let y = -8; y <= 8; y++) {
            for (let z = -NEAR_RANGE; z <= NEAR_RANGE; z++) {
                if (++n % 400 === 0) { yield; if (!player.isValid) return; }
                let block;
                try { block = dim.getBlock({ x: Math.floor(pos.x + x), y: Math.floor(pos.y + y), z: Math.floor(pos.z + z) }); } catch { continue; }
                if (!isRedstone(block)) continue;
                const len = chainLength(block, dim);
                if (len > MAX_CHAIN) {
                    const loc = block.location;
                    try { block.setPermutation(BlockPermutation.resolve("minecraft:air")); } catch { continue; }
                    try { player.sendMessage(`§cRedstone line too long (over ${MAX_CHAIN}) at ${key(loc)}: removed.`); } catch { }
                }
            }
        }
    }
}

function checkFarChunks(dim, players) {
    const near = new Set(players.map((p) => `${Math.floor(p.location.x / 16)},${Math.floor(p.location.z / 16)}`));
    for (let i = 0; i < 3; i++) {
        const cx = Math.floor(Math.random() * FAR_RANGE_CHUNKS * 2) - FAR_RANGE_CHUNKS;
        const cz = Math.floor(Math.random() * FAR_RANGE_CHUNKS * 2) - FAR_RANGE_CHUNKS;
        if (near.has(`${cx},${cz}`)) continue;
        let block;
        try { block = dim.getBlock({ x: cx * 16, y: 64, z: cz * 16 }); } catch { continue; }
        if (!isRedstone(block)) continue;
        if (chainLength(block, dim) > MAX_CHAIN) {
            try { block.setPermutation(BlockPermutation.resolve("minecraft:air")); } catch { }
        }
    }
}

let running = false;

/** isOn(): module toggle. hasBypass(player): true = this player's surroundings are not checked. */
export function startAntiRedstone(isOn, hasBypass) {
    function* sweep() {
        try {
            const dims = new Map();
            for (const p of world.getAllPlayers()) {
                if (!p.isValid) continue;
                if (!dims.has(p.dimension.id)) dims.set(p.dimension.id, { dim: p.dimension, players: [] });
                dims.get(p.dimension.id).players.push(p);
                yield* checkNearPlayer(p, p.dimension, hasBypass);
            }
            for (const { dim, players } of dims.values()) checkFarChunks(dim, players);
        } catch { }
        running = false;
    }
    system.runInterval(() => {
        if (running || !isOn()) return;
        if (world.getAllPlayers().length === 0) return;
        running = true;
        system.runJob(sweep());
    }, CHECK_INTERVAL);
}
