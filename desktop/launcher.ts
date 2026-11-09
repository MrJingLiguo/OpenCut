// Self-extracting launcher for the OpenCut web app.
//
// The exe embeds the Next.js "standalone" server produced by `next build`
// (see desktop/build.sh). On first run it extracts everything into
// %LOCALAPPDATA%\OpenCut\app, starts the server on loopback, opens the
// default browser, and keeps running while the server is up.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The .pack archive built by desktop/pack.ts, embedded at compile time.
import appPack from "../dist/app.pack" with { type: "file" };
// The bun runtime that will run the extracted server (staged by build.sh).
import bunExe from "../dist/bun-runtime.exe" with { type: "file" };

// Injected by `bun build --define` in desktop/build.sh.
declare const BUILD_SHA: string;

const APP_DIR = join(process.env.LOCALAPPDATA || process.cwd(), "OpenCut", "app");
const LOCK = join(process.env.LOCALAPPDATA || process.cwd(), "OpenCut", "opencut.lock");
const MARKER = join(APP_DIR, ".extracted");
const HOST = "127.0.0.1";
const PORT = process.env.OPENCUT_PORT || "4173";
const URL = `http://${HOST}:${PORT}`;

// Env the app's zod schema (src/lib/env/web.ts) demands at import time.
// The editor itself never touches these; they only keep the server modules
// (auth, feedback, sounds search) importable. Placeholder values are fine
// because those flows cannot work offline anyway.
process.env.NODE_ENV ||= "production";
process.env.HOSTNAME = HOST;
process.env.PORT = PORT;
process.env.DATABASE_URL ||= "postgres://placeholder:placeholder@127.0.0.1:5432/placeholder";
process.env.BETTER_AUTH_SECRET ||= "placeholder-not-a-real-secret";
process.env.UPSTASH_REDIS_REST_URL ||= "https://placeholder.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN ||= "placeholder";
process.env.MARBLE_WORKSPACE_KEY ||= "placeholder";
process.env.NEXT_PUBLIC_MARBLE_API_URL ||= "https://api.marblecms.com";
process.env.FREESOUND_CLIENT_ID ||= "placeholder";
process.env.FREESOUND_API_KEY ||= "placeholder";

function log(msg: string) {
	console.log(`[OpenCut] ${msg}`);
}

// Two concurrent instances would race on extraction, so guard the app dir
// with an exclusive-create lock file carrying our pid.
function isPidAlive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function acquireLock() {
	mkdirSync(dirname(LOCK), { recursive: true });
	try {
		closeSync(openSync(LOCK, "wx"));
	} catch {
		try {
			const pid = Number.parseInt(readFileSync(LOCK, "utf8").trim(), 10);
			if (pid && isPidAlive(pid)) {
				log(`another instance is already running (pid ${pid})`);
				process.exit(0);
			}
		} catch {}
		unlinkSync(LOCK); // stale lock from a crashed run
		acquireLock();
		return;
	}
	writeFileSync(LOCK, String(process.pid));
	process.on("exit", () => {
		try {
			unlinkSync(LOCK);
		} catch {}
	});
}

async function extract() {
	log(`extracting app files to ${APP_DIR} ...`);

	const view = new DataView(await Bun.file(appPack).arrayBuffer());
	if (new TextDecoder().decode(view.buffer.slice(0, 8)) !== "OPCTPACK") {
		throw new Error("bad archive magic");
	}
	const version = view.getUint32(8, true);
	if (version !== 1) throw new Error(`unsupported archive version ${version}`);
	const count = view.getUint32(12, true);

	const decoder = new TextDecoder();
	let offset = 16;
	for (let i = 0; i < count; i++) {
		const pathLen = view.getUint16(offset, true);
		offset += 2;
		const rel = decoder.decode(view.buffer.slice(offset, offset + pathLen));
		offset += pathLen;
		const size = Number(view.getBigUint64(offset, true));
		offset += 8;
		const target = join(APP_DIR, rel);
		if (!target.startsWith(APP_DIR)) throw new Error(`bad path: ${rel}`);
		mkdirSync(join(target, ".."), { recursive: true });
		await Bun.write(target, new Uint8Array(view.buffer.slice(offset, offset + size)));
		offset += size;
	}
	log(`extracted ${count} files`);
	await Bun.write(join(APP_DIR, "bun.exe"), Bun.file(bunExe));
}

async function main() {
	const version = typeof BUILD_SHA === "string" ? BUILD_SHA : "dev";
	acquireLock();
	const done = existsSync(MARKER) && readFileSync(MARKER, "utf8").trim() === version;
	if (!done) {
		if (existsSync(APP_DIR)) rmSync(APP_DIR, { recursive: true, force: true });
		await extract();
		writeFileSync(MARKER, version);
	} else {
		log("already extracted, skipping");
	}
	return version;
}

async function waitForServer() {
	for (let i = 0; i < 120; i++) {
		try {
			const res = await fetch(URL, { signal: AbortSignal.timeout(1000) });
			if (res.status < 500) return true;
		} catch {}
		await new Promise((r) => setTimeout(r, 500));
	}
	return false;
}

const version = await main();

log(`starting server on ${URL} (build ${version})`);
// The compiled binary cannot require() from disk-loaded CJS, so run the
// standalone server in an extracted bun child process.
const child = Bun.spawn([join(APP_DIR, "bun.exe"), "server.js"], {
	cwd: join(APP_DIR, "apps", "web"),
	// Spread at spawn time: Bun snapshots process.env at startup, so later
	// assignments above only land in the child if we pass env explicitly.
	env: { ...process.env, PORT: PORT, HOSTNAME: HOST },
	stdout: "inherit",
	stderr: "inherit",
});
process.on("exit", () => child.kill());

if (await waitForServer()) {
	log(`ready — opening ${URL}`);
	const opener = Bun.spawn(["cmd", "/c", "start", "", URL], { stdout: "ignore", stderr: "ignore" });
	await opener.exited;
} else {
	log("server did not become ready in time; open " + URL + " manually");
}

await child.exited;
