import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildSessionContext, SessionManager } from "../src/core/session-manager.ts";
import {
	CAPTURED_OUTPUT_ENTRY_TYPE,
	type CapturedOutputEntryData,
	CapturedOutputSink,
	clipText,
	formatCapturedBytes,
} from "../src/modes/interactive/captured-output.ts";
import { renderCapturedOutputEntry } from "../src/modes/interactive/components/captured-output-entry.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

function createSink(options: { maxEntries?: number; maxEntryBytes?: number; maxBufferBytes?: number } = {}) {
	const entries: CapturedOutputEntryData[] = [];
	const log: string[] = [];
	const sink = new CapturedOutputSink({
		logPath: "/tmp/pi-captured-output.log",
		onEntry: (data) => entries.push(data),
		appendToLog: (text) => log.push(text),
		...options,
	});
	return { sink, entries, log };
}

describe("CapturedOutputSink", () => {
	it("merges writes inside one window into a single entry and logs all of them", () => {
		const { sink, entries, log } = createSink();
		sink.push("error: No such remote 'origin'\n", "stderr");
		sink.push("fatal: ambiguous argument 'HEAD'\n", "stderr");
		sink.flush();

		expect(entries).toHaveLength(1);
		expect(entries[0].writes).toBe(2);
		expect(entries[0].stream).toBe("stderr");
		expect(entries[0].text).toBe("error: No such remote 'origin'\nfatal: ambiguous argument 'HEAD'\n");
		expect(entries[0].logPath).toBe("/tmp/pi-captured-output.log");
		expect(log).toEqual(["error: No such remote 'origin'\nfatal: ambiguous argument 'HEAD'\n"]);
	});

	it("flushes on the debounce timer", () => {
		vi.useFakeTimers();
		try {
			const { sink, entries } = createSink();
			sink.push("late\n", "stdout");
			expect(entries).toHaveLength(0);
			vi.advanceTimersByTime(500);
			expect(entries).toHaveLength(1);
			sink.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the session text clipped while the log gets everything", () => {
		const { sink, entries, log } = createSink({ maxEntryBytes: 16 });
		const text = "x".repeat(64);
		sink.push(text, "stdout");
		sink.flush();

		expect(entries[0].truncated).toBe(true);
		expect(Buffer.byteLength(entries[0].text, "utf8")).toBeLessThanOrEqual(16 + Buffer.byteLength("…", "utf8"));
		expect(entries[0].bytes).toBe(64);
		expect(log).toEqual([text]);
	});

	it("counts text dropped beyond the in-memory buffer cap", () => {
		const { sink, entries } = createSink({ maxBufferBytes: 8 });
		sink.push("12345", "stderr");
		sink.push("67890", "stderr");
		sink.flush();

		expect(entries[0].text).toBe("12345");
		expect(entries[0].dropped).toBe(5);
		expect(entries[0].bytes).toBe(10);
	});

	it("appends a suppressed entry once the session limit is reached, then only logs", () => {
		const { sink, entries, log } = createSink({ maxEntries: 2 });
		sink.push("one\n", "stdout");
		sink.flush();
		sink.push("two\n", "stdout");
		sink.flush();
		expect(entries).toHaveLength(2);
		expect(entries[1].suppressed).toBe(true);

		sink.push("three\n", "stdout");
		sink.flush();
		expect(entries).toHaveLength(2);
		expect(log).toEqual(["one\n", "two\n", "three\n"]);
	});

	it("flushes pending writes on dispose", () => {
		const { sink, entries } = createSink();
		sink.push("bye\n", "stderr");
		sink.dispose();

		expect(entries).toHaveLength(1);
		expect(entries[0].text).toBe("bye\n");
	});
});

describe("clipText", () => {
	it("leaves text inside the budget alone", () => {
		expect(clipText("hello", 16)).toEqual({ text: "hello", truncated: false });
	});

	it("does not split a surrogate pair when clipping", () => {
		const { text, truncated } = clipText("😀😀😀", 4);
		expect(truncated).toBe(true);
		expect(text).toBe("😀…");
	});
});

describe("formatCapturedBytes", () => {
	it("formats byte counts", () => {
		expect(formatCapturedBytes(12)).toBe("12 B");
		expect(formatCapturedBytes(2048)).toBe("2.0 KB");
		expect(formatCapturedBytes(3 * 1024 * 1024)).toBe("3.0 MB");
	});
});

describe("captured output entry in the session", () => {
	it("persists the entry and replays it, without adding it to LLM context", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-captured-entry-"));
		try {
			const manager = SessionManager.create(dir, dir);
			manager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "hello" }],
				timestamp: Date.now(),
			});
			const data: CapturedOutputEntryData = {
				stream: "stderr",
				writes: 2,
				bytes: 56,
				text: "CAPTURE_SENTINEL_CONSOLE\nerror: No such remote 'origin'\n",
				truncated: false,
				dropped: 0,
				logPath: "/tmp/pi-captured-output.log",
			};
			manager.appendCustomEntry(CAPTURED_OUTPUT_ENTRY_TYPE, data);

			const file = manager.getSessionFile();
			expect(file).toBeDefined();
			const reopened = SessionManager.open(file as string, dir, dir);
			const entries = reopened.getEntries();
			const stored = entries.find(
				(entry) => entry.type === "custom" && entry.customType === CAPTURED_OUTPUT_ENTRY_TYPE,
			);
			expect(stored).toBeDefined();
			expect((stored as { data?: CapturedOutputEntryData }).data).toEqual(data);

			const context = buildSessionContext(entries);
			expect(JSON.stringify(context.messages)).not.toContain("CAPTURE_SENTINEL_CONSOLE");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("renders a collapsed summary and the captured text when expanded", () => {
		initTheme("dark", false);
		const data: CapturedOutputEntryData = {
			stream: "stderr",
			writes: 2,
			bytes: 56,
			text: "error: No such remote 'origin'\n",
			truncated: false,
			dropped: 0,
			logPath: "/tmp/pi-captured-output.log",
		};
		const entry = {
			type: "custom",
			customType: CAPTURED_OUTPUT_ENTRY_TYPE,
			data,
			id: "1",
			parentId: null,
			timestamp: "",
		} as const;
		const options = {
			expanded: false,
			keyText: () => "ctrl+o",
			keyHint: (_binding: string, description: string) => `ctrl+o ${description}`,
		};

		const collapsed = renderCapturedOutputEntry(entry, options, theme)?.render(120).join("\n") ?? "";
		expect(collapsed).toContain("captured");
		expect(collapsed).toContain("56 B stderr (2 writes)");
		expect(collapsed).toContain("not sent to the model");
		expect(collapsed).toContain("ctrl+o expand");

		const expanded =
			renderCapturedOutputEntry(entry, { ...options, expanded: true }, theme)
				?.render(120)
				.join("\n") ?? "";
		expect(expanded).toContain("error: No such remote 'origin'");
		expect(expanded).toContain("/tmp/pi-captured-output.log");
	});
});
