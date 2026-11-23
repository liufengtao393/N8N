import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	IMAGES,
	buildReport,
	renderSummary,
	resolveChannel,
	statusOf,
} from './base-image-report.mjs';

const finding = (id, severity = 'HIGH', pkg = 'zlib') => ({
	id,
	pkg,
	severity,
	installed: '1.0',
	fixed: '1.1',
});

const platform = (removed = [], remaining = []) => ({
	platform: 'linux/amd64',
	removed,
	added: [],
	addedPackages: [],
	remaining,
});

const n8n = IMAGES.find((image) => image.name === 'n8n');
const runUrl = 'https://github.com/n8n-io/n8n/actions/runs/5';
const prs = [
	{ branch: 'base-image-refresh/daily', url: 'https://github.com/n8n-io/n8n/pull/45000' },
	{ branch: 'base-image-refresh/review', url: 'https://github.com/n8n-io/n8n/pull/45001' },
];
const context = (results, nightlyKeys = new Set(['CVE-1 zlib'])) => ({
	results,
	nightlyKeys,
	prs,
	runUrl,
});

describe('statusOf', () => {
	it('marks a finding that the nightly image no longer has as fix-merged', () => {
		assert.deepEqual(statusOf('CVE-1 zlib', n8n, context([], new Set())), {
			status: 'fix-merged',
		});
	});

	it('links the daily or the review PR of a ready digest that removes the finding', () => {
		const ready = (autoMerge) => ({
			source: 'DHI_REF',
			status: 'ready',
			autoMerge,
			platforms: [platform([finding('CVE-1')])],
		});
		assert.deepEqual(statusOf('CVE-1 zlib', n8n, context([ready(true)])), {
			status: 'pr-open',
			link: 'https://github.com/n8n-io/n8n/pull/45000',
		});
		assert.deepEqual(statusOf('CVE-1 zlib', n8n, context([ready(false)])), {
			status: 'pr-open',
			link: 'https://github.com/n8n-io/n8n/pull/45001',
		});
	});

	it('gives the gate status of a digest that removes the finding', () => {
		const held = (status) => [
			{ source: 'DHI_REF', status, platforms: [platform([finding('CVE-1')])] },
		];
		assert.equal(statusOf('CVE-1 zlib', n8n, context(held('in-24h-gate'))).status, 'in-24h-gate');
		assert.equal(
			statusOf('CVE-1 zlib', n8n, context(held('unverified'))).status,
			'publisher-check-failed',
		);
		assert.equal(
			statusOf('CVE-1 zlib', n8n, context(held('no-publish-time'))).status,
			'no-publish-time',
		);
	});

	it('links the run for a version update that removes the finding', () => {
		const results = [
			{
				source: 'DHI_REF',
				status: 'version-update',
				platforms: [platform([], [finding('CVE-1')])],
				versionUpdate: { platforms: [platform([finding('CVE-1')])] },
			},
		];
		assert.deepEqual(statusOf('CVE-1 zlib', n8n, context(results)), {
			status: 'version-update',
			link: runUrl,
		});
	});

	it('tells a finding of the upstream image from a package that the base installs', () => {
		const results = [
			{
				source: 'DHI_REF',
				status: 'no-upstream-fix',
				platforms: [platform([], [finding('CVE-1')])],
			},
		];
		assert.equal(statusOf('CVE-1 zlib', n8n, context(results)).status, 'no-upstream-fix');
		assert.equal(
			statusOf('CVE-2 openssh', n8n, context(results, new Set(['CVE-2 openssh']))).status,
			'needs-rebuild',
		);
	});

	it('ignores the pins of other images', () => {
		const results = [
			{
				source: 'DEBIAN_DHI_REF',
				status: 'ready',
				autoMerge: true,
				platforms: [platform([finding('CVE-1')])],
			},
		];
		assert.equal(statusOf('CVE-1 zlib', n8n, context(results)).status, 'needs-rebuild');
	});
});

describe('buildReport', () => {
	const scans = (release, nightly) =>
		['linux/amd64', 'linux/arm64'].map((name) => ({
			platform: name,
			release: { findings: release, packages: [] },
			nightly: nightly ? { findings: nightly, packages: [] } : null,
		}));

	it('lists each finding once with its platforms, the most severe first', () => {
		const report = buildReport({
			line: 'stable',
			version: '2.48.8',
			image: n8n,
			ref: 'n8nio/n8n:2.48.8@sha256:a',
			nightlyRef: 'n8nio/n8n:nightly@sha256:b',
			scans: scans([finding('CVE-2', 'MEDIUM'), finding('CVE-1', 'CRITICAL')], []),
			results: [],
			prs,
			runUrl,
		});
		assert.deepEqual(
			report.findings.map((f) => `${f.severity} ${f.id} ${f.platforms.join('+')} ${f.status}`),
			[
				'CRITICAL CVE-1 linux/amd64+linux/arm64 fix-merged',
				'MEDIUM CVE-2 linux/amd64+linux/arm64 undefined',
			],
		);
	});

	it('does not claim fix-merged without a nightly image', () => {
		const report = buildReport({
			line: 'stable',
			version: '2.48.8',
			image: n8n,
			ref: 'n8nio/n8n:2.48.8@sha256:a',
			nightlyRef: null,
			scans: scans([finding('CVE-1')], null),
			results: [],
			prs,
			runUrl,
		});
		assert.equal(report.findings[0].status, 'needs-rebuild');
	});
});

describe('resolveChannel', () => {
	const labels = (version) => ({ Labels: { 'org.opencontainers.image.version': version } });
	const sameDigest = () => 'sha256:a';

	it('reads the version label of a multi-platform image', () => {
		const inspect = () => ({ 'linux/amd64': { config: labels('2.48.8') } });
		assert.equal(resolveChannel('stable', { inspect, resolve: sameDigest }), '2.48.8');
	});

	it('reads the version label of a single-platform image', () => {
		const inspect = () => ({ config: labels('2.49.5') });
		assert.equal(resolveChannel('beta', { inspect, resolve: sameDigest }), '2.49.5');
	});

	it('fails without a release version label', () => {
		const inspect = () => ({ config: labels('v3-nightly') });
		assert.throws(
			() => resolveChannel('v3-rc', { inspect, resolve: sameDigest }),
			/no release version label/,
		);
	});

	it('fails when the version tag is another image', () => {
		const inspect = () => ({ config: labels('2.48.8') });
		const resolve = (ref) => (ref.endsWith(':stable') ? 'sha256:a' : 'sha256:b');
		assert.throws(() => resolveChannel('stable', { inspect, resolve }), /is not the image of/);
	});
});

describe('renderSummary', () => {
	it('counts the findings and the statuses of each image', () => {
		const summary = renderSummary([
			{
				line: 'stable',
				image: 'n8nio/n8n:2.48.8@sha256:a',
				findings: [
					{ ...finding('CVE-1', 'HIGH'), status: 'pr-open' },
					{ ...finding('CVE-2', 'HIGH'), status: 'pr-open' },
					finding('CVE-3', 'MEDIUM'),
				],
			},
		]);
		assert.match(summary, /\| stable \| `n8nio\/n8n:2\.48\.8` \| 0 \| 2 \| 1 \| pr-open: 2 \|/);
	});
});
