import "./style.js";
import { world, system, Player, CommandPermissionLevel, CustomCommandStatus, CustomCommandParamType } from '@minecraft/server';
import { defineModules } from './modules.js';
import { startAntiRedstone } from './antiredstone.js';

// Modules (/zc:lagmodules opens a menu; /zc:lagmodules <module> off also works):
const on = defineModules("wl", "zc:lagmodules", "AntiLag", [
    { key: "alerts", label: "low-TPS chat alert to players with the zc:lag_alert tag" },
    { key: "mobcap", label: "per-chunk mob cap (stops piglin/mob farms from lagging the server)" },
    { key: "autoclear", label: "automatic mob and item clear on sustained low TPS (manual /zc:lag clear still works)" },
    { key: "antiredstone", label: "removes redstone lines longer than 30 blocks near players (every 5 s)" },
]);

// Bypass/alert tags: the single tag (e.g. zc:border_bypass) or the AdminTools bitmask tag zc:p.<hex> (bit 10 = lag_alert).
function hasPermTag(player, key, bit) {
    if (player.hasTag("zc:" + key)) return true;
    for (const t of player.getTags()) {
        if (t.startsWith("zc:p.")) return ((parseInt(t.slice(5), 16) >> bit) & 1) === 1;
    }
    return false;
}

// ZephyCube AntiLag. Bedrock scripts cannot read per-chunk tick time, so chunks are ranked by
// what usually causes lag: entity load (weighted by type). TPS is measured from real time.
const ALERT_TAG = "zc:lag_alert";
const LOW_TPS = 16;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;
const DIMS = ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"];

// ---- Mob cap per chunk (stops piglin / mob farms from taking the server down) ----
const CAP = {
    enabled: true,
    everyTicks: 100,                 // check every 5 s
    maxRemovePerPass: 150,
    radius: 9,                       // blocks: the cap applies to same-type mobs within this horizontal radius (about one chunk of area)
    alertCooldownMs: 5 * 60 * 1000,
    // max of each type within `radius` blocks (all heights), so farms on chunk corners count as one group. Extra ones are removed without drops.
    perType: {
        "minecraft:zombified_piglin": 20, "minecraft:piglin": 20, "minecraft:piglin_brute": 10,
        "minecraft:hoglin": 12, "minecraft:zoglin": 12,
        "minecraft:zombie": 40, "minecraft:skeleton": 40, "minecraft:creeper": 30, "minecraft:spider": 30,
        "minecraft:enderman": 20, "minecraft:witch": 15, "minecraft:blaze": 25, "minecraft:magma_cube": 25, "minecraft:slime": 25,
        "minecraft:cow": 40, "minecraft:pig": 40, "minecraft:sheep": 40, "minecraft:chicken": 50, "minecraft:rabbit": 30,
        "minecraft:goat": 30, "minecraft:horse": 30, "minecraft:mooshroom": 30
    }
};
const capAlerted = new Map();

// ---- Automatic clear on low TPS: countdown in chat, then removes mobs and ground items ----
const AUTO = {
    enabled: true,
    triggerTps: 15,            // average TPS of the last `sustainSeconds` samples below this starts the countdown
    sustainSeconds: 10,
    cancelAboveTps: 17,        // countdown is cancelled if the TPS is back above this for 5 samples
    countdownSeconds: 60,
    cooldownMs: 5 * 60 * 1000,
    minEntities: 400,          // only clear when this many non-player entities are loaded (else lag is not from entities)
    clearItems: true,
    clearMobs: true,
    animalKeepPerChunk: 20,    // farm animals: keep this many per chunk, remove the rest
    notifyAt: [60, 30, 10, 5, 4, 3, 2, 1]
};
const ANIMALS = new Set(["minecraft:cow", "minecraft:pig", "minecraft:sheep", "minecraft:chicken", "minecraft:rabbit", "minecraft:goat",
    "minecraft:horse", "minecraft:donkey", "minecraft:mule", "minecraft:llama", "minecraft:mooshroom", "minecraft:camel"]);
