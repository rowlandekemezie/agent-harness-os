import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { HarnessConfig } from '../config.js'
import type {
	PolicySource,
	ResolvedPolicy,
	WorkerCapability,
	WorkerCostTier,
	WorkerLatencyTier,
	WorkerRoutingPolicy,
	WorkerTask,
} from '../domain/types.js'
import { readRegularFileAtCommit } from '../git/repository.js'
import { HarnessError } from '../lib/errors.js'
import { isRecord } from '../lib/json.js'

export const repositoryPolicyPath = '.agent-os/policy.json'
const maxPolicyBytes = 65_536
const noFollowFlag = constants.O_NOFOLLOW ?? 0

type PolicyRoutingConstraints = {
	requiredCapabilities: Array<WorkerCapability>
	maxCostTier: WorkerCostTier | null
	maxLatencyTier: WorkerLatencyTier | null
	allowFallback: boolean | null
	maxAttempts: number | null
}

type PolicyDocument = {
	maxChangedFiles: number | null
	maxIterations: number | null
	maxTaskSeconds: number | null
	allowNetwork: boolean | null
	prohibitedPaths: Array<string>
	routing: PolicyRoutingConstraints
}

type LoadedPolicy = {
	document: PolicyDocument
	source: PolicySource
}

export type PolicyBoundTask = WorkerTask & {
	policy: ResolvedPolicy
}

export async function resolveTaskPolicy(
	config: HarnessConfig,
	repositoryPath: string,
	baseCommit: string,
	task: WorkerTask,
): Promise<PolicyBoundTask> {
	const loadedPolicies = await loadPolicies(config, repositoryPath, baseCommit)
	const routing = effectiveTaskRouting(config, task, loadedPolicies)
	const prohibitedPaths = uniqueStrings([
		...task.prohibitedPaths,
		...loadedPolicies.flatMap(policy => policy.document.prohibitedPaths),
	])
	const policyWithoutDigest = {
		schemaVersion: 1 as const,
		sources: loadedPolicies.map(policy => policy.source),
		maxChangedFiles: minimum([
			config.limits.maxChangedFiles,
			...definedNumbers(loadedPolicies, 'maxChangedFiles'),
		]),
		maxIterations: minimum([
			task.maxIterations,
			...definedNumbers(loadedPolicies, 'maxIterations'),
		]),
		maxTaskSeconds: minimum([
			task.timeoutSeconds,
			...definedNumbers(loadedPolicies, 'maxTaskSeconds'),
		]),
		allowNetwork: task.allowNetwork && loadedPolicies.every(
			policy => policy.document.allowNetwork !== false,
		),
		prohibitedPaths,
		routing: {
			requiredCapabilities: [...routing.requiredCapabilities],
			maxCostTier: routing.maxCostTier,
			maxLatencyTier: routing.maxLatencyTier,
			allowFallback: routing.allowFallback,
			maxAttempts: routing.maxAttempts,
		},
	}
	const policy: ResolvedPolicy = {
		...policyWithoutDigest,
		digest: sha256(JSON.stringify(policyWithoutDigest)),
	}

	return {
		...task,
		prohibitedPaths,
		maxIterations: policy.maxIterations,
		timeoutSeconds: policy.maxTaskSeconds,
		allowNetwork: policy.allowNetwork,
		routing,
		policy,
	}
}

export function isResolvedPolicy(value: unknown): value is ResolvedPolicy {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			'schemaVersion',
			'digest',
			'sources',
			'maxChangedFiles',
			'maxIterations',
			'maxTaskSeconds',
			'allowNetwork',
			'prohibitedPaths',
			'routing',
		]) ||
		value['schemaVersion'] !== 1 ||
		typeof value['digest'] !== 'string' ||
		!/^[a-f0-9]{64}$/i.test(value['digest']) ||
		!isPolicySources(value['sources']) ||
		!isIntegerInRange(value['maxChangedFiles'], 1, 10_000) ||
		!isIntegerInRange(value['maxIterations'], 1, 64) ||
		!isIntegerInRange(value['maxTaskSeconds'], 1, 3_600) ||
		typeof value['allowNetwork'] !== 'boolean' ||
		!isBoundedStringArray(value['prohibitedPaths'], 300, 1_024) ||
		!isResolvedRouting(value['routing'])
	) {
		return false
	}

	const { digest, ...withoutDigest } = value
	return digest === sha256(JSON.stringify(withoutDigest))
}

