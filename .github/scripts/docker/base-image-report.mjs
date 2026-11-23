#!/usr/bin/env node
/**
 * Writes the public Trivy report of the released images.
 *
 * The script resolves each release line (a channel tag on Docker Hub) to its
 * version, then scans each variant of that version and the nightly image of the
 * same variant for fixable OS findings, on each platform. Each High or Critical
 * finding gets the status of its fix (see statusOf), from the result of the
 * refresh run in base-image-candidates.mjs.
 *
 * Usage: node base-image-report.mjs --candidates <json> --out <dir>
 * Needs docker buildx and trivy. Writes one JSON for each image to --out, and
 * a summary to $GITHUB_STEP_SUMMARY.
 */

import { execFileSync } from 'node:child_process';
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { DAILY_BRANCH, REVIEW_BRANCH, collectPullRequests } from './base-image-alerts.mjs';
import { PLATFORMS, scan } from './base-image-candidates.mjs';
import { resolveDigest } from './base-image-chain-pr.mjs';

/**
 * The release lines: a channel tag on Docker Hub, and the nightly tag of the
 * branch that the line comes from. v3 ships only as Docker images, so its line
 * goes here when it has a release channel.
 */
export const LINES = [
	{ line: 'stable', channel: 'stable', nightly: 'nightly' },
	{ line: 'beta', channel: 'beta', nightly: 'nightly' },
];

/** The variants of a release, and the pins in docker/docker-bake.hcl that bring their OS packages. */
export const IMAGES = [
	{ name: 'n8n', repository: 'n8nio/n8n', suffix: '', sources: ['DHI_REF'] },
	{ name: 'n8n-pc', repository: 'n8nio/n8n', suffix: '-pc', sources: ['DHI_REF'] },
	{ name: 'n8n-debian', repository: 'n8nio/n8n', suffix: '-debian', sources: ['DEBIAN_DHI_REF'] },
	{ name: 'runners', repository: 'n8nio/runners', suffix: '', sources: ['PYTHON_IMAGE'] },
	{
		name: 'runners-debian',
		repository: 'n8nio/runners',
		suffix: '-debian',
		sources: ['DEBIAN_DHI_REF'],
	},
	{
		name: 'runners-distroless',
		repository: 'n8nio/runners',
		suffix: '-distroless',
		sources: ['DISTROLESS_BASE_IMAGE', 'DEBIAN_PYTHON_IMAGE'],
	},
];

/** The severities that get a status. The report also lists the Medium findings. */
const STATUS_SEVERITIES = new Set(['CRITICAL', 'HIGH']);
const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM'];

const keyOf = (finding) => `${finding.id} ${finding.pkg}`;

const has = (findings, key) => findings.some((finding) => keyOf(finding) === key);

/**
 * The status of the fix of one finding, in the order that a fix moves:
 * - `fix-merged`: the nightly image of the line no longer has it. The fix ships with the next release.
 * - `pr-open`: a refresh PR pins a digest that removes it.
 * - `in-24h-gate`: a digest removes it, and waits for the 24-hour gate.
 * - `publisher-check-failed`, `no-publish-time`: a digest removes it, but the refresh holds it back and sends an alert.
 * - `version-update`: a newer patch of the pinned tag removes it. A person updates the version.
 * - `no-upstream-fix`: the newest digest of the pinned tag still has it.
 * - `needs-rebuild`: no base pin has it, so it comes from a package that n8nio/base installs. A rebuild of the base fixes it.
 */
export function statusOf(key, image, { results, nightlyKeys, prs, runUrl }) {
	if (nightlyKeys && !nightlyKeys.has(key)) return { status: 'fix-merged' };
	const sources = results.filter((result) => image.sources.includes(result.source));
	const removes = (platforms) => platforms?.some((platform) => has(platform.removed, key)) ?? false;
	for (const result of sources) {
		if (!removes(result.platforms)) continue;
		if (result.status === 'ready') {
			const branch = result.autoMerge ? DAILY_BRANCH : REVIEW_BRANCH;
			return { status: 'pr-open', link: prs.find((pr) => pr.branch === branch)?.url ?? null };
		}
		if (['in-24h-gate', 'unverified', 'no-publish-time'].includes(result.status)) {
			const status = result.status === 'unverified' ? 'publisher-check-failed' : result.status;
			return { status };
		}
	}
	for (const result of sources) {
		if (result.status === 'version-update' && removes(result.versionUpdate.platforms))
			return { status: 'version-update', link: runUrl };
	}
	const upstream = sources.some((result) =>
		result.platforms.some((platform) => has(platform.remaining, key)),
	);
	return { status: upstream ? 'no-upstream-fix' : 'needs-rebuild' };
}

/**
 * The report of one image. `scans` holds { platform, release, nightly } entries,
 * where `nightly` is null when the nightly image does not exist.
 */
