import { URL_PATHNAME_HOST_FUNCTION } from './host-function-names';
import { takeHostFunction } from './take-host-function';

/**
 * Guest version of `urlPathname` in `extensions/url-pathname.ts`.
 * The guest has no `URL`, so the host parses the URL. The call runs outside the limits of the sandbox.
 */
export const urlPathname = takeHostFunction<[value: string], string | undefined>(
	URL_PATHNAME_HOST_FUNCTION,
);
