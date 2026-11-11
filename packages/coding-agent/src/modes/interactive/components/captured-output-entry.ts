import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import type { EntryRenderOptions } from "../../../core/extensions/types.ts";
import type { CustomEntry } from "../../../core/session-manager.ts";
import { type CapturedOutputEntryData, formatCapturedBytes } from "../captured-output.ts";
import type { Theme } from "../theme/theme.ts";

const MAX_EXPANDED_LINES = 80;

/**
 * Renderer for captured terminal output. Core owns this entry, so the renderer lives
 * here instead of coming from an extension; `addCustomEntryToChat` falls back to it
 * for `CAPTURED_OUTPUT_ENTRY_TYPE`.
 *
 * Collapsed, the entry is a single line naming the bytes, the stream and the log file.
 * Expanded, it shows the captured text (clipped at capture time) and the log path.
 */
export function renderCapturedOutputEntry(
	entry: CustomEntry<unknown>,
	options: EntryRenderOptions,
	theme: Theme,
): Component | undefined {
	// Only this customType's entries reach this renderer, so the data shape is known.
	const data = entry.data as CapturedOutputEntryData | undefined;
	if (!data) return undefined;

	const lines: string[] = [];
	const writes = `${data.writes} write${data.writes === 1 ? "" : "s"}`;
	lines.push(
		`${theme.fg("warning", "captured")} ${formatCapturedBytes(data.bytes)} ${data.stream} (${writes}) ${theme.fg("muted", "· not sent to the model")}`,
	);

	if (data.suppressed) {
		lines.push(theme.fg("muted", "Further captured output is only logged."));
		lines.push(theme.fg("muted", `log: ${data.logPath}`));
		return new Text(lines.join("\n"), 0, 0);
	}

	if (!options.expanded) {
		lines[0] += theme.fg(
			"muted",
			` · ${data.truncated || data.dropped > 0 ? "clipped, " : ""}${options.keyHint("app.tools.expand", "expand")}`,
		);
		return new Text(lines.join("\n"), 0, 0);
	}

	if (data.dropped > 0) {
		lines.push(theme.fg("muted", `${formatCapturedBytes(data.dropped)} dropped before display; see the log.`));
	}
	const captured = data.text.replace(/\n+$/u, "");
	if (captured !== "") {
		const body = captured.split("\n");
		const shown = body.slice(-MAX_EXPANDED_LINES);
		if (shown.length < body.length) {
			lines.push(theme.fg("muted", `… ${body.length - shown.length} earlier lines only in the log`));
		}
		lines.push(...shown.map((line) => theme.fg("dim", line)));
	}
	if (data.truncated) {
		lines.push(theme.fg("muted", "… capture clipped for the transcript; the log has the full text"));
	}
	lines.push(theme.fg("muted", `log: ${data.logPath}`));
	return new Text(lines.join("\n"), 0, 0);
}
