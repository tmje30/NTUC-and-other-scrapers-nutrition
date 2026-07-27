/**
 * Parse a human pack-size string into grams. Handles the common Singapore
 * grocery formats. Treats ml/l as g (≈ water density) — a known approximation
 * for liquids (milk, oil, sauces); acceptable for v1.
 *
 * Examples: "450 gm" → 450, "1.5kg" → 1500, "6 x 250ml" → 1500, "500ml" → 500.
 * Returns null if no weight can be read (e.g. pure count packs).
 */
export interface ParsedWeight {
	/** Amount in grams (ml treated as g for volumetric items). */
	grams: number;
	/** True when parsed from a volume unit (ml/L) — display as price per litre. */
	volumetric: boolean;
}

const VOLUME_UNITS = new Set(["l", "lt", "ltr", "litre", "liter", "ml"]);

export function parseWeight(input: string | null | undefined): ParsedWeight | null {
	if (!input) return null;
	const s = input.toLowerCase().replace(/,/g, "");

	const toGrams = (n: number, unit: string): number | null => {
		switch (unit) {
			case "kg":
			case "kgs":
				return n * 1000;
			case "g":
			case "gm":
			case "gms":
			case "gram":
			case "grams":
				return n;
			case "l":
			case "lt":
			case "ltr":
			case "litre":
			case "liter":
				return n * 1000;
			case "ml":
				return n;
			default:
				return null;
		}
	};

	const unitRe = "(kg|kgs|gm|gms|grams?|g|ml|ltr|litre|liter|lt|l)";

	// Multi-pack: "6 x 250ml", "2 x 1kg"
	const multi = s.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*[x×]\\s*(\\d+(?:\\.\\d+)?)\\s*${unitRe}`));
	if (multi) {
		const each = toGrams(Number(multi[2]), multi[3]);
		if (each != null) return { grams: Number(multi[1]) * each, volumetric: VOLUME_UNITS.has(multi[3]) };
	}

	// Single: "450 gm", "1.5kg", "500ml"
	const single = s.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unitRe}`));
	if (single) {
		const g = toGrams(Number(single[1]), single[2]);
		if (g != null) return { grams: g, volumetric: VOLUME_UNITS.has(single[2]) };
	}

	return null;
}

/** Grams only (back-compat helper). */
export function parseWeightGrams(input: string | null | undefined): number | null {
	return parseWeight(input)?.grams ?? null;
}

/** Parse a unit count like "10 eggs", "(2 per pack)", "6s". Returns null if none. */
export function parseUnitCount(input: string | null | undefined): number | null {
	if (!input) return null;
	const s = input.toLowerCase();
	const per = s.match(/(\d+)\s*(?:per pack|per pkt|s\b|pcs|pieces|'?s\b|x\b)/);
	if (per) return Number(per[1]);
	return null;
}