export function buildReport({ line, version, image, ref, nightlyRef, scans, ...context }) {
	const findings = new Map();
	for (const { platform, release } of scans) {
		for (const finding of release.findings) {
			const entry = findings.get(keyOf(finding)) ?? { ...finding, platforms: [] };
			entry.platforms.push(platform);
			findings.set(keyOf(finding), entry);
		}
	}
	const nightlyKeys = scans.every(({ nightly }) => nightly)
		? new Set(scans.flatMap(({ nightly }) => nightly.findings.map(keyOf)))
		: null;
	const list = [...findings.values()]
		.sort(
			(a, b) =>
				SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
				a.id.localeCompare(b.id) ||
				a.pkg.localeCompare(b.pkg),
		)
		.map((finding) =>
			STATUS_SEVERITIES.has(finding.severity)
				? { ...finding, ...statusOf(keyOf(finding), image, { ...context, nightlyKeys }) }
				: finding,
		);
	return { line, version, image: ref, nightly: nightlyRef, findings: list };
}

/** The Markdown summary of the reports. */
export function renderSummary(reports) {
	const count = (report, severity) =>
		report.findings.filter((finding) => finding.severity === severity).length;
	const lines = [
		'## Trivy report of the released images',
		'',
		'| Line | Image | Critical | High | Medium | Status of the High and Critical findings |',
		'| --- | --- | --- | --- | --- | --- |',
	];
	for (const report of reports) {
		const statuses = new Map();
		for (const finding of report.findings.filter((f) => f.status)) {
			statuses.set(finding.status, (statuses.get(finding.status) ?? 0) + 1);
		}
		const status = [...statuses].map(([name, n]) => `${name}: ${n}`).join(', ') || '-';
		lines.push(
			`| ${report.line} | \`${report.image.split('@')[0]}\` | ${count(report, 'CRITICAL')} | ${count(report, 'HIGH')} | ${count(report, 'MEDIUM')} | ${status} |`,
		);
	}
	return `${lines.join('\n')}\n`;
}

/** Reads the version label of an image, and checks that the version tag has the same digest. */
export function resolveChannel(channel, { inspect = inspectImage, resolve = resolveDigest } = {}) {
	const ref = `n8nio/n8n:${channel}`;
	const image = inspect(ref);
	// A multi-platform image maps each platform to its config.
	const config = image.config ?? Object.values(image)[0]?.config;
	const version = config?.Labels?.['org.opencontainers.image.version'];
	if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
		throw new Error(`${ref} has no release version label (found ${version})`);
	}
	if (resolve(`n8nio/n8n:${version}`) !== resolve(ref)) {
		throw new Error(`n8nio/n8n:${version} is not the image of ${ref}`);
	}
	return version;
}

function inspectImage(ref) {
	const out = execFileSync(
		'docker',
		['buildx', 'imagetools', 'inspect', ref, '--format', '{{json .Image}}'],
		{
			encoding: 'utf8',
		},
	);
	return JSON.parse(out);
}

async function main() {
	const { values } = parseArgs({
		options: { candidates: { type: 'string' }, out: { type: 'string' } },
	});
	if (!values.candidates || !values.out) throw new Error('--candidates and --out are required');

	const results = JSON.parse(readFileSync(values.candidates, 'utf8'));
	const prs = await collectPullRequests();
	const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
	const runUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
	const trivy = execFileSync('trivy', ['--version', '--format', 'json'], { encoding: 'utf8' });
	const scannedAt = new Date().toISOString();

	mkdirSync(values.out, { recursive: true });
	const workDir = mkdtempSync(path.join(tmpdir(), 'base-image-report-'));
	const reports = [];
	const skipped = [];
	try {
		for (const line of LINES) {
			// A line without a release version must not stop the report of the other lines.
			let version;
			try {
				version = resolveChannel(line.channel);
			} catch (error) {
				console.log(`::warning::Skipped the ${line.line} line: ${error.message}`);
				skipped.push(`${line.line}: ${error.message}`);
				continue;
			}
			for (const image of IMAGES) {
				const digest = resolveDigest(`${image.repository}:${version}${image.suffix}`);
				if (!digest) {
					console.log(`${line.line}: ${image.repository}:${version}${image.suffix} does not exist`);
					continue;
				}
				const nightlyDigest = resolveDigest(`${image.repository}:${line.nightly}${image.suffix}`);
				const scans = PLATFORMS.map((platform) => ({
					platform,
					release: scan(`${image.repository}@${digest}`, platform, workDir),
					nightly: nightlyDigest
						? scan(`${image.repository}@${nightlyDigest}`, platform, workDir)
						: null,
				}));
				const report = buildReport({
					line: line.line,
					version,
					image,
					ref: `${image.repository}:${version}${image.suffix}@${digest}`,
					nightlyRef: nightlyDigest
						? `${image.repository}:${line.nightly}${image.suffix}@${nightlyDigest}`
						: null,
					scans,
					results,
					prs,
					runUrl,
				});
				reports.push(report);
				writeFileSync(
					path.join(values.out, `${line.line}-${image.name}.json`),
					`${JSON.stringify({ ...report, scannedAt, trivy: JSON.parse(trivy).Version }, null, 2)}\n`,
				);
				console.log(`${line.line}: ${report.image} has ${report.findings.length} findings`);
			}
		}
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}

	if (process.env.GITHUB_STEP_SUMMARY) {
		const notes = skipped.map((reason) => `- Skipped ${reason}`).join('\n');
		appendFileSync(
			process.env.GITHUB_STEP_SUMMARY,
			`${renderSummary(reports)}${notes ? `\n${notes}\n` : ''}`,
		);
	}
	// The reports of the other lines are written, so the upload step can still run.
	if (skipped.length > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