const NEVER_CLEAR = new Set(["minecraft:player", "minecraft:thrown_trident", "minecraft:villager", "minecraft:villager_v2", "minecraft:zombie_villager", "minecraft:zombie_villager_v2",
    "minecraft:wandering_trader", "minecraft:iron_golem", "minecraft:snow_golem", "minecraft:copper_golem", "minecraft:armor_stand",
    "minecraft:wither", "minecraft:ender_dragon", "minecraft:warden", "minecraft:elder_guardian", "minecraft:ender_crystal",
    "minecraft:bee", "minecraft:allay", "minecraft:leash_knot", "minecraft:painting", "minecraft:item_frame", "minecraft:glow_item_frame",
    "minecraft:npc", "minecraft:happy_ghast", "minecraft:nautilus", "minecraft:zombie_nautilus", "minecraft:armadillo"]);
let clearAt = 0;          // 0 = no countdown running
let lastClear = 0;
let notified = new Set();
let recovered = 0;

const WEIGHTS = {
    "minecraft:item": 1, "minecraft:xp_orb": 1, "minecraft:arrow": 1,
    "minecraft:villager_v2": 6, "minecraft:villager": 6, "minecraft:zombie_villager_v2": 4,
    "minecraft:minecart": 8, "minecraft:hopper_minecart": 10, "minecraft:chest_minecart": 8,
    "minecraft:tnt_minecart": 8, "minecraft:tnt": 6, "minecraft:falling_block": 4
};
const weight = (t) => WEIGHTS[t] ?? 3;

let samples = [];       // recent TPS readings (one per second)
let lastReal = Date.now();
let lastTick = system.currentTick;
let lastAlert = 0;
let hotspots = [];      // last scan result

system.runInterval(() => {
    const now = Date.now();
    const dt = (now - lastReal) / 1000;
    const ticks = system.currentTick - lastTick;
    lastReal = now; lastTick = system.currentTick;
    if (dt <= 0) return;
    const tps = Math.min(20, ticks / dt);
    samples.push(tps);
    if (samples.length > 60) samples.shift();
    autoClearCheck(tps);
    if (on("alerts") && samples.length >= 5 && tps < LOW_TPS && now - lastAlert > ALERT_COOLDOWN_MS) {
        lastAlert = now;
        const res = scan();
        const ents = statsText();
        const top = res.slice(0, 3).map(h => `${h.dim.replace("minecraft:", "")} ${h.cx * 16 + 8}, ${h.cz * 16 + 8} (${h.count} ent)`).join(" | ");
        console.warn(`[Lag] TPS ${tps.toFixed(1)}. Entities: ${ents}. Top chunks: ${top}`);
        for (const p of world.getAllPlayers()) {
            try { if (hasPermTag(p, "lag_alert", 10)) p.sendMessage(`§8[§bLag§8]§c TPS ${tps.toFixed(1)}. §7Entities: ${ents}. Top chunks: ${top}. §8/zc:lag list`); } catch { }
        }
    }
}, 20);

let lastStats = { total: 0, items: 0, by: new Map() };
// "2669 (items 120) | zombified_piglin 1800, cow 300, hopper 120" from the last scan()
function statsText() {
    const top = [...lastStats.by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([id, n]) => `${id.replace("minecraft:", "")} ${n}`).join(", ");
    return `${lastStats.total} (items ${lastStats.items})${top ? " | " + top : ""}`;
}

function scan() {
    const out = [];
    const by = new Map(); let total = 0, items = 0;
    for (const dimId of DIMS) {
        let ents;
        try { ents = world.getDimension(dimId).getEntities(); } catch { continue; }
        const map = new Map();
        for (const e of ents) {
            try {
                const id = e.typeId;
                if (id === "minecraft:player") continue;
                total++; if (id === "minecraft:item") items++;
                by.set(id, (by.get(id) ?? 0) + 1);
                const { x, z } = e.location;
                const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
                const k = cx + "," + cz;
                let c = map.get(k);
                if (!c) { c = { dim: dimId, cx, cz, count: 0, score: 0, types: new Map(), y: e.location.y }; map.set(k, c); }
                c.count++; c.score += weight(e.typeId);
                c.types.set(e.typeId, (c.types.get(e.typeId) ?? 0) + 1);
            } catch { }
        }
        out.push(...map.values());
    }
    lastStats = { total, items, by };
    out.sort((a, b) => b.score - a.score);
    hotspots = out.slice(0, 10);
    return hotspots;
}

