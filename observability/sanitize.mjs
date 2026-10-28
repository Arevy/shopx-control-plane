// Only operational fields enter central storage. Never store payloads or headers.
export function cleanText(value) {
	return String(value)
		.slice(0, 4096)
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, "[REDACTED]")
		.replace(
			/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
			"[REDACTED]"
		)
		.replace(
			/\b(?:password|passwd|secret|token|authorization|cookie|api[_-]?key|code)["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
			"[REDACTED]"
		)
		.replace(
			/(?:https?:\/\/|\/)[^\s"<>]*[?#][^\s"<>]*/g,
			(v) => v.split(/[?#]/)[0] + "?[REDACTED]"
		)
		.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[EMAIL]")
		.replace(/\b[a-f0-9]{32,}\b/gi, "[IDENTIFIER]")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}
export function sanitizeLine(line) {
	let input;
	try {
		input = JSON.parse(line);
	} catch {
		/* Old containers may emit arbitrary text. */
	}
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		const code = line.match(
			/\b(?:ORA-\d{5}|ECONNREFUSED|ETIMEDOUT|ENOTFOUND)\b/
		)?.[0];
		return {
			level: code ? "error" : "info",
			event: "legacy_runtime",
			message:
				"Unstructured log withheld. Enable structured logging in this service.",
			...(code ? { error_code: code } : {}),
		};
	}
	const output = {};
	// Grafana and other structured infrastructure loggers use `msg` rather
	// than `message`; retain its sanitized operational text, never the object.
	if (typeof input.message !== "string" && typeof input.msg === "string")
		output.message = cleanText(input.msg);
	for (const key of [
		"level",
		"event",
		"message",
		"method",
		"path",
		"status",
		"duration_ms",
		"duration_seconds",
		"request_id",
		"error_code",
	]) {
		const value = input[key];
		if (typeof value === "string") output[key] = cleanText(value);
		else if (typeof value === "number" && Number.isFinite(value))
			output[key] = value;
	}
	if (!["debug", "info", "warn", "error", "fatal"].includes(output.level))
		output.level = "info";
	if (!output.message && !output.event)
		output.message = "Structured event contained no permitted operational text.";
	return output;
}
export function containerIdentity(container, platforms, oracleName) {
	const labels = container.Labels || {},
		project = labels["com.docker.compose.project"],
		service = labels["com.docker.compose.service"];
	if (!/^[a-f0-9]{64}$/.test(container.Id)) return null;
	if (container.Names?.includes("/" + oracleName))
		return { platform_id: "system", service: "oracle" };
	if (!/^[a-z][a-z0-9_-]{0,39}$/.test(service || "")) return null;
	const platform = labels["shopx.platform"];
	if (
		/^sx_[a-f0-9]{12}$/.test(platform || "") &&
		platforms.has(platform) &&
		project === platform.replace("_", "-") &&
		["backend", "admin", "storefront", "redis", "gateway"].includes(service)
	)
		return { platform_id: platform, service };
	if (
		project === "shopx" &&
		["backend", "admin", "frontend", "web", "metro", "nginx", "redis"].includes(
			service
		)
	)
		return { platform_id: "legacy", service };
	if (
		project === "shopx-factory" &&
		["api", "worker", "console"].includes(service)
	)
		return { platform_id: "control", service };
	if (
		["shopx", "shopx-observability"].includes(project) &&
		labels["shopx.observability"] === "true" &&
		[
			"obs-grafana",
			"obs-loki",
			"obs-alloy",
			"obs-prometheus",
			"obs-collector",
		].includes(service)
	)
		return { platform_id: "system", service: service.slice(4) };
	return null;
}
export function decodeDockerLogs(buffer) {
	let cursor = 0;
	const chunks = [];
	while (
		cursor + 8 <= buffer.length &&
		[1, 2].includes(buffer[cursor]) &&
		buffer[cursor + 1] === 0 &&
		buffer[cursor + 2] === 0 &&
		buffer[cursor + 3] === 0
	) {
		const length = buffer.readUInt32BE(cursor + 4);
		if (cursor + 8 + length > buffer.length) break;
		chunks.push(buffer.subarray(cursor + 8, cursor + 8 + length));
		cursor += 8 + length;
	}
	return (cursor ? Buffer.concat(chunks) : buffer).toString("utf8").split("\n");
}
