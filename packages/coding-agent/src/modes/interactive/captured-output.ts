import type { CapturedOutputStream } from "@earendil-works/pi-tui";

/**
 * Custom session entry type for output that was captured while the TUI owned the
 * terminal. It is shown in the transcript but never sent to the LLM.
 */
export const CAPTURED_OUTPUT_ENTRY_TYPE = "pi.tui-captured-output";

export interface CapturedOutputEntryData {
	/** Stream of the most recent captured write in the batch. */
	stream: CapturedOutputStream;
	/** Writes merged into this batch. */
	writes: number;
	/** Bytes of captured text, including text that was clipped or dropped. */
	bytes: number;
	/** Captured text, clipped to what is worth keeping in the session file. */
	text: string;
	/** Whether `text` is shorter than what was captured; the log file has all of it. */
	truncated: boolean;
	/** Bytes that were dropped before reaching the entry, e.g. an extension flooding stdout. */
	dropped: number;
	/** Capture log with the complete text of every batch. */
	logPath: string;
	/** Set on the final entry once the session limit was reached; further output is only logged. */
	suppressed?: boolean;
}

/** Writes inside one window are merged into a single entry. */
export const CAPTURED_OUTPUT_FLUSH_DELAY_MS = 500;
/** Entries per session before captured output is only logged. */
export const CAPTURED_OUTPUT_MAX_ENTRIES = 100;
/** Text kept in the session entry; the log file keeps everything. */
export const CAPTURED_OUTPUT_MAX_ENTRY_BYTES = 8 * 1024;
/** In-memory buffer cap between two flushes. */
export const CAPTURED_OUTPUT_MAX_BUFFER_BYTES = 256 * 1024;

export interface CapturedOutputSinkOptions {
	/** File that receives the complete captured text. */
	logPath: string;
	/** Durable, quiet entry for the batch that becomes visible in the transcript. */
	onEntry: (data: CapturedOutputEntryData) => void;
	/** Appends the complete text to the capture log. Called for every batch. */
	appendToLog: (text: string) => void;
	flushDelayMs?: number;
	maxEntries?: number;
	maxEntryBytes?: number;
	maxBufferBytes?: number;
}

/**
 * Buffers captured terminal writes and turns them into one durable transcript entry
 * per flush window.
 *
 * Problem: an extension writing to stdout/stderr interleaves with rendered frames and
 * the text stays on screen until the next redraw, which reads as a rendering bug.
 * Appending one session entry per write would instead flood the session file, so
 * writes are merged per window and only a clipped copy is stored; the log file keeps
 * the full text.
 */
export class CapturedOutputSink {
	private readonly logPath: string;
	private readonly onEntry: (data: CapturedOutputEntryData) => void;
	private readonly appendToLog: (text: string) => void;
	private readonly flushDelayMs: number;
	private readonly maxEntries: number;
	private readonly maxEntryBytes: number;
	private readonly maxBufferBytes: number;

	private chunks: string[] = [];
	private bufferedBytes = 0;
	private droppedBytes = 0;
	private writes = 0;
	private stream: CapturedOutputStream = "stderr";
	private timer?: ReturnType<typeof setTimeout>;
	private entries = 0;
	private closed = false;

	constructor(options: CapturedOutputSinkOptions) {
		this.logPath = options.logPath;
		this.onEntry = options.onEntry;
		this.appendToLog = options.appendToLog;
		this.flushDelayMs = options.flushDelayMs ?? CAPTURED_OUTPUT_FLUSH_DELAY_MS;
		this.maxEntries = options.maxEntries ?? CAPTURED_OUTPUT_MAX_ENTRIES;
		this.maxEntryBytes = options.maxEntryBytes ?? CAPTURED_OUTPUT_MAX_ENTRY_BYTES;
		this.maxBufferBytes = options.maxBufferBytes ?? CAPTURED_OUTPUT_MAX_BUFFER_BYTES;
	}

	push(text: string, stream: CapturedOutputStream): void {
		if (this.closed || text === "") return;
		this.stream = stream;
		this.writes += 1;
		const bytes = Buffer.byteLength(text, "utf8");
		if (this.bufferedBytes + bytes > this.maxBufferBytes) {
			this.droppedBytes += bytes;
		} else {
			this.chunks.push(text);
			this.bufferedBytes += bytes;
		}
		if (!this.timer) {
			this.timer = setTimeout(() => this.flush(), this.flushDelayMs);
			this.timer.unref();
		}
	}

	/** Emit the pending batch now. Safe to call with nothing buffered. */
	flush(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.writes === 0 && this.droppedBytes === 0) return;

		const text = this.chunks.join("");
		const bytes = this.bufferedBytes + this.droppedBytes;
		const dropped = this.droppedBytes;
		const writes = this.writes;
		const stream = this.stream;
		this.chunks = [];
		this.bufferedBytes = 0;
		this.droppedBytes = 0;
		this.writes = 0;

		if (text !== "") this.appendToLog(text);
		// Past the entry limit the log keeps everything and the transcript stays quiet.
		if (this.entries >= this.maxEntries) return;

		const last = this.entries + 1 >= this.maxEntries;
		this.entries += 1;
		const clipped = last ? { text: "", truncated: false } : clipText(text, this.maxEntryBytes);
		this.onEntry({
			stream,
			writes,
			bytes,
			text: clipped.text,
			truncated: clipped.truncated,
			dropped,
			logPath: this.logPath,
			...(last ? { suppressed: true } : {}),
		});
	}

	/** Flush and stop accepting writes. */
	dispose(): void {
		this.flush();
		this.closed = true;
	}
}

/** Clip UTF-8 text to a byte budget without splitting a surrogate pair. */
export function clipText(text: string, maxBytes: number): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
	let end = Math.min(text.length, maxBytes);
	while (end > 0) {
		const candidate = text.slice(0, end);
		if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
			return { text: `${candidate}…`, truncated: true };
		}
		end = Math.floor(end * 0.9);
	}
	return { text: "…", truncated: true };
}

/** Short human-readable byte size for the transcript entry. */
export function formatCapturedBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