const avg = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 20;

system.beforeEvents.startup.subscribe((init) => {
    const reg = init.customCommandRegistry;
    reg.registerEnum("zc:lagaction", ["list", "tp", "clear", "cancel"]);
    reg.registerCommand({
        name: "zc:lag",
        description: "Lag finder (no argument = TPS): list (scan chunks by entity load) | tp <n> (go to hotspot n) | clear (start the mob and item clear countdown) | cancel",
        permissionLevel: CommandPermissionLevel.GameDirectors,
        cheatsRequired: false,
        optionalParameters: [
            { name: "zc:lagaction", type: CustomCommandParamType.Enum },
            { name: "n", type: CustomCommandParamType.Integer }
        ]
    }, (origin, action, n) => {
        if (action === undefined || action === null) action = "tps"; // no argument: show TPS
        const p = origin.sourceEntity instanceof Player ? origin.sourceEntity : (origin.initiator instanceof Player ? origin.initiator : null);
        const ok = (m) => ({ status: CustomCommandStatus.Success, message: m });
        if (action === "tps") {
            const last = samples[samples.length - 1] ?? 20;
            const min = samples.length ? Math.min(...samples) : 20;
            return ok(`§8[§bLag§8]§7 TPS now ${last.toFixed(1)}, avg ${avg(samples).toFixed(1)}, min ${min.toFixed(1)} (last ${samples.length}s)`);
        }
        if (action === "list") {
            const res = scan();
            if (!res.length) return ok("§8[§bLag§8]§7 No entities found.");
            const lines = res.map((h, i) => {
                const top = [...h.types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, c]) => `${t.replace("minecraft:", "")} x${c}`).join(", ");
                return `§e${i + 1}. §f${h.dim.replace("minecraft:", "")} ${h.cx * 16}..${h.cx * 16 + 15}, ${h.cz * 16}..${h.cz * 16 + 15} §7load ${h.score} (${h.count} ent: ${top})`;
            });
            return ok(`§8[§bLag§8]§7 Top chunks by entity load (TPS ${(samples[samples.length - 1] ?? 20).toFixed(1)}):\n` + lines.join("\n"));
        }
        if (action === "clear") {
            if (clearAt) return ok("§8[§bLag§8]§7 A clear is already counting down.");
            startCountdown("a staff member started a clear");
            return ok("§8[§bLag§8]§7 Clear countdown started.");
        }
        if (action === "cancel") {
            if (!clearAt) return ok("§8[§bLag§8]§7 No clear is running.");
            clearAt = 0; notified = new Set();
            world.sendMessage("§8[§bLag§8]§a Clear cancelled by staff.");
            return ok("§8[§bLag§8]§7 Cancelled.");
        }
        // tp
        const h = hotspots[(n ?? 0) - 1];
        if (!p) return { status: CustomCommandStatus.Failure, message: "Players only." };
        if (!h) return { status: CustomCommandStatus.Failure, message: "Run /zc:lag list first, then /zc:lag tp <1-10>." };
        system.run(() => { try { p.teleport({ x: h.cx * 16 + 8, y: h.y + 2, z: h.cz * 16 + 8 }, { dimension: world.getDimension(h.dim) }); } catch { } });
        return ok(`§8[§bLag§8]§7 Teleporting to hotspot ${n}.`);
    });
});

// ---- cap enforcement ----
// True for mobs a player cares about: named, tamed, saddled, with a chest, leashed, ridden or tagged zc:keep.
// (tamed state is the "minecraft:is_tamed" component; the tameable component has no isTamed property)
function keepEntity(e) {
    try {
        if (e.nameTag) return true;
        if (e.hasComponent("minecraft:is_tamed") || e.hasComponent("minecraft:is_saddled") || e.hasComponent("minecraft:is_chested")) return true;
        if (e.getComponent("minecraft:leashable")?.isLeashed) return true;
        if (e.getComponent("minecraft:rideable")?.getRiders?.().length) return true;
        if (e.hasTag("zc:keep")) return true;
    } catch { }
    return false;
}

