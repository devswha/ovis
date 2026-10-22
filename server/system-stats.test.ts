import { describe, expect, it } from "bun:test";
import { cpuPercent, cpuTimesOf, createSystemSampler, diskOf, handleSystemRequest, parseMeminfo, STALE_MS, type SystemIo } from "./system-stats.ts";

const MEMINFO = `MemTotal:       16384000 kB
MemFree:         1000000 kB
MemAvailable:    8192000 kB
Buffers:          500000 kB
`;

describe("system readings", () => {
  it("reads memory as total minus MemAvailable, so the file cache is not used memory", () => {
    expect(parseMeminfo(MEMINFO)).toEqual({ total: 16384000 * 1024, used: 8192000 * 1024 });
    expect(parseMeminfo("MemTotal: 100 kB\n")).toBeNull();
    expect(parseMeminfo("")).toBeNull();
  });

  it("measures CPU as the change between two readings", () => {
    const core = (user: number, idle: number) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } });
    const before = cpuTimesOf([core(100, 900), core(100, 900)]);
    const after = cpuTimesOf([core(150, 950), core(200, 900)]);
    expect(cpuPercent(before, after)).toBe(75);
    expect(cpuPercent(before, before)).toBeNull();
  });

  it("reports a disk as df does and leaves out one too small to fill up", () => {
    const gib = 1024 ** 3;
    // 100 GiB filesystem, 5 GiB reserved for root: Use% is used over used plus what a user can still fill
    const disk = diskOf("/", { bsize: 4096, blocks: (100 * gib) / 4096, bfree: (35 * gib) / 4096, bavail: (30 * gib) / 4096 });
    expect(disk).toEqual({ path: "/", used: 65 * gib, total: 95 * gib, percent: 68.4 });
    expect(diskOf("/boot", { bsize: 4096, blocks: 1000, bfree: 10, bavail: 10 })).toBeNull();
  });
});

function fakeIo(over: Partial<SystemIo> = {}) {
  let clock = 1_000_000;
  let busy = 0;
  let total = 0;
  const calls = { cpu: 0 };
  const io: SystemIo = {
    platform: "linux",
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    cpuTimes: () => { calls.cpu += 1; busy += 25; total += 100; return { busy, total }; },
    cpuCount: () => 4,
    uptime: () => 3600.4,
    loadavg: () => [0.5, 0.25, 0.125],
    memory: async () => ({ total: 1000, used: 250 }),
    disks: async () => [],
    ...over,
  };
  return { io, calls, advance: (ms: number) => { clock += ms; } };
}

describe("the sampler", () => {
  it("waits a moment on its first reading so CPU has something to compare", async () => {
    const { io } = fakeIo();
    const report = await createSystemSampler(io).read();
    expect(report.cpu_percent).toBe(25);
    expect(report.memory).toEqual({ used: 250, total: 1000, percent: 25 });
    expect(report.load).toEqual([0.5, 0.25, 0.13]);
    expect(report.uptime_s).toBe(3600);
    expect(report.cpu_count).toBe(4);
  });

  it("answers asks closer than the fresh window from one reading", async () => {
    const { io, calls, advance } = fakeIo();
    const sampler = createSystemSampler(io);
    const first = await sampler.read();
    const used = calls.cpu;
    advance(500);
    expect(await sampler.read()).toBe(first);
    expect(calls.cpu).toBe(used);
    advance(2000);
    expect((await sampler.read()).sampled_at).toBeGreaterThan(first.sampled_at);
  });

  it("shares one reading between asks that arrive together", async () => {
    const { io, calls } = fakeIo();
    const sampler = createSystemSampler(io);
    const [a, b] = await Promise.all([sampler.read(), sampler.read()]);
    expect(a).toBe(b);
    expect(calls.cpu).toBe(2);
  });

  it("says null for what a PC cannot measure, never zero", async () => {
    const { io } = fakeIo({ platform: "win32", memory: async () => null });
    const report = await createSystemSampler(io).read();
    expect(report.platform).toBe("win32");
    expect(report.load).toBeNull();
    expect(report.memory).toBeNull();
  });

  it("starts a fresh comparison after a quiet spell instead of averaging the whole spell", async () => {
    const { io, calls, advance } = fakeIo();
    const sampler = createSystemSampler(io);
    await sampler.read();
    advance(STALE_MS + 1);
    const before = calls.cpu;
    await sampler.read();
    // the first reading takes two CPU samples (baseline, then the window); a stale one does the same
    expect(calls.cpu - before).toBe(2);
    advance(5000);
    const steady = calls.cpu;
    await sampler.read();
    expect(calls.cpu - steady).toBe(1);
  });

  it("starts a fresh comparison when cores come or go", async () => {
    let cores = 4;
    const { io, calls, advance } = fakeIo({ cpuCount: () => cores });
    const sampler = createSystemSampler(io);
    await sampler.read();
    cores = 5;
    advance(5000);
    const before = calls.cpu;
    expect((await sampler.read()).cpu_count).toBe(5);
    expect(calls.cpu - before).toBe(2);
  });

  it("leaves a disk that does not answer out, answers anyway, and does not ask it again meanwhile", async () => {
    let asked = 0;
    const never = new Promise<never>(() => {});
    const { io, advance } = fakeIo({ disks: () => { asked += 1; return never; } });
    const sampler = createSystemSampler(io, { diskCapMs: 20 });
    const first = await sampler.read();
    expect(first.disks).toEqual([]);
    expect(first.memory).not.toBeNull();
    advance(5000);
    const second = await sampler.read();
    expect(second.disks).toEqual([]);
    // one read is still pending, so no second thread was spent on the stuck mount
    expect(asked).toBe(1);
  });

  it("keeps the last disks while one read is late, and takes the new answer when it arrives", async () => {
    const disk = { path: "/", used: 5, total: 10, percent: 50 };
    let release: (list: typeof disk[]) => void = () => {};
    let call = 0;
    const { io, advance } = fakeIo({ disks: () => { call += 1; return call === 1 ? Promise.resolve([disk]) : new Promise((done) => { release = done; }); } });
    const sampler = createSystemSampler(io, { diskCapMs: 20 });
    expect((await sampler.read()).disks).toEqual([disk]);
    advance(5000);
    expect((await sampler.read()).disks).toEqual([disk]);
    release([{ ...disk, percent: 60 }]);
    await Bun.sleep(5); // fixed wait: lets the released read settle before the next ask
    advance(5000);
    expect((await sampler.read()).disks[0]?.percent).toBe(60);
  });

  it("serves GET as JSON that is never cached, and refuses writes", async () => {
    const sampler = createSystemSampler(fakeIo().io);
    const ok = await handleSystemRequest(new Request("http://x/api/system"), sampler);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect((await ok.json() as { cpu_count: number }).cpu_count).toBe(4);
    expect((await handleSystemRequest(new Request("http://x/api/system", { method: "POST" }), sampler)).status).toBe(405);
  });
});