async function loadPolicies(
	config: HarnessConfig,
	repositoryPath: string,
	baseCommit: string,
): Promise<Array<LoadedPolicy>> {
	const policies: Array<LoadedPolicy> = []
	if (config.policy.organizationPolicyPath !== null) {
		const contents = await readOrganizationPolicy(
			config.policy.organizationPolicyPath,
		)
		policies.push({
			document: parsePolicyDocument(contents, 'organization policy'),
			source: {
				scope: 'organization',
				location: 'AGENT_OS_ORGANIZATION_POLICY_PATH',
				sha256: sha256(contents),
			},
		})
	}

	const repositoryPolicy = await readRegularFileAtCommit(
		repositoryPath,
		baseCommit,
		repositoryPolicyPath,
		maxPolicyBytes,
	)
	if (repositoryPolicy !== null) {
		policies.push({
			document: parsePolicyDocument(
				repositoryPolicy.contents,
				'repository policy',
			),
			source: {
				scope: 'repository',
				location: repositoryPolicyPath,
				sha256: sha256(repositoryPolicy.contents),
			},
		})
	}

	return policies
}

async function readOrganizationPolicy(policyPath: string): Promise<string> {
	let handle: Awaited<ReturnType<typeof open>>
	try {
		handle = await open(policyPath, constants.O_RDONLY | noFollowFlag)
	} catch (error) {
		throw new HarnessError(
			'POLICY_READ_FAILED',
			'Organization policy could not be opened as a regular non-symlink file',
			{ cause: error instanceof Error ? error.message : String(error) },
		)
	}

	try {
		const stats = await handle.stat()
		const mode = typeof stats.mode === 'bigint' ? Number(stats.mode) : stats.mode
		if (!stats.isFile() || stats.nlink !== 1 || (mode & 0o022) !== 0) {
			throw new HarnessError(
				'INVALID_POLICY_FILE',
				'Organization policy must be a regular file with one link and no group or other write access',
			)
		}
		if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
			throw new HarnessError(
				'INVALID_POLICY_FILE',
				'Organization policy must be owned by the Agent OS user',
			)
		}
		if (stats.size > maxPolicyBytes) {
			throw new HarnessError(
				'POLICY_FILE_TOO_LARGE',
				`Organization policy exceeds the ${maxPolicyBytes}-byte limit`,
			)
		}
		const contents = await handle.readFile()
		if (contents.byteLength > maxPolicyBytes) {
			throw new HarnessError(
				'POLICY_FILE_TOO_LARGE',
				`Organization policy exceeds the ${maxPolicyBytes}-byte limit`,
			)
		}
		try {
			return new TextDecoder('utf-8', {
				fatal: true,
				ignoreBOM: true,
			}).decode(contents)
		} catch {
			throw new HarnessError(
				'INVALID_POLICY_ENCODING',
				'Organization policy must contain valid UTF-8',
			)
		}
	} finally {
		await handle.close()
	}
}

function parsePolicyDocument(contents: string, label: string): PolicyDocument {
	let value: unknown
	try {
		value = JSON.parse(contents)
	} catch {
		throw invalidPolicy(`${label} must contain valid JSON`)
	}
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			'schemaVersion',
			'maxChangedFiles',
			'maxIterations',
			'maxTaskSeconds',
			'allowNetwork',
			'prohibitedPaths',
			'routing',
		]) ||
		value['schemaVersion'] !== 1
	) {
		throw invalidPolicy(`${label} has an invalid schema or unknown fields`)
	}

	return {
		maxChangedFiles: optionalInteger(value['maxChangedFiles'], 1, 10_000, label),
		maxIterations: optionalInteger(value['maxIterations'], 1, 64, label),
		maxTaskSeconds: optionalInteger(value['maxTaskSeconds'], 30, 3_600, label),
		allowNetwork: optionalBoolean(value['allowNetwork'], label),
		prohibitedPaths: optionalStringArray(
			value['prohibitedPaths'],
			100,
			1_024,
			`${label}.prohibitedPaths`,
		),
		routing: parseRoutingConstraints(value['routing'], label),
	}
}