function enforceCaps() {
    if (!CAP.enabled) return;
    let removed = 0;
    for (const dimId of DIMS) {
        let dim;
        try { dim = world.getDimension(dimId); } catch { continue; }
        // Density cap: count same-type mobs within CAP.radius blocks of each mob instead of per 16x16 chunk, so a farm
        // sitting on a chunk corner (split over 2-4 chunks) is capped the same as one inside a single chunk.
        for (const type of Object.keys(CAP.perType)) {
            const cap = CAP.perType[type];
            let ents;
            try { ents = dim.getEntities({ type }); } catch { continue; }
            if (ents.length <= cap) continue;                    // cheap exit: fewer than the cap in the whole dimension
            const pts = [], cells = new Map();
            for (const e of ents) {
                try {
                    const { x, z } = e.location;
                    const p = { e, x, z };
                    pts.push(p);
                    const ck = Math.floor(x / 16) + "|" + Math.floor(z / 16);
                    let c = cells.get(ck); if (!c) { c = []; cells.set(ck, c); }
                    c.push(p);
                } catch { }
            }
            const r2 = CAP.radius * CAP.radius;
            let n = 0, first = null;
            for (const p of pts) {
                if (removed >= CAP.maxRemovePerPass) break;
                const cx = Math.floor(p.x / 16), cz = Math.floor(p.z / 16);
                let count = 0;
                for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
                    const c = cells.get((cx + dx) + "|" + (cz + dz)); if (!c) continue;
                    for (const o of c) if (!o.gone && (o.x - p.x) ** 2 + (o.z - p.z) ** 2 <= r2) count++;
                }
                if (count <= cap || keepEntity(p.e)) continue;
                try { p.e.remove(); p.gone = true; n++; removed++; if (!first) first = p; } catch { }
            }
            if (n > 0 && first) {
                const kk = dimId + "|" + type + "|" + Math.floor(first.x / 32) + "|" + Math.floor(first.z / 32), now = Date.now();
                if (now - (capAlerted.get(kk) ?? 0) > CAP.alertCooldownMs) {
                    capAlerted.set(kk, now);
                    let near = "nobody";
                    try {
                        let bd = 96 * 96;
                        for (const pl of dim.getPlayers()) {
                            const d = (pl.location.x - first.x) ** 2 + (pl.location.z - first.z) ** 2;
                            if (d < bd) { bd = d; near = pl.name; }
                        }
                    } catch { }
                    const msg = `Mob cap: removed ${n} ${type.replace("minecraft:", "")} (cap ${cap} within ${CAP.radius} blocks) in ${dimId.replace("minecraft:", "")} near ${Math.floor(first.x)}, ${Math.floor(first.z)} | nearest player: ${near}`;
                    console.warn(`[Lag] ${msg}`);
                    for (const p of world.getAllPlayers()) {
                        try { if (hasPermTag(p, "lag_alert", 10)) p.sendMessage(`\u00a78[\u00a7bLag\u00a78]\u00a7e ${msg}`); } catch { }
                    }
                }
            }
        }
    }
    if (capAlerted.size > 500) capAlerted.clear();
}
system.runInterval(() => { try { if (on("mobcap")) enforceCaps(); } catch (e) { console.warn(`[Lag] cap error: ${e}`); } }, CAP.everyTicks);

// ---- auto clear implementation ----
function startCountdown(why) {
    clearAt = Date.now() + AUTO.countdownSeconds * 1000;
    notified = new Set();
    for (const s of AUTO.notifyAt) if (s >= AUTO.countdownSeconds) notified.add(s);
    recovered = 0;
    console.warn(`[Lag] Clear countdown started (${why}).`);
    announce(AUTO.countdownSeconds);
}

function announce(secs) {
    const what = AUTO.clearItems && AUTO.clearMobs ? "mobs and ground items" : (AUTO.clearItems ? "ground items" : "mobs");
    try { world.sendMessage(`§8[§bLag§8]§e Clearing ${what} in §c${secs}§e second${secs === 1 ? "" : "s"}. §7Pick up what you want to keep!`); } catch { }
}

