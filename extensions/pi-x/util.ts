import { XError } from "./errors.ts";

export function clamp(n: number, min: number, max: number): number {
	if (!Number.isFinite(n)) return min;
	return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function unique<T>(xs: T[]): T[] {
	return [...new Set(xs.filter((x) => x !== "" && x != null))];
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new XError("aborted", "Cancelled"));
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(new XError("aborted", "Cancelled"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
