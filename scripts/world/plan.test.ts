import { describe, expect, it } from "bun:test";
import { HOSTS, objectName, dockerCallOf, slotDeadline, addresses, bandRefusal, checkWorldName, cpuList, cpuSet, wellFormedCpus, machineContainer, machineSpec, overlaps, pickSubnet, planFromArgs, PlanError, samePins, savedPlan, slotBand } from "./plan.ts";
import { PLUGIN_ID, presetSteps, STANDIN_USER, standinUser } from "./standins.ts";
import { STAGING_ACCOUNT_SERVICE } from "../../server/relay/service.ts";

const SLOT = { OVIS_HEAVY_SLOT: "2", OVIS_HEAVY_CPUS: "68-79" };
/** this PC inside heavy-run.sh's slot 2: 128 CPUs online, the process under `taskset -c 68-79` */
const HOST = { online: "0-127", allowed: "68-79" };
const defaults = { repo: "/repo", scratchRoot: "/scratch", hcBin: "/hc", env: SLOT, host: HOST, random: () => 0.5 };

describe("the CPU-set rule", () => {
  it("reads the kernel's and docker's lists and refuses malformed ones", () => {
    expect(cpuSet("116-127")).toHaveLength(12);
    expect(cpuSet("120,112-113")).toEqual([112, 113, 120]);
    for (const bad of ["127-112", "112-127,", "all", "", "-3"]) expect(() => cpuSet(bad)).toThrow(PlanError);
    expect([cpuList([61, 62, 63, 125, 126, 127]), cpuList([7]), cpuList([3, 1, 2, 2]), cpuList([])]).toEqual(["61-63,125-127", "7", "1-3", ""]);
    expect(cpuSet(cpuList([40, 41, 42, 104, 105, 106, 9]))).toEqual([9, 40, 41, 42, 104, 105, 106]);
  });

  it("tells an unpinned or differently pinned container from a pinned one", () => {
    expect(samePins("112-127", "112-127")).toBe(true);
    expect(samePins("112-115", "112,113,114,115")).toBe(true);
    expect(samePins("112-127", "")).toBe(false);
    expect(samePins("112-127", "112-126")).toBe(false);
  });
});

describe("the subnet choice", () => {
  it("skips every /24 that overlaps a subnet in use and wraps around the pool", () => {
    expect(pickSubnet([], 7)).toBe("10.243.7.0/24");
    expect(pickSubnet(["10.243.7.0/24", "10.243.8.0/25"], 7)).toBe("10.243.9.0/24");
    expect(pickSubnet(["10.243.255.0/24"], 255)).toBe("10.243.0.0/24");
    expect(pickSubnet(["10.0.0.0/8"], 0)).toBeNull();
  });

  it("measures overlap on whole ranges", () => {
    expect(overlaps("10.243.0.0/16", "10.243.5.0/24")).toBe(true);
    expect(overlaps("10.243.5.128/25", "10.243.5.0/24")).toBe(true);
    expect(overlaps("10.243.4.0/24", "10.243.5.0/24")).toBe(false);
  });

  it("places the services and machines at fixed offsets of the world's /24", () => {
    const at = addresses("10.243.9.0/24");
    expect([at.tls, at.relay, at.account, at.machine(0), at.machine(3)]).toEqual(["10.243.9.10", "10.243.9.11", "10.243.9.12", "10.243.9.100", "10.243.9.103"]);
  });
});

