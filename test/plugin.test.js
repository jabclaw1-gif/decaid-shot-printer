"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const FILE = path.join(__dirname, "..", "plugin.js");
const DAY_MS = 86400e3;
const SECOND_MS = 1000;

function makeShot({ id = "shot-1", timestamp = new Date().toISOString(), seconds = 30, title = "Test profile" } = {}) {
  const start = Date.now();
  const measurements = Array.from({ length: seconds * 4 + 1 }, (_, i) => ({
    machine: {
      timestamp: new Date(start + (i * SECOND_MS) / 4).toISOString(),
      state: { state: "espresso", substate: "pouring" },
      pressure: 9,
      flow: 2,
      targetPressure: 9,
      targetFlow: 2,
    },
    scale: { weight: i * 0.3 },
  }));
  return { id, timestamp, measurements, workflow: { profile: { title } } };
}

function load({ shot = makeShot(), settings = { PrinterHost: "192.0.2.10" }, openError } = {}) {
  const jobs = [];
  const host = {
    log() {},
    transport: {
      open: async () => {
        if (openError) throw new Error(openError);
        return { handle: 1 };
      },
      onEvent() {},
      send: async (_, message) => jobs.push(Buffer.from(message.data, "base64")),
      close: async () => {},
    },
  };
  const fetch = async (url) => ({
    ok: true,
    json: async () => (url.includes("/shots?") ? { items: [shot] } : shot),
  });
  const context = vm.createContext({ fetch, host, clearTimeout, setTimeout: (fn) => setTimeout(fn, 0) });
  vm.runInContext(`${fs.readFileSync(FILE, "utf8")}\ncreatePlugin;`, context, { filename: FILE });
  const plugin = vm.runInContext("createPlugin(host)", context);
  plugin.onLoad(settings);

  const request = async (endpoint, query = {}) => {
    const response = await plugin.handleHttpRequest({ endpoint, query });
    // Decaid passes the body straight to shelf, which rejects objects.
    assert.equal(typeof response.body, "string", "response body must be a string");
    return response;
  };
  const store = async () => {
    plugin.onEvent({ name: "shotStored", payload: { id: shot.id } });
    await new Promise((resolve) => setTimeout(resolve, 40));
  };
  return { jobs, request, store };
}

test("status returns a JSON string", async () => {
  const { request } = load();
  assert.equal(JSON.parse((await request("status")).body).paper, "80mm");
});

test("print button response is a JSON string", async () => {
  const { request, jobs } = load();
  assert.equal(JSON.parse((await request("print", { format: "json" })).body).ok, true);
  assert.equal(jobs.length, 1);
});

test("failed print reports the error as a JSON string", async () => {
  const { request } = load({ openError: "unreachable" });
  const response = await request("print", { format: "json" });
  assert.equal(response.status, 502);
  assert.equal(JSON.parse(response.body).error, "unreachable");
});

test("unknown endpoint returns a JSON string", async () => {
  const { request } = load();
  assert.equal((await request("missing")).status, 404);
});

test("preview does not let a shot id close the script tag", async () => {
  const { request } = load({ shot: makeShot({ id: "</script><img src=x onerror=alert(1)>" }) });
  assert.ok(!(await request("preview")).body.includes("</script><img"));
});

test("preview escapes the profile title", async () => {
  const { request } = load({ shot: makeShot({ title: "<img src=x>" }) });
  assert.ok(!(await request("preview")).body.includes("<img src=x>"));
});

test("print page is HTML", async () => {
  const { request } = load();
  assert.match((await request("print")).body, /Sent to printer/);
});

test("fresh shot auto-prints", async () => {
  const { store, jobs } = load();
  await store();
  assert.equal(jobs.length, 1);
});

test("imported old shot does not auto-print", async () => {
  const { store, jobs } = load({ shot: makeShot({ timestamp: new Date(Date.now() - DAY_MS).toISOString() }) });
  await store();
  assert.equal(jobs.length, 0);
});

test("short shot does not auto-print", async () => {
  const { store, jobs } = load({ shot: makeShot({ seconds: 4 }) });
  await store();
  assert.equal(jobs.length, 0);
});

test("old shot still prints manually", async () => {
  const { request, jobs } = load({ shot: makeShot({ timestamp: "2026-01-01T00:00:00Z" }) });
  await request("print");
  assert.equal(jobs.length, 1);
});

test("shot text cannot inject printer commands", async () => {
  const { request, jobs } = load({ shot: makeShot({ title: "A\u001bp\u0000B" }) });
  await request("print");
  assert.ok(jobs[0].includes("A?p?B"));
});

test("58 mm paper with header, footer and targets prints", async () => {
  const { request, jobs } = load({
    settings: { PrinterHost: "192.0.2.10", PaperWidth: "58mm", HeaderText: "Cafe", FooterText: "Thanks", ShowTargets: true },
  });
  await request("print");
  assert.ok(jobs[0].includes("Thanks"));
});

for (const [name, timestamp] of [
  ["missing", null],
  ["invalid", "not a date"],
  ["future", new Date(Date.now() + DAY_MS).toISOString()],
]) {
  test(`shot with ${name} timestamp does not auto-print`, async () => {
    const { store, jobs } = load({ shot: makeShot({ timestamp }) });
    await store();
    assert.equal(jobs.length, 0);
  });
}

test("old shot is skipped before it is rendered", async () => {
  const shot = { ...makeShot({ timestamp: "2026-01-01T00:00:00Z" }), measurements: [] };
  const { store, request } = load({ shot });
  await store();
  assert.equal(JSON.parse((await request("status")).body).lastResult.reason, "old");
});

function withMachine(shot, change) {
  const measurements = shot.measurements.map((m, i) => ({ ...m, machine: { ...m.machine, ...change(i) } }));
  return { ...shot, measurements };
}

for (const field of ["pressure", "flow", "targetPressure", "targetFlow"]) {
  // 1e6 is enough to show the unbounded axis without hanging the test run.
  test(`absurd ${field} is clamped`, async () => {
    const settings = { PrinterHost: "192.0.2.10", ShowTargets: true };
    const normal = load({ settings, shot: withMachine(makeShot(), () => ({ [field]: 25 })) });
    const absurd = load({ settings, shot: withMachine(makeShot(), () => ({ [field]: 1e6 })) });
    await normal.request("print");
    await absurd.request("print");
    const graph = (job) => job.subarray(job.indexOf(Buffer.from([0x1d, 0x76, 0x30])));
    assert.ok(graph(normal.jobs[0]).equals(graph(absurd.jobs[0])));
  });
}

test("absurd duration is rejected", async () => {
  const start = Date.now();
  const shot = withMachine(makeShot(), (i) => ({ timestamp: new Date(start + i * 60e3).toISOString() }));
  assert.equal((await load({ shot }).request("print")).status, 502);
});

test("too many samples are rejected", async () => {
  const base = makeShot();
  const shot = { ...base, measurements: Array(20001).fill(base.measurements[0]) };
  assert.equal((await load({ shot }).request("print")).status, 502);
});
