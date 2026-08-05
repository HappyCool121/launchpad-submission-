import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compareBundledPayload } from "./verify-bundled-payload.mjs";

function createFixture() {
	const root = mkdtempSync(join(tmpdir(), "adrouter-bundle-compare-"));
	const source = join(root, "source");
	const payload = join(root, "payload");
	mkdirSync(join(source, "nested"), { recursive: true });
	mkdirSync(join(payload, "nested"), { recursive: true });
	writeFileSync(join(source, "nested", "file.txt"), "same");
	writeFileSync(join(payload, "nested", "file.txt"), "same");
	return { payload, root, source };
}

test("accepts complete byte-identical bundle trees", () => {
	const fixture = createFixture();
	try {
		assert.equal(compareBundledPayload(fixture.source, fixture.payload), 1);
	} finally {
		rmSync(fixture.root, { force: true, recursive: true });
	}
});

test("reports missing, changed, and unexpected bundle entries", () => {
	const fixture = createFixture();
	try {
		writeFileSync(join(fixture.payload, "nested", "file.txt"), "changed");
		writeFileSync(join(fixture.source, "missing.txt"), "missing");
		writeFileSync(join(fixture.payload, "unexpected.txt"), "unexpected");
		assert.throws(
			() => compareBundledPayload(fixture.source, fixture.payload),
			/changed bytes: nested\/file\.txt[\s\S]*missing: missing\.txt[\s\S]*unexpected: unexpected\.txt/,
		);
	} finally {
		rmSync(fixture.root, { force: true, recursive: true });
	}
});

test("compares symbolic-link targets", () => {
	if (process.platform === "win32") return;
	const fixture = createFixture();
	try {
		symlinkSync("nested/file.txt", join(fixture.source, "link"));
		symlinkSync("different.txt", join(fixture.payload, "link"));
		assert.throws(() => compareBundledPayload(fixture.source, fixture.payload), /changed symlink: link/);
	} finally {
		rmSync(fixture.root, { force: true, recursive: true });
	}
});