function parseRoutingConstraints(
	value: unknown,
	label: string,
): PolicyRoutingConstraints {
	if (value === undefined) {
		return {
			requiredCapabilities: [],
			maxCostTier: null,
			maxLatencyTier: null,
			allowFallback: null,
			maxAttempts: null,
		}
	}
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, [
			'requiredCapabilities',
			'maxCostTier',
			'maxLatencyTier',
			'allowFallback',
			'maxAttempts',
		])
	) {
		throw invalidPolicy(`${label}.routing has unknown or invalid fields`)
	}

	return {
		requiredCapabilities: parseCapabilities(value['requiredCapabilities'], label),
		maxCostTier: optionalCostTier(value['maxCostTier'], label),
		maxLatencyTier: optionalLatencyTier(value['maxLatencyTier'], label),
		allowFallback: optionalBoolean(value['allowFallback'], `${label}.routing`),
		maxAttempts: optionalInteger(
			value['maxAttempts'],
			1,
			8,
			`${label}.routing`,
		),
	}
}

function effectiveTaskRouting(
	config: HarnessConfig,
	task: WorkerTask,
	policies: Array<LoadedPolicy>,
): WorkerRoutingPolicy {
	const taskRouting = task.routing ?? {
		preferredWorkerId: null,
		requiredCapabilities: [],
		strategy: config.routing.defaultStrategy,
		maxCostTier: null,
		maxLatencyTier: null,
		allowFallback: true,
		maxAttempts: config.routing.maxAttempts,
	}
	return {
		...taskRouting,
		requiredCapabilities: uniqueCapabilities([
			...taskRouting.requiredCapabilities,
			...policies.flatMap(
				policy => policy.document.routing.requiredCapabilities,
			),
		]),
		maxCostTier: strictestCostTier([
			taskRouting.maxCostTier,
			...policies.map(policy => policy.document.routing.maxCostTier),
		]),
		maxLatencyTier: strictestLatencyTier([
			taskRouting.maxLatencyTier,
			...policies.map(policy => policy.document.routing.maxLatencyTier),
		]),
		allowFallback: taskRouting.allowFallback && policies.every(
			policy => policy.document.routing.allowFallback !== false,
		),
		maxAttempts: minimum([
			taskRouting.maxAttempts,
			...policies.flatMap(policy =>
				policy.document.routing.maxAttempts === null
					? []
					: [policy.document.routing.maxAttempts],
			),
		]),
	}
}

function definedNumbers(
	policies: Array<LoadedPolicy>,
	field: 'maxChangedFiles' | 'maxIterations' | 'maxTaskSeconds',
): Array<number> {
	return policies.flatMap(policy => {
		const value = policy.document[field]
		return value === null ? [] : [value]
	})
}

function strictestCostTier(
	values: Array<WorkerCostTier | null>,
): WorkerCostTier | null {
	const tiers: Array<WorkerCostTier> = ['low', 'medium', 'high']
	return strictestTier(values, tiers)
}

function strictestLatencyTier(
	values: Array<WorkerLatencyTier | null>,
): WorkerLatencyTier | null {
	const tiers: Array<WorkerLatencyTier> = ['fast', 'standard', 'slow']
	return strictestTier(values, tiers)
}

function strictestTier<Tier extends string>(
	values: Array<Tier | null>,
	orderedTiers: Array<Tier>,
): Tier | null {
	const present = values.filter((value): value is Tier => value !== null)
	if (present.length === 0) {
		return null
	}
	return present.reduce((strictest, value) =>
		orderedTiers.indexOf(value) < orderedTiers.indexOf(strictest)
			? value
			: strictest,
	)
}

function parseCapabilities(value: unknown, label: string): Array<WorkerCapability> {
	if (value === undefined) {
		return []
	}
	if (!Array.isArray(value) || value.length > 16) {
		throw invalidPolicy(`${label}.routing.requiredCapabilities is invalid`)
	}
	const capabilities = value.filter(isWorkerCapability)
	if (
		capabilities.length !== value.length ||
		new Set(capabilities).size !== capabilities.length
	) {
		throw invalidPolicy(`${label}.routing.requiredCapabilities is invalid`)
	}
	return capabilities
}

function optionalStringArray(
	value: unknown,
	maxItems: number,
	maxItemLength: number,
	label: string,
): Array<string> {
	if (value === undefined) {
		return []
	}
	if (!isBoundedStringArray(value, maxItems, maxItemLength)) {
		throw invalidPolicy(`${label} is invalid`)
	}
	return uniqueStrings(value)
}

function optionalInteger(
	value: unknown,
	minimum: number,
	maximum: number,
	label: string,
): number | null {
	if (value === undefined) {
		return null
	}
	if (!isIntegerInRange(value, minimum, maximum)) {
		throw invalidPolicy(`${label} contains an out-of-range integer`)
	}
	return value
}

