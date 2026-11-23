import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { ExpressionEvaluator } from '../evaluator/expression-evaluator';
import { urlPathname } from '../extensions/url-pathname';
import { URL_PATHNAME_HOST_FUNCTION } from '../runtime/host-function-names';
import { createBridge, engineName } from './test-bridge';

const LONE_SURROGATE = String.fromCharCode(0xd83d);
const NUL = String.fromCharCode(0);

describe(`extractUrlPath with the host URL parser (${engineName})`, () => {
	let evaluator: ExpressionEvaluator;
	const caller = {};

	beforeAll(async () => {
		evaluator = new ExpressionEvaluator({ createBridge, maxCodeCacheSize: 64 });
		await evaluator.initialize();
		await evaluator.acquire(caller);
	});

	afterAll(async () => {
		await evaluator.release(caller);
		await evaluator.dispose();
	});

	const extractUrlPath = (url: unknown) =>
		evaluator.evaluate('{{ extend($json.url, "extractUrlPath", []) }}', { $json: { url } }, caller);

	it.each([
		['https://de.wikipedia.org/wiki/Käse', '/wiki/K%C3%A4se'],
		['https://example.com/my report.pdf', '/my%20report.pdf'],
		['https://example.com/v1/../v2/users', '/v2/users'],
		['https://example.com/a%2fb', '/a%2fb'],
		['https://example.com', '/'],
		['custom://host', ''],
		['mailto:me@example.com', 'me@example.com'],
		['file:///C:x/..', new URL('file:///C:x/..').pathname],
		[`https://example.com/a${NUL}b`, '/a%00b'],
		[`https://example.com/${LONE_SURROGATE}`, '/%EF%BF%BD'],
	])('should give the path of `new URL()` for %j', (url, path) => {
		expect(extractUrlPath(url)).toBe(path);
		expect(path).toBe(urlPathname(url));
	});

	it.each(['', 'hi', 'https://', 'https://exa mple.com/path', 'http://xn--a/path'])(
		'should give no value for %j, which is not a valid URL',
		(url) => {
			expect(extractUrlPath(url)).toBeUndefined();
		},
	);

	it('should not leave the host function on the global object', async () => {
		const bridge = createBridge();
		await bridge.initialize();

		// Raw bridge code sees the guest global. An expression sees an empty `globalThis`.
		const result = bridge.execute(`return typeof ${URL_PATHNAME_HOST_FUNCTION}`, {});

		expect(result).toBe('undefined');

		await bridge.dispose();
	});

	it('should work on a bridge that starts synchronously', async () => {
		const lazyEvaluator = new ExpressionEvaluator({
			createBridge,
			maxCodeCacheSize: 64,
			poolSize: 1,
			lazyAcquire: true,
		});
		await lazyEvaluator.initialize();
		const callerA = {};
		const callerB = {};
		await lazyEvaluator.acquire(callerA);
		await lazyEvaluator.acquire(callerB);

		// A takes the warm bridge, so B starts a bridge synchronously.
		const expression = '{{ extend("https://example.com/a b", "extractUrlPath", []) }}';
		const resultA = lazyEvaluator.evaluate(expression, {}, callerA);
		const resultB = lazyEvaluator.evaluate(expression, {}, callerB);

		expect(resultA).toBe('/a%20b');
		expect(resultB).toBe('/a%20b');

		await lazyEvaluator.release(callerA);
		await lazyEvaluator.release(callerB);
		await lazyEvaluator.dispose();
	});
});
