/**
 * Takes the host function off the guest global object and returns it.
 * An expression can then reach the host function only through the returned reference.
 *
 * @throws {Error} when the host did not set the function
 */
export const takeHostFunction = <Args extends unknown[], Result>(
	name: string,
): ((...args: Args) => Result) => {
	const guestGlobal = globalThis as unknown as Record<
		string,
		((...args: Args) => Result) | undefined
	>;
	const hostFunction = guestGlobal[name];
	if (typeof hostFunction !== 'function') {
		throw new Error('A host function is missing from the guest global object');
	}
	delete guestGlobal[name];
	return hostFunction;
};
