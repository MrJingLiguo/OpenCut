// Packs a directory tree into a single archive file that the compiled
// launcher (desktop/launcher.ts) embeds and extracts at runtime. A custom
// format instead of tar/zip keeps both ends dependency-free; `bun build
// --compile` embeds it as one asset, which sidesteps glob expansion and
// Windows argv-length limits for the thousands of files in the standalone
// output.
//
// Layout (all little-endian):
//   8s  magic "OPCTPACK"
//   u32 format version (1)
//   u32 file count
//   per file: u16 path length, path bytes (utf8, forward slashes),
//             u64 content length, content bytes

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const [root, out] = process.argv.slice(2);
if (!root || !out) {
	console.error("usage: bun run pack.ts <root-dir> <out-file>");
	process.exit(1);
}

const MAGIC = "OPCTPACK";
const VERSION = 1;

const files: string[] = [];
(function walk(dir: string) {
	for (const name of readdirSync(dir).sort()) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full);
		else files.push(full);
	}
})(root);

const writer = Bun.file(out).writer();
const header = Buffer.alloc(16);
Buffer.from(MAGIC, "ascii").copy(header, 0);
header.writeUInt32LE(VERSION, 8);
header.writeUInt32LE(files.length, 12);
writer.write(header);

for (const abs of files) {
	const rel = relative(root, abs).replace(/\\/g, "/");
	const pathBytes = Buffer.from(rel, "utf8");
	if (pathBytes.length > 0xffff) throw new Error(`path too long: ${rel}`);
	const prefix = Buffer.alloc(2 + pathBytes.length + 8);
	prefix.writeUInt16LE(pathBytes.length, 0);
	pathBytes.copy(prefix, 2);
	const size = statSync(abs).size;
	prefix.writeBigUInt64LE(BigInt(size), 2 + pathBytes.length);
	writer.write(prefix);
	writer.write(readFileSync(abs));
}

await writer.end();

console.log(`packed ${files.length} files -> ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
