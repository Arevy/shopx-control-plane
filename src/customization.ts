// This public contract is mirrored in the independently deployable commerce API.
export interface Experience {
	logoUrl: string;
	tagline: string;
	heroTitle: string;
	heroDescription: string;
	announcement: string;
	supportEmail: string;
	footerText: string;
	showFeatured: boolean;
	showNewArrivals: boolean;
	showEditorial: boolean;
	cornerStyle: "sharp" | "rounded" | "pill";
	fontFamily: "sans" | "serif" | "mono";
	catalogDensity: "comfortable" | "compact";
}
export function validateExperience(value: unknown): Experience {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("INVALID_EXPERIENCE");
	const v = value as Record<string, unknown>;
	const text: Record<string, number> = {
		logoUrl: 1000,
		tagline: 100,
		heroTitle: 140,
		heroDescription: 500,
		announcement: 180,
		supportEmail: 254,
		footerText: 300,
	};
	const booleans = ["showFeatured", "showNewArrivals", "showEditorial"];
	const enums = {
		cornerStyle: ["sharp", "rounded", "pill"],
		fontFamily: ["sans", "serif", "mono"],
		catalogDensity: ["comfortable", "compact"],
	};
	if (
		Object.keys(v).some(
			(k) =>
				![...Object.keys(text), ...booleans, ...Object.keys(enums)].includes(k)
		)
	)
		throw new Error("UNKNOWN_EXPERIENCE_FIELD");
	const result: Record<string, unknown> = {};
	for (const [key, max] of Object.entries(text)) {
		const input = v[key] ?? "";
		if (
			typeof input !== "string" ||
			input.length > max ||
			(key === "heroDescription" || key === "footerText"
				? /[\x00-\x08\x0b\x0c\x0e-\x1f<>]/
				: /[\x00-\x1f<>]/
			).test(input)
		)
			throw new Error("INVALID_EXPERIENCE_TEXT");
		result[key] = input.trim();
	}
	if (result.logoUrl) {
		const url = new URL(String(result.logoUrl));
		if (url.protocol !== "https:" || url.username || url.password || url.hash)
			throw new Error("INVALID_LOGO_URL");
	}
	if (
		result.supportEmail &&
		!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(result.supportEmail))
	)
		throw new Error("INVALID_SUPPORT_EMAIL");
	for (const key of booleans) {
		if (v[key] !== undefined && typeof v[key] !== "boolean")
			throw new Error("INVALID_SECTION_VISIBILITY");
		result[key] = v[key] ?? true;
	}
	for (const [key, options] of Object.entries(enums)) {
		const defaults: Record<string, string> = {
			cornerStyle: "rounded",
			fontFamily: "sans",
			catalogDensity: "comfortable",
		};
		if (v[key] !== undefined && !options.includes(v[key] as string))
			throw new Error("INVALID_APPEARANCE");
		result[key] = v[key] ?? defaults[key];
	}
	return result as unknown as Experience;
}
