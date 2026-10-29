// Shared runtime parser. The embedded helper and page use the same framing rules.
export function parseBridgeJSON(raw: string, maxBytes: number): Record<string, unknown>;
