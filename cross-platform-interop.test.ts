import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as createHttpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { INTEROP_MAX_PAYLOAD_BYTES, INTEROP_REQUEST_TIMEOUT_MS } from "./cross-platform-benchmark/cross-platform-interop.ts";

const scriptsRoot = resolve(fileURLToPath(import.meta.url), "..");
const repositoryRoot = resolve(scriptsRoot, "..");
const tsxCli = resolve(repositoryRoot, "scripts/node_modules/tsx/dist/cli.mjs");
const probeScript = resolve(scriptsRoot, "cross-platform-benchmark/cross-platform-interop.ts");
const verifier = resolve(scriptsRoot, "cross-platform-benchmark/verify-interop-packets.mjs");
const windowsVerifier = resolve(scriptsRoot, "cross-platform-benchmark/verify-windows-to-windows-packet.mjs");
const sharedKey = "repository-interoperability-test-key";

function waitForReady(child: ChildProcess): Promise<number> {
  return new Promise((resolveReady, reject) => {
    let output = "";
    let errorOutput = "";
    const timer = setTimeout(() => reject(new Error(`interop server did not become ready; output: ${output}`)), 5_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = output.match(/INTEROP_READY (\d+) /);
      if (match) {
        clearTimeout(timer);
        resolveReady(Number(match[1]));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errorOutput += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`interop server exited before ready with ${code}; output: ${output}\n${errorOutput}`));
      }
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

async function runDirection(
  direction: "linux-to-windows" | "windows-to-linux" | "windows-to-windows",
  directory: string,
): Promise<string> {
  const target = direction === "windows-to-linux" ? "linux" : "windows";
  const source = direction === "linux-to-windows" ? "linux" : "windows";
  const server = spawn(process.execPath, [
    tsxCli,
    probeScript,
    "--mode", "server",
    "--direction", direction,
    "--platform", target,
    "--allow-platform-override",
    // Keep the loopback fixture stable when this release-path test runs beside
    // the heavier benchmark suites. Native-host commands retain the probe's
    // 250 ms default unless they opt into a different bounded timeout.
    "--timeout-ms", "1000",
    "--bind-host", "127.0.0.1",
    "--port", "0",
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, IT_INTEROP_SHARED_KEY: sharedKey },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const port = await waitForReady(server);
    const packet = join(directory, `${direction}.json`);
    const client = spawn(process.execPath, [
      tsxCli,
      probeScript,
      "--mode", "client",
      "--direction", direction,
      "--platform", source,
      "--allow-platform-override",
      "--timeout-ms", "1000",
      "--endpoint", `http://127.0.0.1:${port}`,
      "--output", packet,
    ], {
      cwd: repositoryRoot,
      env: { ...process.env, IT_INTEROP_SHARED_KEY: sharedKey },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const clientOutput: Buffer[] = [];
    client.stdout?.on("data", (chunk: Buffer) => clientOutput.push(chunk));
    const clientError: Buffer[] = [];
    client.stderr?.on("data", (chunk: Buffer) => clientError.push(chunk));
    const clientExit = await new Promise<number>((resolveExit, reject) => {
      client.once("error", reject);
      client.once("exit", (code) => resolveExit(code ?? 1));
    });
    assert.equal(
      clientExit,
      0,
      `${direction} client failed:\n${Buffer.concat(clientOutput).toString()}\n${Buffer.concat(clientError).toString()}`,
    );
    const record = JSON.parse(readFileSync(packet, "utf8")) as {
      status: string;
      direction: string;
      source: { hostname: string };
      target: { hostname: string };
      provenance: { kind: string; platformOverride: boolean };
      probes: Array<{ name: string; attempts?: number; recoveryObserved?: boolean }>;
    };
    assert.equal(record.status, "passed");
    assert.equal(record.direction, direction);
    assert.ok(record.source.hostname.length > 0);
    assert.ok(record.target.hostname.length > 0);
    assert.equal(record.provenance.kind, "fixture-platform-override");
    assert.equal(record.provenance.platformOverride, true);
    assert.deepEqual(
      record.probes
        .filter((probe) => probe.name === "retry" || probe.name === "timeout")
        .map((probe) => [probe.attempts, probe.recoveryObserved]),
      [[2, true], [2, true]],
    );
    return packet;
  } finally {
    await stop(server);
  }
}

async function verifyWindowsPacket(packetPath: string): Promise<{ exitCode: number; stderr: string }> {
  const child = spawn(process.execPath, [windowsVerifier, packetPath], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  return { exitCode, stderr: Buffer.concat(stderr).toString("utf8") };
}

test("the real interop probe proves both reciprocal directions and verifies the combined packet", async () => {
  const directory = mkdtempSync(join(tmpdir(), "it-cross-platform-interop-"));
  try {
    const linuxToWindows = await runDirection("linux-to-windows", directory);
    const windowsToLinux = await runDirection("windows-to-linux", directory);
    const combined = join(directory, "combined.json");
    const verified = spawn(process.execPath, [verifier, linuxToWindows, windowsToLinux, "--output", combined], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    verified.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const exitCode = await new Promise<number>((resolveExit, reject) => {
      verified.once("error", reject);
      verified.once("exit", (code) => resolveExit(code ?? 1));
    });
    assert.equal(exitCode, 0, Buffer.concat(stderr).toString());
    const packet = JSON.parse(readFileSync(combined, "utf8")) as {
      status: string;
      directions: Array<{ direction: string }>;
      provenance: { platformOverride: boolean };
      productionClaimsEnabled: boolean;
    };
    assert.equal(packet.status, "passed");
    assert.equal(packet.provenance.platformOverride, true);
    assert.equal(packet.productionClaimsEnabled, false);
    assert.deepEqual(packet.directions.map((item) => item.direction).sort(), [
      "linux-to-windows",
      "windows-to-linux",
    ]);
    const namedOutput = join(directory, "named-flags.json");
    const namedRejected = spawn(process.execPath, [
      verifier,
      "--linux-to-windows", linuxToWindows,
      "--windows-to-linux", windowsToLinux,
      "--require-named-hosts",
      "--output", namedOutput,
    ], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const namedExitCode = await new Promise<number>((resolveExit, reject) => {
      namedRejected.once("error", reject);
      namedRejected.once("exit", (code) => resolveExit(code ?? 1));
    });
    assert.notEqual(namedExitCode, 0, "platform-overridden packets must remain rejected by named handoff flags");
    assert.equal(readFileSync(combined, "utf8").includes('"linux-to-windows"'), true);
    // Workspace Lab extracts this bounded packet from the allowlisted runner
    // output and stores it separately from the human-readable test log.
    process.stdout.write(
      `INTEROP_RESULT_JSON_BASE64 ${Buffer.from(readFileSync(combined, "utf8"), "utf8").toString("base64")}\n`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows-to-Windows listener rejects declared and chunked oversized requests without retaining task data", async () => {
  const directory = mkdtempSync(join(tmpdir(), "it-windows-to-windows-interop-"));
  try {
    const generatedPacket = await runDirection("windows-to-windows", directory);
    const serializedPacket = readFileSync(generatedPacket, "utf8");
    const packet = JSON.parse(serializedPacket) as {
      packetVersion: string;
      probes: Array<Record<string, unknown> & { name: string }>;
      source: { hostname: string; platform: string };
      target: { hostname: string; platform: string };
      provenance: { kind: string; platformOverride: boolean };
    };
    assert.equal(packet.packetVersion, "it/windows-to-windows-interop/6");
    assert.deepEqual(
      packet.probes.map((probe) => probe.name).sort(),
      [
        "chunked-max-payload",
        "chunked-oversized-above-boundary",
        "chunked-oversized-below-boundary",
        "chunked-oversized-crosses-boundary",
        "invalid-authentication",
        "max-payload",
        "oversized-payload",
        "replayed-nonce",
        "retry",
        "timeout",
      ],
    );
    assert.deepEqual(packet.probes.find((probe) => probe.name === "invalid-authentication"), {
      name: "invalid-authentication",
      status: "passed",
      statusCode: 401,
      outcome: "rejected-before-context",
      contextProcessed: false,
    });
    assert.deepEqual(packet.probes.find((probe) => probe.name === "replayed-nonce"), {
      name: "replayed-nonce",
      status: "passed",
      firstStatusCode: 200,
      statusCode: 409,
      outcome: "rejected-before-context",
      contextProcessed: false,
    });
    assert.deepEqual(packet.probes.find((probe) => probe.name === "oversized-payload"), {
      name: "oversized-payload",
      status: "passed",
      statusCode: 413,
      payloadBytes: 65_537,
      outcome: "rejected-before-context",
      contextProcessed: false,
    });
    assert.deepEqual(packet.probes.find((probe) => probe.name === "chunked-oversized-below-boundary"), {
      name: "chunked-oversized-below-boundary",
      status: "passed",
      statusCode: 413,
      payloadBytes: 65_537,
      transferEncoding: "chunked",
      retainedBodyBytes: 0,
      outcome: "rejected-before-context",
      contextProcessed: false,
    });
    assert.deepEqual(packet.probes.find((probe) => probe.name === "chunked-oversized-crosses-boundary"), {
      name: "chunked-oversized-crosses-boundary",
      status: "passed",
      statusCode: 413,
      payloadBytes: 65_537,
      transferEncoding: "chunked",
      retainedBodyBytes: 0,
      outcome: "rejected-before-context",
      contextProcessed: false,
    });
    assert.deepEqual(packet.probes.find((probe) => probe.name === "chunked-oversized-above-boundary"), {
      name: "chunked-oversized-above-boundary",
      status: "passed",
      statusCode: 413,
      payloadBytes: 65_538,
      transferEncoding: "chunked",
      retainedBodyBytes: 0,
      outcome: "rejected-before-context",
      contextProcessed: false,
    });
    assert.deepEqual(packet.probes.find((probe) => probe.name === "chunked-max-payload"), {
      name: "chunked-max-payload",
      status: "passed",
      statusCode: 200,
      payloadBytes: 65_536,
      transferEncoding: "chunked",
      outcome: "accepted-after-context",
      contextProcessed: true,
    });
    assert.deepEqual(packet.probes.find((probe) => probe.name === "max-payload"), {
      name: "max-payload",
      status: "passed",
      statusCode: 200,
      payloadBytes: 65_536,
      outcome: "accepted-after-context",
      contextProcessed: true,
    });
    assert.equal(serializedPacket.includes(sharedKey), false);
    assert.equal(serializedPacket.includes('"context":'), false);
    assert.equal(serializedPacket.includes("boundaryPadding"), false);
    assert.equal(serializedPacket.includes("cross-platform-windows-to-windows-security-rejection"), false);

    // The protocol test uses a Linux fixture, so convert its host labels only
    // for isolated verifier-shape checks; it is not native Windows evidence.
    packet.source.hostname = "WINDOWS-CLIENT-FIXTURE";
    packet.target.hostname = "WINDOWS-HOST-FIXTURE";
    packet.provenance = { kind: "named-host", platformOverride: false };
    const verifierFixture = join(directory, "named-windows-to-windows-fixture.json");
    writeFileSync(verifierFixture, JSON.stringify(packet));
    const validVerification = await verifyWindowsPacket(verifierFixture);
    assert.equal(validVerification.exitCode, 0, validVerification.stderr);

    const missingProbePacket = JSON.parse(JSON.stringify(packet));
    missingProbePacket.probes = missingProbePacket.probes.filter(
      (probe: { name: string }) => probe.name !== "max-payload",
    );
    const missingProbePath = join(directory, "missing-payload-boundary-probe.json");
    writeFileSync(missingProbePath, JSON.stringify(missingProbePacket));
    assert.notEqual((await verifyWindowsPacket(missingProbePath)).exitCode, 0);

    const unexpectedOutcomePacket = JSON.parse(JSON.stringify(packet));
    unexpectedOutcomePacket.probes.find(
      (probe: { name: string }) => probe.name === "oversized-payload",
    ).statusCode = 200;
    const unexpectedOutcomePath = join(directory, "unexpected-security-outcome.json");
    writeFileSync(unexpectedOutcomePath, JSON.stringify(unexpectedOutcomePacket));
    assert.notEqual((await verifyWindowsPacket(unexpectedOutcomePath)).exitCode, 0);

    const oversizedRetainedPacket = JSON.parse(JSON.stringify(packet));
    oversizedRetainedPacket.probes.find(
      (probe: { name: string }) => probe.name === "chunked-oversized-crosses-boundary",
    ).retainedBodyBytes = 65_537;
    const oversizedRetainedPath = join(directory, "oversized-retained-body.json");
    writeFileSync(oversizedRetainedPath, JSON.stringify(oversizedRetainedPacket));
    assert.notEqual((await verifyWindowsPacket(oversizedRetainedPath)).exitCode, 0);

    const incorrectBoundaryPacket = JSON.parse(JSON.stringify(packet));
    incorrectBoundaryPacket.probes.find(
      (probe: { name: string }) => probe.name === "max-payload",
    ).payloadBytes = 65_535;
    const incorrectBoundaryPath = join(directory, "incorrect-payload-boundary.json");
    writeFileSync(incorrectBoundaryPath, JSON.stringify(incorrectBoundaryPacket));
    assert.notEqual((await verifyWindowsPacket(incorrectBoundaryPath)).exitCode, 0);

    const incorrectChunkedBoundaryPacket = JSON.parse(JSON.stringify(packet));
    incorrectChunkedBoundaryPacket.probes.find(
      (probe: { name: string }) => probe.name === "chunked-max-payload",
    ).payloadBytes = 65_535;
    const incorrectChunkedBoundaryPath = join(directory, "incorrect-chunked-payload-boundary.json");
    writeFileSync(incorrectChunkedBoundaryPath, JSON.stringify(incorrectChunkedBoundaryPacket));
    assert.notEqual((await verifyWindowsPacket(incorrectChunkedBoundaryPath)).exitCode, 0);

    const unsafePacket = JSON.parse(JSON.stringify(packet));
    unsafePacket.sharedKey = sharedKey;
    const unsafePacketPath = join(directory, "unsafe-security-packet.json");
    writeFileSync(unsafePacketPath, JSON.stringify(unsafePacket));
    assert.notEqual((await verifyWindowsPacket(unsafePacketPath)).exitCode, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("listener closes an unfinished under-limit chunked upload at its request deadline", async () => {
  const server = spawn(process.execPath, [
    tsxCli,
    probeScript,
    "--mode", "server",
    "--direction", "windows-to-windows",
    "--platform", "windows",
    "--allow-platform-override",
    "--bind-host", "127.0.0.1",
    "--port", "0",
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, IT_INTEROP_SHARED_KEY: sharedKey },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const port = await waitForReady(server);
    const partialBody = Buffer.from('{"context":{"input":{"marker":"incomplete"}}', "utf8");
    assert.ok(partialBody.byteLength < INTEROP_MAX_PAYLOAD_BYTES);

    const result = await new Promise<{
      statusCode: number;
      senderFinished: boolean;
      socketClosed: boolean;
      responseDelayMs: number;
      continuedBytes: number;
    }>((resolve, reject) => {
      const startedAt = Date.now();
      const request = createHttpRequest({
        hostname: "127.0.0.1",
        port,
        method: "POST",
        path: "/execute",
        headers: {
          "content-type": "application/octet-stream",
          "transfer-encoding": "chunked",
        },
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let responseReceived = false;
      let responseEnded = false;
      let senderFinished = false;
      let socketClosed = false;
      let settled = false;
      let statusCode = 0;
      let continuedBytes = 0;
      let continuationTimer: ReturnType<typeof setInterval> | undefined;

      const finishIfComplete = () => {
        if (settled || !responseEnded || !socketClosed) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (continuationTimer) clearInterval(continuationTimer);
        resolve({
          statusCode,
          senderFinished,
          socketClosed,
          responseDelayMs: Date.now() - startedAt,
          continuedBytes,
        });
      };

      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (continuationTimer) clearInterval(continuationTimer);
        request.destroy();
        reject(new Error("listener waited too long to close the unfinished under-limit upload"));
      }, INTEROP_REQUEST_TIMEOUT_MS + 3_000);

      request.once("finish", () => {
        senderFinished = true;
      });
      request.once("socket", (socket) => {
        socket.once("close", () => {
          socketClosed = true;
          if (continuationTimer) clearInterval(continuationTimer);
          finishIfComplete();
        });
      });
      request.once("response", (response) => {
        responseReceived = true;
        statusCode = response.statusCode ?? 0;
        response.resume();
        response.once("end", () => {
          responseEnded = true;
          finishIfComplete();
        });
      });
      request.once("error", (error) => {
        if (settled || responseReceived) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (continuationTimer) clearInterval(continuationTimer);
        reject(error);
      });

      // Keep adding small chunks below the body-size limit, but never finish
      // the request. Incoming bytes must not reset the absolute deadline.
      request.write(partialBody);
      continuationTimer = setInterval(() => {
        if (request.destroyed) {
          if (continuationTimer) clearInterval(continuationTimer);
          return;
        }
        request.write(" ");
        continuedBytes += 1;
      }, 250);
    });

    assert.equal(result.statusCode, 408);
    assert.equal(result.socketClosed, true);
    assert.equal(result.senderFinished, false);
    assert.ok(result.continuedBytes >= 2, "the sender should keep dripping bytes before the deadline");
    assert.ok(
      result.responseDelayMs >= INTEROP_REQUEST_TIMEOUT_MS - 500,
      "the listener should wait for the configured whole-request deadline",
    );
    assert.ok(
      result.responseDelayMs < INTEROP_REQUEST_TIMEOUT_MS + 3_000,
      "the listener should close within the explicit bounded interval",
    );

    const status = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const statusRequest = createHttpRequest({
        hostname: "127.0.0.1",
        port,
        method: "GET",
        path: "/status",
        agent: false,
        headers: { "x-it-interop-key": sharedKey },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      });
      statusRequest.once("error", reject);
      statusRequest.end();
    });
    assert.equal(status.statusCode, 200);
    assert.equal((JSON.parse(status.body) as { requestsAccepted: number }).requestsAccepted, 0);
  } finally {
    await stop(server);
  }
});

test("real named-host reciprocal packets pass the strict promotion verifier", {
  skip: process.env.IT_REAL_CROSS_HOST_INTEROP !== "1",
}, async () => {
  const linuxToWindows = process.env.IT_REAL_LINUX_TO_WINDOWS_PACKET;
  const windowsToLinux = process.env.IT_REAL_WINDOWS_TO_LINUX_PACKET;
  if (!linuxToWindows || !windowsToLinux) {
    throw new Error(
      "IT_REAL_LINUX_TO_WINDOWS_PACKET and IT_REAL_WINDOWS_TO_LINUX_PACKET are required when IT_REAL_CROSS_HOST_INTEROP=1.",
    );
  }
  const directory = mkdtempSync(join(tmpdir(), "it-real-cross-host-interop-"));
  try {
    const combined = join(directory, "combined.json");
    const verified = spawn(process.execPath, [
      verifier,
      "--linux-to-windows", linuxToWindows,
      "--windows-to-linux", windowsToLinux,
      "--require-named-hosts",
      "--output",
      combined,
    ], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    verified.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const exitCode = await new Promise<number>((resolveExit, reject) => {
      verified.once("error", reject);
      verified.once("exit", (code) => resolveExit(code ?? 1));
    });
    assert.equal(exitCode, 0, Buffer.concat(stderr).toString());
    const packet = JSON.parse(readFileSync(combined, "utf8")) as {
      provenance: { kind: string; platformOverride: boolean };
      productionClaimsEnabled: boolean;
    };
    assert.equal(packet.provenance.kind, "named-host");
    assert.equal(packet.provenance.platformOverride, false);
    assert.equal(packet.productionClaimsEnabled, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("listener rejects a streaming oversized chunked request and serves a later valid request", async () => {
  const server = spawn(process.execPath, [
    tsxCli,
    probeScript,
    "--mode", "server",
    "--direction", "windows-to-windows",
    "--platform", "windows",
    "--allow-platform-override",
    "--timeout-ms", "1000",
    "--bind-host", "127.0.0.1",
    "--port", "0",
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, IT_INTEROP_SHARED_KEY: sharedKey },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const port = await waitForReady(server);
    const marker = "unique-open-sender-request-content";
    const body = Buffer.concat([
      Buffer.from(marker, "utf8"),
      Buffer.alloc(65_537 - Buffer.byteLength(marker, "utf8"), 0x61),
    ]);
    const result = await new Promise<{
      statusCode: number;
      contextProcessed: string | string[] | undefined;
      bodyFraming: string | string[] | undefined;
      retainedBodyBytes: string | string[] | undefined;
      connection: string | string[] | undefined;
      contentLength: string | string[] | undefined;
      responseBody: string;
      senderFinished: boolean;
      socketClosed: boolean;
      responseDelayMs: number;
      continuedBytes: number;
    }>((resolve, reject) => {
      const request = createHttpRequest({
        hostname: "127.0.0.1",
        port,
        method: "POST",
        path: "/execute",
        headers: {
          "content-type": "application/octet-stream",
          "transfer-encoding": "chunked",
        },
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let responseReceived = false;
      let responseEnded = false;
      let senderFinished = false;
      let socketClosed = false;
      let settled = false;
      let oversizedChunkSentAt = 0;
      let responseDelayMs = Number.POSITIVE_INFINITY;
      let continuedBytes = 0;
      let continuationTimer: ReturnType<typeof setInterval> | undefined;
      let statusCode = 0;
      let contextProcessed: string | string[] | undefined;
      let bodyFraming: string | string[] | undefined;
      let retainedBodyBytes: string | string[] | undefined;
      let connection: string | string[] | undefined;
      let contentLength: string | string[] | undefined;
      const responseChunks: Buffer[] = [];

      const finishIfComplete = () => {
        if (settled || !responseEnded || !socketClosed) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (continuationTimer) clearInterval(continuationTimer);
        resolve({
          statusCode,
          contextProcessed,
          bodyFraming,
          retainedBodyBytes,
          connection,
          contentLength,
          responseBody: Buffer.concat(responseChunks).toString("utf8"),
          senderFinished,
          socketClosed,
          responseDelayMs,
          continuedBytes,
        });
      };

      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (continuationTimer) clearInterval(continuationTimer);
        request.destroy();
        reject(new Error("listener waited for the oversized chunked sender to finish"));
      }, 3_000);

      request.once("finish", () => {
        senderFinished = true;
      });
      request.once("socket", (socket) => {
        socket.once("close", () => {
          socketClosed = true;
          finishIfComplete();
        });
      });
      request.once("response", (response) => {
        responseReceived = true;
        statusCode = response.statusCode ?? 0;
        responseDelayMs = Date.now() - oversizedChunkSentAt;
        contextProcessed = response.headers["x-it-interop-context-processed"];
        bodyFraming = response.headers["x-it-interop-body-framing"];
        retainedBodyBytes = response.headers["x-it-interop-retained-body-bytes"];
        connection = response.headers.connection;
        contentLength = response.headers["content-length"];
        response.on("data", (chunk: Buffer) => responseChunks.push(chunk));
        response.once("end", () => {
          responseEnded = true;
          finishIfComplete();
        });
      });
      request.once("error", (error) => {
        if (settled || responseReceived) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(error);
      });

      // Reach the exact limit while leaving the chunked request open. Cross
      // it after a short pause, then keep offering more bytes until the
      // listener closes the connection.
      request.write(body.subarray(0, 65_536));
      setTimeout(() => {
        if (settled || request.destroyed) return;
        oversizedChunkSentAt = Date.now();
        request.write(body.subarray(65_536));
        const continuation = Buffer.alloc(1_024, 0x62);
        continuedBytes += continuation.byteLength;
        request.write(continuation);
        continuationTimer = setInterval(() => {
          if (request.destroyed) {
            if (continuationTimer) clearInterval(continuationTimer);
            return;
          }
          continuedBytes += continuation.byteLength;
          request.write(continuation);
        }, 10);
      }, 20);
    });

    assert.equal(result.statusCode, 413);
    assert.equal(result.contextProcessed, "false");
    assert.equal(result.bodyFraming, "chunked");
    assert.equal(result.retainedBodyBytes, "0");
    assert.equal(result.connection, "close");
    assert.equal(result.socketClosed, true);
    assert.equal(result.senderFinished, false);
    assert.ok(result.continuedBytes >= 1_024, "the sender should continue writing after crossing the limit");
    assert.ok(result.responseDelayMs < 1_000, "the listener should reject promptly after the limit is crossed");
    assert.ok(Number(result.contentLength) <= 128, "the oversized response body must remain bounded");
    assert.ok(Buffer.byteLength(result.responseBody, "utf8") <= 128);
    assert.equal(result.responseBody.includes(marker), false);

    const status = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const statusRequest = createHttpRequest({
        hostname: "127.0.0.1",
        port,
        method: "GET",
        path: "/status",
        agent: false,
        headers: { "x-it-interop-key": sharedKey },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      });
      statusRequest.once("error", reject);
      statusRequest.end();
    });
    assert.equal(status.statusCode, 200);
    assert.equal(
      (JSON.parse(status.body) as { nodeId: string }).nodeId,
      "cross-platform-interop-target",
    );
  } finally {
    await stop(server);
  }
});