function optionalBoolean(value: unknown, label: string): boolean | null {
	if (value === undefined) {
		return null
	}
	if (typeof value !== 'boolean') {
		throw invalidPolicy(`${label} contains a non-boolean constraint`)
	}
	return value
}

function optionalCostTier(value: unknown, label: string): WorkerCostTier | null {
	if (value === undefined) {
		return null
	}
	if (value !== 'low' && value !== 'medium' && value !== 'high') {
		throw invalidPolicy(`${label}.routing.maxCostTier is invalid`)
	}
	return value
}

function optionalLatencyTier(
	value: unknown,
	label: string,
): WorkerLatencyTier | null {
	if (value === undefined) {
		return null
	}
	if (value !== 'fast' && value !== 'standard' && value !== 'slow') {
		throw invalidPolicy(`${label}.routing.maxLatencyTier is invalid`)
	}
	return value
}

function isPolicySources(value: unknown): value is Array<PolicySource> {
	return Array.isArray(value) &&
		value.length <= 2 &&
		value.every(source =>
			isRecord(source) &&
			hasExactKeys(source, ['scope', 'location', 'sha256']) &&
			(source['scope'] === 'organization' || source['scope'] === 'repository') &&
			typeof source['location'] === 'string' &&
			source['location'].length >= 1 &&
			source['location'].length <= 64 &&
			typeof source['sha256'] === 'string' &&
			/^[a-f0-9]{64}$/i.test(source['sha256']),
		) &&
		new Set(value.map(source => source.scope)).size === value.length &&
		(value.length < 2 ||
			(value[0]?.scope === 'organization' && value[1]?.scope === 'repository'))
}

function isResolvedRouting(value: unknown): boolean {
	return isRecord(value) &&
		hasExactKeys(value, [
			'requiredCapabilities',
			'maxCostTier',
			'maxLatencyTier',
			'allowFallback',
			'maxAttempts',
		]) &&
		Array.isArray(value['requiredCapabilities']) &&
		value['requiredCapabilities'].length <= 16 &&
		value['requiredCapabilities'].every(isWorkerCapability) &&
		new Set(value['requiredCapabilities']).size ===
			value['requiredCapabilities'].length &&
		(value['maxCostTier'] === null ||
			value['maxCostTier'] === 'low' ||
			value['maxCostTier'] === 'medium' ||
			value['maxCostTier'] === 'high') &&
		(value['maxLatencyTier'] === null ||
			value['maxLatencyTier'] === 'fast' ||
			value['maxLatencyTier'] === 'standard' ||
			value['maxLatencyTier'] === 'slow') &&
		typeof value['allowFallback'] === 'boolean' &&
		isIntegerInRange(value['maxAttempts'], 1, 8)
}

function isWorkerCapability(value: unknown): value is WorkerCapability {
	return value === 'research' ||
		value === 'implementation' ||
		value === 'testing' ||
		value === 'review' ||
		value === 'tool-calling' ||
		value === 'long-context' ||
		value === 'private'
}

function isBoundedStringArray(
	value: unknown,
	maxItems: number,
	maxItemLength: number,
): value is Array<string> {
	return Array.isArray(value) &&
		value.length <= maxItems &&
		value.every(item =>
			typeof item === 'string' &&
			item.length >= 1 &&
			item.length <= maxItemLength &&
			!item.includes('\0'),
		)
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
	return Number.isInteger(value) &&
		(value as number) >= minimum &&
		(value as number) <= maximum
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Array<string>): boolean {
	const allowedKeys = new Set(allowed)
	return Object.keys(value).every(key => allowedKeys.has(key))
}

function hasExactKeys(value: Record<string, unknown>, expected: Array<string>): boolean {
	return Object.keys(value).length === expected.length &&
		expected.every(key => Object.hasOwn(value, key))
}

function minimum(values: Array<number>): number {
	return Math.min(...values)
}

function uniqueStrings(values: Array<string>): Array<string> {
	return [...new Set(values)]
}

function uniqueCapabilities(
	values: Array<WorkerCapability>,
): Array<WorkerCapability> {
	return [...new Set(values)]
}

function invalidPolicy(message: string): HarnessError {
	return new HarnessError('INVALID_POLICY', message)
}

function sha256(value: string | Buffer): string {
	return createHash('sha256').update(value).digest('hex')
}