describe("names", () => {
  it("prefixes every object with ovw- so no other run's names can clash", () => {
    expect(machineContainer("w1a2b3c", "m1")).toBe("ovw-w1a2b3c-m_m1");
    for (const bad of ["nc0_x", "-a", "A1", "a", "x".repeat(17), "svc-m2", "svc-x"]) expect(() => checkWorldName(bad)).toThrow(PlanError);
    expect(checkWorldName("svcm2")).toBe("svcm2");
  });

  it("never gives two worlds' objects one name", () => {
    expect(machineContainer("w", "m-m1")).not.toBe(machineContainer("w-m", "m1"));
    expect(machineContainer("w", "account")).not.toBe(objectName("w-m", "account"));
    // every world part and every machine of two dash-sharing worlds, all distinct
    const names = ["w", "w-m", "w-m-m"].flatMap((world) => [...["net", "account", "relay", "tls"].map((part) => objectName(world, part)), ...["m1", "m-m1", "account", "m-account", "net"].map((machine) => machineContainer(world, machine))]);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("the heavy-slot band rule", () => {
  it("takes the band the slot hands out, whatever the slot table, from inside a slot only", () => {
    // eight slots of 6 (today), six of 12 or 10, four of 16 (earlier), or any other table heavy-run.sh may get
    // ... and since 2026-11-15 12:2x, three whole cores with their sibling threads
    for (const band of ["56-67", "104-115", "116-127", "64-79", "112-127", "0-63", "0-126", "61-63,125-127", "40-42,104-106"]) expect(slotBand({ OVIS_HEAVY_SLOT: "1", OVIS_HEAVY_CPUS: band }, { online: "0-127", allowed: band })).toEqual({ band });
    expect(slotBand({}, HOST)).toHaveProperty("refused");
    expect(String((slotBand({}, HOST) as { refused: string }).refused)).toContain("heavy-run.sh [-t SECONDS] --");
    expect(slotBand({ OVIS_HEAVY_CPUS: "68-79" }, HOST)).toHaveProperty("refused");
    expect(slotBand({ OVIS_HEAVY_SLOT: "", OVIS_HEAVY_CPUS: "68-79" }, HOST)).toHaveProperty("refused");
  });

  it("reads a slot's set as a list: whole cores with their siblings, a single CPU, a plain range", () => {
    for (const band of ["55-57,119-121", "7", "64-79"]) {
      expect(wellFormedCpus(band)).toBe(true);
      expect(slotBand({ OVIS_HEAVY_SLOT: "3", OVIS_HEAVY_CPUS: band }, { online: "0-127", allowed: band })).toEqual({ band });
    }
    // the same CPUs written in another order are the same slot: the process's own list is the kernel's
    expect(slotBand({ OVIS_HEAVY_SLOT: "3", OVIS_HEAVY_CPUS: "119-121,55-57" }, { online: "0-127", allowed: "55-57,119-121" })).toEqual({ band: "119-121,55-57" });
    expect(cpuSet("55-57,119-121")).toEqual([55, 56, 57, 119, 120, 121]);
    expect(cpuList(cpuSet("55-57,119-121"))).toBe("55-57,119-121");
  });

  it("refuses a list out of this PC's range, empty, overlapping or garbage", () => {
    for (const cpus of ["55-57,119-128", "200", "", "55-57,56-58", "55,55", "55-57,,119", "55-57,", "a-b", "57-55"]) {
      expect(slotBand({ OVIS_HEAVY_SLOT: "3", OVIS_HEAVY_CPUS: cpus }, { online: "0-127", allowed: cpus })).toHaveProperty("refused");
    }
    expect(["55-57,56-58", "55,55", "", "x"].map(wellFormedCpus)).toEqual([false, false, false, false]);
  });

  it("refuses a set that is not CPUs online on this PC", () => {
    for (const cpus of ["79-68", "", "all", "120-131", "61-63,125-128", "61-63,"]) expect(slotBand({ OVIS_HEAVY_SLOT: "2", OVIS_HEAVY_CPUS: cpus }, { online: "0-127", allowed: cpus })).toHaveProperty("refused");
    expect(slotBand({ OVIS_HEAVY_SLOT: "2", OVIS_HEAVY_CPUS: "60-67" }, { online: "0-31,64-127", allowed: "60-67" })).toHaveProperty("refused");
    // outside a slot a process runs on every CPU: claiming all of them is no slot either
    expect(slotBand({ OVIS_HEAVY_SLOT: "1", OVIS_HEAVY_CPUS: "0-127" }, { online: "0-127", allowed: "0-127" })).toHaveProperty("refused");
  });

  it("refuses a set that is not this slot's: the one the process runs on", () => {
    for (const cpus of ["0-15", "56-67", "68-78", "69-79", "68-80", "0-127"]) expect(slotBand({ OVIS_HEAVY_SLOT: "2", OVIS_HEAVY_CPUS: cpus }, HOST)).toHaveProperty("refused");
    expect(slotBand(SLOT, { online: "0-127", allowed: "0-127" })).toHaveProperty("refused");
    expect(String((slotBand({ OVIS_HEAVY_SLOT: "2", OVIS_HEAVY_CPUS: "0-15" }, HOST) as { refused: string }).refused)).toContain("not this slot's set");
  });

  it("pins a world to the slot's band and refuses any other --cpus, or no slot at all", () => {
    expect(planFromArgs([], defaults).cpus).toBe("68-79");
    expect(planFromArgs(["--cpus", "68-79"], defaults).cpus).toBe("68-79");
    for (const other of ["116-127", "68-78", "68,69-79"]) expect(() => planFromArgs(["--cpus", other], defaults)).toThrow(PlanError);
    expect(() => planFromArgs([], { ...defaults, env: {} })).toThrow(PlanError);
    expect(() => planFromArgs(Array.from({ length: 9 }, (_, i) => ["--machine", `m${i}:herdr`]).flat(), { ...defaults, env: {} })).toThrow(PlanError);
    expect(planFromArgs(Array.from({ length: 9 }, (_, i) => ["--machine", `m${i}:herdr`]).flat(), defaults).machines).toHaveLength(9);
  });
});

describe("the true-form-desktop preset", () => {
  const MOUNTS = ["/art/ovis-0.4.22/checkout:/opt/ovis-0.4.22", "/art/ovis-0.5.1-update/mirror.git:/opt/od-mirror.git", "/art/ovis-0.5.1-update/bun-cache:/opt/od-bun-cache",
    "/art/ovis-0.5.1-update/pty-host-0.5.1:/opt/od-pty-host", "/art/bin:/opt/od-bin"];
  it("is the true form by default: one machine, its own herdr, 0.5.1 under 0.4.22's launcher, dead test sessions, 4g", () => {
    const plan = planFromArgs(["--preset", "od=true-form-desktop"], { ...defaults, standins: "/art" });
    const od = plan.machines[0]!;
    expect([od.name, od.engine, od.start, od.systemd, od.user, od.hostname, od.preset]).toEqual(["od", "herdr", "none", true, "ovisusr", "true-form-desktop", { kind: "true-form-desktop", version: "0.5.1", sessions: "dead", demo: false }]);
    expect(od.mounts).toEqual(MOUNTS);
    expect([plan.herdrBin, plan.memory]).toEqual(["/art/bin/herdr-0.9.5", "4g"]);
    expect(presetSteps(od.preset!)).toEqual(["units", "prepare", "herdr-default", "agents", "ovis", "settings-install", "update-wait", "leftover-update", "direct", "sessions", "sessions-dead", "core"]);
  });

  it("offers the 0.4.22-only and six-live variants and the demo, in any order", () => {
    const preset = (text: string) => planFromArgs(["--preset", text], { ...defaults, standins: "/art" }).machines[0]!;
    const only = preset("od=true-form-desktop:0.4.22");
    expect(only.preset).toEqual({ kind: "true-form-desktop", version: "0.4.22", sessions: "dead", demo: false });
    expect(only.mounts).toEqual(MOUNTS.filter((mount) => !/od-bun-cache|od-pty-host/.test(mount)));
    expect(presetSteps(only.preset!)).toEqual(["units", "prepare", "herdr-default", "agents", "ovis", "sessions", "sessions-dead", "core"]);
    expect(preset("od=true-form-desktop:demo:six-live").preset).toEqual({ kind: "true-form-desktop", version: "0.5.1", sessions: "live", demo: true });
    expect(preset("od=true-form-desktop:0.5.1").preset).toEqual(preset("od=true-form-desktop").preset);
    expect(presetSteps(preset("od=true-form-desktop:six-live:demo").preset!).slice(-3)).toEqual(["sessions", "core", "demo"]);
  });

  it("runs as a user of seven letters, ovisusr unless OVIS_STANDIN_USER names another of seven", () => {
    expect([STANDIN_USER, standinUser({}), standinUser({ OVIS_STANDIN_USER: "someone" })]).toEqual(["ovisusr", "ovisusr", "someone"]);
    for (const bad of ["short", "eightchr", "Ovisusr", "1visusr", "ovis-sr"]) expect(() => standinUser({ OVIS_STANDIN_USER: bad })).toThrow(PlanError);
    const od = planFromArgs(["--preset", "od=true-form-desktop"], { ...defaults, standins: "/art", env: { ...defaults.env, OVIS_STANDIN_USER: "someone" } }).machines[0]!;
    expect(od.user).toBe("someone");
  });

  it("takes the plugin id from the repository's own plugin manifest, and the staging host from the server", async () => {
    const manifest = await Bun.file(new URL("../../herdr-plugin.toml", import.meta.url)).text();
    expect(PLUGIN_ID).toBe(/^id = "([^"]+)"$/m.exec(manifest)?.[1] ?? "");
    expect(PLUGIN_ID).toMatch(/^[a-z0-9-]+\.[a-z0-9-]+$/);
    expect(`https://${HOSTS.staging}`).toBe(STAGING_ACCOUNT_SERVICE);
  });

  it("refuses an unknown or doubled form and a herdr of the caller's", () => {
    for (const bad of ["od=true-form-desktop:0.4.21", "od=true-form-desktop:0.4.22:0.5.1", "od=true-form-desktop:demo:demo", "od=new-desktop", "od"]) expect(() => planFromArgs(["--preset", bad], { ...defaults, standins: "/art" })).toThrow(PlanError);
    expect(() => planFromArgs(["--preset", "od=true-form-desktop", "--herdr-bin", "/x"], { ...defaults, standins: "/art" })).toThrow(PlanError);
  });
});

describe("the command line", () => {
  it("reads machines, options and defaults", () => {
    const plan = planFromArgs(["--machine", "m1:herdr", "--machine", "m2:core:engine", "--limits", "hosted"], defaults);
    expect(plan.name).toBe("w7fffff");
    expect(plan.machines).toEqual([{ name: "m1", engine: "herdr", start: "all" }, { name: "m2", engine: "core", start: "engine" }]);
    expect([plan.limits, plan.passes, plan.cpus, plan.account, plan.outbound, plan.ttlSeconds]).toEqual(["hosted", "off", "68-79", "fake", false, 3600]);
    expect(machineSpec("m3:herdr:bare").start).toBe("none");
    expect(machineSpec("m4:herdr:all:systemd")).toEqual({ name: "m4", engine: "herdr", start: "all", systemd: true });
    const mounted = planFromArgs(["--machine", "m1:herdr", "--machine", "m2:herdr", "--mount", "m1=/home/u/ovis:/opt/ovis-0.4.22"], defaults);
    expect(mounted.machines.map((machine) => machine.mounts ?? [])).toEqual([["/home/u/ovis:/opt/ovis-0.4.22"], []]);
    const od = planFromArgs(["--machine", "od:herdr:bare", "--user", "od=ovisusr", "--hostname", "od=true-form-desktop"], defaults).machines[0];
    expect([od?.user, od?.hostname]).toEqual(["ovisusr", "true-form-desktop"]);
  });

  it("refuses what cannot work", () => {
    const refused = (args: string[], hcBin: string | null = "/hc") => expect(() => planFromArgs(args, { ...defaults, hcBin })).toThrow(PlanError);
    refused(["--cpus", "0-15"]);
    refused(["--cpus", "112-127"]);
    refused(["--machine", "m1:docker"]);
    refused(["--machine", "m1:herdr", "--machine", "m1:core"]);
    refused(["--machine", "m1:core"], null);
    refused(["--account", "real"]);
    refused(["--account-repo", "/x"]);
    refused(["--ttl", "5"]);
    refused(["--limits", "closed"]);
    refused(["--machine", "m1:herdr:all:root"]);
    refused(["--machine", "m1:herdr", "--mount", "m9=/a:/b"]);
    refused(["--machine", "m1:herdr", "--user", "m1=Root"]);
    refused(["--machine", "m1:herdr", "--hostname", "m2=true-form-desktop"]);
    refused(["--machine", "m1:herdr", "--mount", "m1=relative:/b"]);
    expect(() => planFromArgs(["--bogus"], defaults)).toThrow();
  });
});

describe("the plan a world saves at its start", () => {
  it("comes back whole for add-machine: origins, passes, repo, CPU band and the rest", () => {
    const started = planFromArgs(["--machine", "m1:herdr", "--repo", "/checkout/under-test", "--passes", "grace", "--origin", "relay=wss://relay.example.test:8443",
      "--memory", "1g", "--trust-ca", "--limits", "hosted", "--hc-bin", "/opt/hc"], defaults);
    const loaded = savedPlan(JSON.stringify(started, null, 2));
    expect(loaded).toEqual(started);
    expect([loaded.repo, loaded.passes, loaded.origins.relay.url, loaded.cpus, loaded.memory, loaded.trustCa, loaded.hcBin]).toEqual(["/checkout/under-test", "grace", "wss://relay.example.test:8443", "68-79", "1g", true, "/opt/hc"]);
  });

  it("is checked again when read", () => {
    const started = planFromArgs([], defaults);
    for (const cpus of ["68-79,", "79-68", "all"]) expect(() => savedPlan(JSON.stringify({ ...started, cpus }))).toThrow(PlanError);
    expect(savedPlan(JSON.stringify({ ...started, cpus: "61-63,125-127" })).cpus).toBe("61-63,125-127");
    expect(() => savedPlan(JSON.stringify({ ...started, name: "Bad" }))).toThrow(PlanError);
  });

  it("keeps a world on its band: add-machine from a slot of another band is refused", () => {
    expect([bandRefusal("68-79", "68-79"), bandRefusal("61-63,125-127", "125-127,61-63")]).toEqual([null, null]);
    for (const other of ["61-63,125-126", "61-63", "58-60,122-124"]) expect(bandRefusal(other, "61-63,125-127")).toContain("pinned to 61-63,125-127");
    for (const other of ["80-91", "68-78", "0-127"]) expect(bandRefusal(other, "68-79")).toContain("pinned to 68-79");
  });
});

describe("the slot's deadline", () => {
  it("is heavy-run.sh's OVIS_HEAVY_DEADLINE, and a world refuses to start without it", () => {
    expect(slotDeadline({ ...SLOT, OVIS_HEAVY_DEADLINE: "2000000060" }, 2_000_000_000)).toBe(2_000_000_060);
    for (const bad of [undefined, "", "soon", "1.5e9"]) expect(() => slotDeadline({ ...SLOT, OVIS_HEAVY_DEADLINE: bad }, 2_000_000_000)).toThrow(PlanError);
    expect(() => slotDeadline({ ...SLOT, OVIS_HEAVY_DEADLINE: "1999999999" }, 2_000_000_000)).toThrow(PlanError);
  });
});

describe("a docker call in flight is a world's", () => {
  const names = new Set(["ovw-w1-net", "ovw-w1-tls", "ovw-w1-m_m1"]);
  const of = (line: string, owner: string | null = "11:22") => dockerCallOf(line, "w1", owner, names);

  it("when it carries the world's (and its owner's) label, or names one of its objects exactly", () => {
    expect(of("101 docker network create --internal --subnet 10.243.7.0/24 --label ovis.world=w1 --label ovis.world.owner=11:22 ovw-w1-net")).toBe(true);
    expect(of("102 /bin/sh /tmp/shim/docker run -d --init --name ovw-w1-account --label ovis.world=w1 --label ovis.world.owner=11:22 herdr-ci-runner:local")).toBe(true);
    expect(of("103 docker rm -f -v ovw-w1-m_m1 ovw-w1-tls")).toBe(true);
    expect(of("104 docker logs -f ovw-w1-tls", null)).toBe(true);
  });

  it("never for a world whose name only starts the same, another owner, or a command that names nothing of it", () => {
    expect(of("201 docker network create --internal --label ovis.world=w1-m --label ovis.world.owner=11:22 ovw-w1-m-net")).toBe(false);
    expect(of("202 docker logs -f ovw-w1-m-tls")).toBe(false);
    expect(of("203 docker run -d --name ovw-w1-account --label ovis.world=w1 --label ovis.world.owner=99:1 img")).toBe(false);
    expect(of("204 docker events --filter label=ovis.world=w1")).toBe(false);
    expect(of("205 docker ps -a --filter label=ovis.world=w1 --format {{.Names}}")).toBe(false);
  });
});