function totalEntities() {
    let n = 0;
    for (const d of DIMS) { try { n += world.getDimension(d).getEntities().length; } catch { } }
    return n;
}

function autoClearCheck(tps) {
    if (!AUTO.enabled || !on("autoclear")) return;
    const now = Date.now();
    if (!clearAt) {
        if (now - lastClear < AUTO.cooldownMs || samples.length < AUTO.sustainSeconds) return;
        const recent = samples.slice(-AUTO.sustainSeconds);
        if (avg(recent) >= AUTO.triggerTps) return;
        if (world.getAllPlayers().length === 0) return;
        const n = totalEntities();
        if (n < AUTO.minEntities) { lastClear = now - AUTO.cooldownMs + 60000; console.warn(`[Lag] Low TPS but only ${n} entities: no clear.`); return; }
        startCountdown(`TPS ${avg(recent).toFixed(1)} with ${n} entities`);
        return;
    }
    if (tps >= AUTO.cancelAboveTps) recovered++; else recovered = 0;
    if (recovered >= 5) {
        clearAt = 0; notified = new Set(); lastClear = now;
        world.sendMessage("§8[§bLag§8]§a TPS is back to normal. Clear cancelled.");
        return;
    }
    // runs every second but the countdown messages use real time
    runCountdownTick();
}

function runCountdownTick() {
    if (!clearAt) return;
    const left = Math.ceil((clearAt - Date.now()) / 1000);
    if (left > 0) {
        let hit = false;
        for (const s of AUTO.notifyAt) if (left <= s && !notified.has(s)) { notified.add(s); hit = true; }   // a stall can skip several marks: say it once
        if (hit) announce(left);
        return;
    }
    clearAt = 0; notified = new Set(); lastClear = Date.now();
    doClear();
}

// finer countdown (every 5 ticks) so messages are on time; at very low TPS this is just as slow as the server
system.runInterval(() => { try { if (clearAt) runCountdownTick(); } catch { } }, 5);

const keepMob = keepEntity;

function doClear() {
    let items = 0, mobs = 0;
    const before = totalEntities();
    for (const dimId of DIMS) {
        let dim; try { dim = world.getDimension(dimId); } catch { continue; }
        if (AUTO.clearItems) {
            try { for (const e of dim.getEntities({ type: "minecraft:item" })) { try { if (e.getComponent("minecraft:item")?.itemStack?.typeId === "minecraft:trident") continue; e.remove(); items++; } catch { } } } catch { }
        }
        if (!AUTO.clearMobs) continue;
        const animals = new Map();
        let ents; try { ents = dim.getEntities(); } catch { continue; }
        for (const e of ents) {
            try {
                const id = e.typeId;
                if (!id.startsWith("minecraft:") || NEVER_CLEAR.has(id)) continue;
                if (!e.getComponent("minecraft:health")) continue;      // only living things
                if (keepMob(e)) continue;
                if (ANIMALS.has(id)) {
                    const { x, z } = e.location;
                    const k = id + "|" + Math.floor(x / 16) + "|" + Math.floor(z / 16);
                    const c = (animals.get(k) ?? 0) + 1; animals.set(k, c);
                    if (c <= AUTO.animalKeepPerChunk) continue;
                }
                e.remove(); mobs++;
            } catch { }
        }
    }
    const msg = `Cleared ${mobs} mobs and ${items} ground items.`;
    console.warn(`[Lag] ${msg} Entities before ${before}.`);
    try { world.sendMessage(`§8[§bLag§8]§a ${msg}`); } catch { }
    // report the TPS a few seconds later
    system.runTimeout(() => {
        try {
            const last = samples[samples.length - 1] ?? 20;
            console.warn(`[Lag] After the clear: TPS ${last.toFixed(1)}, entities ${totalEntities()}.`);
        } catch { }
    }, 100);
}

// Anti-redstone (merged from Utility Anti Redstone by FEBERNAISYSTUDIOS). No bypass: every player's surroundings are checked.
startAntiRedstone(() => on("antiredstone"));
