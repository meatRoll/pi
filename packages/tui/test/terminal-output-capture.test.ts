import assert from "node:assert";
import { execSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import { type CapturedOutputStream, ProcessTerminal } from "../src/terminal.ts";

// Regression for https://github.com/earendil-works/pi/issues/10002
//
// While a started ProcessTerminal owns the terminal, writes to process.stdout and
// process.stderr from outside the renderer (extension console output, `execSync`
// forwarding a child's stderr) interleave with rendered frames and stay on screen
// until the next redraw. They must be routed to the capture sink instead, while
// renderer output keeps going to the terminal.

type Harness = {
	terminal: ProcessTerminal;
	captured: Array<{ text: string; stream: CapturedOutputStream }>;
	stdoutWrites: string[];
	stderrWrites: string[];
	stubbedStdoutWrite: typeof process.stdout.write;
	stubbedStderrWrite: typeof process.stderr.write;
	cleanup(): void;
};

const harnesses: Harness[] = [];

function setupHarness(options: { capture: boolean }): Harness {
	const captured: Array<{ text: string; stream: CapturedOutputStream }> = [];
	const stdoutWrites: string[] = [];
	const stderrWrites: string[] = [];
	const originalStdoutWrite = process.stdout.write;
	const originalStderrWrite = process.stderr.write;
	const originalStdinOn = process.stdin.on;

	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdoutWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderrWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof process.stderr.write;
	process.stdin.on = (() => process.stdin) as typeof process.stdin.on;

	const stubbedStdoutWrite = process.stdout.write;
	const stubbedStderrWrite = process.stderr.write;
	const terminal = options.capture
		? new ProcessTerminal({ onCapturedOutput: (text, stream) => captured.push({ text, stream }) })
		: new ProcessTerminal();

	const harness: Harness = {
		terminal,
		captured,
		stdoutWrites,
		stderrWrites,
		stubbedStdoutWrite,
		stubbedStderrWrite,
		cleanup(): void {
			harness.terminal.stop();
			process.stdout.write = originalStdoutWrite;
			process.stderr.write = originalStderrWrite;
			process.stdin.on = originalStdinOn;
		},
	};
	harnesses.push(harness);
	return harness;
}

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("ProcessTerminal output capture (#10002)", () => {
	it("routes non-renderer writes to the capture sink instead of the terminal", () => {
		const harness = setupHarness({ capture: true });
		harness.terminal.start(
			() => {},
			() => {},
		);

		console.error("EXTENSION_DIAGNOSTIC_SENTINEL");
		process.stdout.write("STRAY_STDOUT");
		process.stderr.write("STRAY_STDERR");

		assert.ok(
			harness.captured.some(
				(entry) => entry.stream === "stderr" && entry.text.includes("EXTENSION_DIAGNOSTIC_SENTINEL"),
			),
		);
		assert.ok(harness.captured.some((entry) => entry.stream === "stdout" && entry.text === "STRAY_STDOUT"));
		assert.ok(harness.captured.some((entry) => entry.stream === "stderr" && entry.text === "STRAY_STDERR"));
		assert.ok(!harness.stderrWrites.some((write) => write.includes("EXTENSION_DIAGNOSTIC_SENTINEL")));
		assert.ok(!harness.stdoutWrites.includes("STRAY_STDOUT"));
		assert.ok(!harness.stderrWrites.includes("STRAY_STDERR"));
	});

	it("captures stderr that execSync forwards from a failing child", () => {
		const harness = setupHarness({ capture: true });
		harness.terminal.start(
			() => {},
			() => {},
		);

		// Node forwards a failed child's stderr through process.stderr.write, which is
		// the path the cmiot metrics hook triggered with `git remote get-url origin`.
		try {
			execSync("sh -c 'echo GIT_LEAKED_STDERR >&2; exit 2'");
		} catch {
			// Expected: the command fails.
		}

		assert.ok(harness.captured.some((entry) => entry.text.includes("GIT_LEAKED_STDERR")));
		assert.ok(!harness.stderrWrites.some((write) => write.includes("GIT_LEAKED_STDERR")));
	});

	it("passes renderer output through to the terminal", () => {
		const harness = setupHarness({ capture: true });
		harness.terminal.start(
			() => {},
			() => {},
		);

		harness.terminal.write("FRAME");
		harness.terminal.hideCursor();
		harness.terminal.moveBy(-2);

		assert.ok(harness.stdoutWrites.includes("FRAME"));
		assert.ok(harness.stdoutWrites.includes("\x1b[?25l"));
		assert.ok(harness.stdoutWrites.includes("\x1b[2A"));
		assert.ok(!harness.captured.some((entry) => entry.text.includes("FRAME")));
	});

	it("restores the stream writes when the terminal stops", () => {
		const harness = setupHarness({ capture: true });
		harness.terminal.start(
			() => {},
			() => {},
		);
		harness.terminal.stop();

		assert.equal(process.stdout.write, harness.stubbedStdoutWrite);
		assert.equal(process.stderr.write, harness.stubbedStderrWrite);

		console.error("AFTER_STOP");
		assert.ok(harness.stderrWrites.some((write) => write.includes("AFTER_STOP")));
	});

	it("leaves stream writes untouched without a capture sink", () => {
		const harness = setupHarness({ capture: false });
		harness.terminal.start(
			() => {},
			() => {},
		);

		assert.equal(process.stdout.write, harness.stubbedStdoutWrite);
		assert.equal(process.stderr.write, harness.stubbedStderrWrite);

		process.stdout.write("DIRECT");
		assert.ok(harness.stdoutWrites.includes("DIRECT"));
	});
});
