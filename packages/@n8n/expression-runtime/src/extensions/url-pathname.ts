/** Returns the path that `new URL(value).pathname` returns, or `undefined` when the URL is not valid. */
export const urlPathname = (value: string): string | undefined => {
	try {
		return new URL(value).pathname;
	} catch {
		return undefined;
	}
};

/** Returns `urlPathname` of a value that comes from the guest. A value that is not a string has no path. */
export const urlPathnameOfGuestValue = (value: unknown): string | undefined =>
	typeof value === 'string' ? urlPathname(value) : undefined;
