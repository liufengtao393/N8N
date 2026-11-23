import { Transliterate } from 'transliteration/dist/node/src/common/transliterate';

import { TO_ASCII_OPTIONS } from '../extensions/to-ascii-options';
import { TO_ASCII_CHARMAP_HOST_FUNCTION } from './host-function-names';
import { takeHostFunction } from './take-host-function';

/** Returns a `toAscii` that reads the character map on its first call only. */
const createToAscii = (readCharmapJson: () => string) => {
	let transliterator: Transliterate | undefined;
	return (value: string): string => {
		transliterator ??= new Transliterate(undefined, JSON.parse(readCharmapJson()));
		return transliterator.transliterate(value, TO_ASCII_OPTIONS);
	};
};

/**
 * Guest version of `toAscii` in `extensions/to-ascii.ts`.
 * The character map comes from the host, so it stays out of the runtime bundle.
 * The conversion runs in the guest, within the time and memory limits of the sandbox.
 */
export const toAscii = createToAscii(takeHostFunction<[], string>(TO_ASCII_CHARMAP_HOST_FUNCTION));
