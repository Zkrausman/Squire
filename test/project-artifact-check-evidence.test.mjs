import test from 'node:test';
import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join} from 'node:path';
import {
  DESKTOP_READINESS_COMPANION_PATHS
} from '../src/desktop-readiness-evidence.mjs';
import {
  DESKTOP_CODEGEN_SOURCE_FILES,
  DESKTOP_CODEGEN_INTENT,
  PROJECT_ENVIRONMENT_POLICY,
  PROJECT_SOURCE_ROOT
} from '../src/project-configuration.mjs';
import {
  DESKTOP_PREFIX_IDENTITY,
  DESKTOP_TARGET
} from '../src/desktop-profile.mjs';
import {
  PROJECT_CODING_OBSERVATION_PROFILE,
  PROJECT_LARGE_OBSERVATION_CONFIG_SCHEMA,
  PROJECT_OUTPUT_LARGE_PROFILE
} from '../src/project-coding-profile.mjs';
import {
  GENERATION_SHUTDOWN, NODE_RUNTIME, canonicalBytes, hash, verifyExactFile
} from '../src/bounded-codegen-plan.mjs';
import {RETENTION_POLICY} from '../src/local-rejected-retention.mjs';
import {
  ProjectArtifactCheckValidationError,
  captureProjectArtifactCheckData,
  captureProjectArtifactCheckReceipt,
  encodeProjectArtifactCheckSidecar,
  projectArtifactSubsetHash,
  resolveProjectArtifactChecksWithPorts,
  validateProjectArtifactCheckContext,
  verifyProjectArtifactFilesWithPorts,
  verifyProjectArtifactStageWithPorts
} from '../src/project-artifact-check-evidence.mjs';
import {planLargeProjectStaging} from '../src/multifile-staging.mjs';

const encoder = new TextEncoder();
const uuid = '10000000-0000-4000-8000-000000000001';
const uuid2 = '20000000-0000-4000-8000-000000000002';
const copy = value => structuredClone(value);
const sorted = values => [...values].sort();
const PROJECT_SCOPE = '/synthetic/task';

function makeDescriptor() {
  return {
    status: 'NOT_QUALIFIED',
    executable: {path: '/synthetic/gjs', bytes: 10, sha256: 'a'.repeat(64)},
    typelibs: [{
      namespace: 'Gtk', version: '4.0', typelib: '/synthetic/Gtk.typelib',
      bytes: 11, sha256: 'b'.repeat(64)
    }],
    libraries: [{
      name: 'gtk', path: '/synthetic/libgtk.so', bytes: 12, sha256: 'c'.repeat(64)
    }]
  };
}

// Accepted synthetic makeConfig fixture shape supplied with the work order.
function makeConfig({
  jobId = uuid,
  scope = PROJECT_SCOPE,
  desktopRuntimeIdentity = makeDescriptor()
} = {}) {
  const source_pins = Object.fromEntries(
    DESKTOP_CODEGEN_SOURCE_FILES.map(relative => [
      join(PROJECT_SOURCE_ROOT, relative),
      {bytes: 1, sha256: 'd'.repeat(64)}
    ])
  );
  return {
    schema: PROJECT_LARGE_OBSERVATION_CONFIG_SCHEMA,
    runtime_admitted: false,
    provider_id: 'native_codex',
    job_id: jobId,
    scope,
    source_commit: 'e'.repeat(40),
    source_pins,
    node: copy(NODE_RUNTIME),
    codex: {
      path: '/synthetic/codex', version: '0.160.0',
      bytes: 10, sha256: 'f'.repeat(64)
    },
    requested_model: 'synthetic-model',
    effort: 'medium',
    authorization: {
      operator_receipt: '/synthetic/operator',
      supported_tuples: [{model: 'synthetic-model', effort: 'medium'}]
    },
    permissions: {
      sandbox: 'read-only',
      approval_mode: 'on-request',
      output_contract: 'CODEX_JSONL_SINGLE_AGENT_V1'
    },
    prompt: {path: '/synthetic/prompt', bytes: 1076, sha256: '1'.repeat(64)},
    target_mode: {mode: 'multifile_stage', stage_subpath: 'stage'},
    diagnostic_retention: copy(RETENTION_POLICY),
    generation_shutdown: copy(GENERATION_SHUTDOWN),
    preflight_freshness_ms: 300000,
    outer_observation_ms: null,
    generation_wall_ms: null,
    max_direct_child_spawns: 1,
    environment_policy: copy(PROJECT_ENVIRONMENT_POLICY),
    operation_intent: DESKTOP_CODEGEN_INTENT,
    runtime_target: DESKTOP_TARGET,
    prefix_identity: copy(DESKTOP_PREFIX_IDENTITY),
    desktop_runtime_identity: copy(desktopRuntimeIdentity),
    execution_profile: copy(PROJECT_CODING_OBSERVATION_PROFILE),
    output_profile: copy(PROJECT_OUTPUT_LARGE_PROFILE)
  };
}

function makeArtifact({
  artifact_id, role, root, relative_path, byte_count = 10,
  sha256 = 'a'.repeat(64), staged_artifact_id = null
}) {
  return {
    artifact_id, role, root, relative_path, byte_count, sha256,
    staged_artifact_id
  };
}

function makeCheck(check_id, artifact_ids, options = {}) {
  const definitionBytes = options.definitionBytes ??
    encoder.encode('synthetic check definition');
  return {
    check_id,
    definition_pin: {
      path: options.definitionPath ??
        `/synthetic/evidence/${check_id}.definition`,
      bytes: options.definitionBytesCount ?? definitionBytes.length,
      sha256: options.definitionSha256 ?? hash(definitionBytes)
    },
    receipt_pin: {
      path: options.receiptPath ?? `/synthetic/evidence/${check_id}.receipt`,
      bytes: 1,
      sha256: 'f'.repeat(64)
    },
    observer_role: 'trusted_owner_fixture',
    artifact_ids: sorted(artifact_ids)
  };
}

function makeFixture(options = {}) {
  const config = options.config ?? makeConfig(options.configOptions);
  const configBytes = options.configBytes ??
    encoder.encode(JSON.stringify(config));
  const stageRoot = join(
    config.scope, 'output', `run-${config.job_id}`, 'stage'
  );
  const artifacts = options.artifacts ?? [
    makeArtifact({
      artifact_id: 'app-main', role: 'staged', root: stageRoot,
      relative_path: 'src/app.js'
    }),
    makeArtifact({
      artifact_id: 'app-copy', role: 'delivered_copy',
      root: '/synthetic/delivery', relative_path: 'app.js',
      staged_artifact_id: 'app-main'
    })
  ];
  const artifactIds = sorted(artifacts.map(item => item.artifact_id));
  const definitionBytes = options.definitionBytes ??
    encoder.encode('synthetic check definition');
  const checks = options.checks ??
    [makeCheck('check-main', artifactIds, {definitionBytes})];
  const sourceBytes = options.sourceBytes ?? 1;
  const context = {
    schema: 'squire.project_artifact_check_context.v2',
    operation_config_sha256: hash(configBytes),
    job_id: config.job_id,
    candidate: {
      source_commit: config.source_commit,
      stage_root: stageRoot,
      stage_operation_id: `stage-${config.job_id}`,
      stage_manifest_sha256: 'b'.repeat(64)
    },
    artifacts: copy(artifacts),
    required_checks: copy(checks),
    observer_policy_sha256: 'c'.repeat(64),
    companion_source_pins: Object.fromEntries(
      DESKTOP_READINESS_COMPANION_PATHS.map(relative => [
        relative, {bytes: sourceBytes, sha256: 'd'.repeat(64)}
      ])
    )
  };
  return {
    config, configBytes, context, definitionBytes,
    contextBytes: encoder.encode(JSON.stringify(context))
  };
}

function paddedJson(value, length) {
  const text = JSON.stringify(value);
  const bytes = encoder.encode(text);
  if (bytes.length > length) throw new Error('FIXTURE_SIZE');
  const output = new Uint8Array(length);
  output.set(bytes);
  output.fill(0x20, bytes.length);
  return output;
}

function captureFixture(fixture) {
  fixture.contextBytes = encoder.encode(JSON.stringify(fixture.context));
  return captureProjectArtifactCheckData({
    configBytes: fixture.configBytes,
    artifactContextBytes: fixture.contextBytes
  });
}

function terminal(overrides = {}) {
  return {
    process: {
      pid: 303, start_ticks: '17',
      boot_id: '00000000-0000-0000-0000-000000000001'
    },
    started_at_ms: 10,
    ended_at_ms: 20,
    direct_child_exit_observed: true,
    exit_kind: 'natural',
    exit_code: 0,
    signal: null,
    stdout_eof: true,
    stderr_eof: true,
    stop_codes: [],
    cleanup_codes: [],
    descendant_guarantee: 'NOT_ESTABLISHED',
    ...copy(overrides)
  };
}

function makeReceiptBundle(fixture, changes = {}, options = {}) {
  const captured = captureFixture(fixture);
  const check = captured.context.required_checks[0];
  const receipt = {
    schema: 'squire.project_artifact_check_receipt.v2',
    check_id: check.check_id,
    definition_sha256: check.definition_pin.sha256,
    job_id: captured.context.job_id,
    operation_config_sha256: captured.operation_config_sha256,
    stage_manifest_sha256:
      captured.context.candidate.stage_manifest_sha256,
    artifact_subset_sha256:
      projectArtifactSubsetHash(captured, check.check_id),
    observer_policy_sha256: captured.context.observer_policy_sha256,
    observer_role: 'trusted_owner_fixture',
    status: 'passed',
    reason: 'NONE',
    terminal: terminal(),
    limitations: []
  };
  Object.assign(receipt, copy(changes));
  let receiptBytes = encoder.encode(JSON.stringify(receipt));
  if (options.receiptLength !== undefined) {
    receiptBytes = paddedJson(receipt, options.receiptLength);
  }
  fixture.context.required_checks[0].receipt_pin = {
    ...fixture.context.required_checks[0].receipt_pin,
    bytes: receiptBytes.length,
    sha256: hash(receiptBytes)
  };
  const reboundCapture = captureFixture(fixture);
  return {
    captured: reboundCapture, receipt, receiptBytes,
    definitionBytes: fixture.definitionBytes
  };
}

function expectCode(code, fn) {
  assert.throws(fn, error =>
    error instanceof ProjectArtifactCheckValidationError &&
    error.code === code && error.message === code
  );
}

function expectInvalidContext(fn) {
  expectCode('INVALID_ARTIFACT_CONTEXT', fn);
}

const ARTIFACT_FILE_TEST_UID = 71;
const ARTIFACT_FILE_TEST_CAP = 67_108_864;

function repeatedByteSha(byte, length) {
  const digest = createHash('sha256');
  const block = new Uint8Array(65_536).fill(byte);
  let remaining = length;
  while (remaining > 0) {
    const count = Math.min(block.length, remaining);
    digest.update(block.subarray(0, count));
    remaining -= count;
  }
  return digest.digest('hex');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

function observeGateOrSettlement(pending, gate) {
  const settled = pending.then(
    value => ({ok: true, value}),
    error => ({ok: false, error})
  );
  const observed = Promise.race([
    gate.promise.then(() => ({kind: 'entered'})),
    settled.then(outcome => ({kind: 'settled', outcome}))
  ]);
  return {observed, settled};
}

function fakeArtifactStat(
  node, overrides = {}, uid = ARTIFACT_FILE_TEST_UID
) {
  return {
    dev: 1n,
    ino: node.ino,
    size: BigInt(node.kind === 'file'
      ? node.statSize ?? node.length
      : 1),
    mtimeNs: node.mtimeNs ?? 2n,
    ctimeNs: 3n,
    mode: node.kind === 'file' ? 0o100600n : 0o040700n,
    uid: BigInt(uid),
    nlink: 1n,
    isFile() { return node.kind === 'file'; },
    isDirectory() { return node.kind === 'directory'; },
    isSymbolicLink() { return false; },
    ...overrides
  };
}

function makeArtifactFileSystem(fileSpecs, hooks = {}) {
  const nodes = new Map();
  const ownerUid = hooks.uid ?? ARTIFACT_FILE_TEST_UID;
  let nextInode = 10n;
  const addDirectory = path => {
    const prior = nodes.get(path);
    if (prior) return prior;
    const node = {kind: 'directory', ino: nextInode++};
    nodes.set(path, node);
    return node;
  };
  const filesByPath = new Map();
  for (const spec of fileSpecs) {
    addDirectory(spec.root);
    const parts = spec.relative_path.split('/');
    for (let index = 1; index < parts.length; index++) {
      addDirectory(join(spec.root, ...parts.slice(0, index)));
    }
    const path = join(spec.root, ...parts);
    const node = {
      kind: 'file',
      ino: nextInode++,
      length: spec.payload.length,
      byteValue: spec.payload.byteValue,
      bytes: spec.payload.bytes ?? null
    };
    nodes.set(path, node);
    filesByPath.set(spec.artifact_id, path);
  }

  const calls = {
    lstat: [],
    realpath: [],
    open: [],
    handleStat: [],
    read: [],
    close: [],
    payloadBytes: 0,
    requestedBytes: 0,
    eofReads: 0
  };
  const lstatCounts = new Map();
  const handleStatCounts = new Map();
  const enoent = () => Object.assign(new Error('synthetic missing path'), {
    code: 'ENOENT'
  });
  const fs = {
    async lstat(path, ...args) {
      calls.lstat.push({path, args});
      if (hooks.beforeLstat) await hooks.beforeLstat(path, calls);
      const node = nodes.get(path);
      if (!node) throw enoent();
      const count = (lstatCounts.get(path) ?? 0) + 1;
      lstatCounts.set(path, count);
      const stat = fakeArtifactStat(node, {}, ownerUid);
      if (hooks.lstat) {
        const replacement = hooks.lstat(path, count, stat, calls);
        if (replacement !== undefined) return replacement;
      }
      return stat;
    },
    async realpath(path, ...args) {
      calls.realpath.push({path, args});
      if (hooks.realpath) {
        const replacement = await hooks.realpath(path, calls);
        if (replacement !== undefined) return replacement;
      }
      return path;
    },
    async open(path, flags, ...args) {
      calls.open.push({path, flags, args});
      const node = nodes.get(path);
      if (!node || node.kind !== 'file') throw enoent();
      const handle = {
        async stat(...statArgs) {
          calls.handleStat.push({path, args: statArgs});
          const count = (handleStatCounts.get(path) ?? 0) + 1;
          handleStatCounts.set(path, count);
          const stat = fakeArtifactStat(node, {}, ownerUid);
          if (hooks.handleStat) {
            const replacement = hooks.handleStat(
              path, count, stat, calls
            );
            if (replacement !== undefined) return replacement;
          }
          return stat;
        },
        async read(buffer, offset, length, position) {
          const record = {path, buffer, offset, length, position};
          calls.read.push({path, offset, length, position});
          calls.requestedBytes += length;
          if (position >= node.length) calls.eofReads++;
          const defaultRead = () => {
            if (position >= node.length && hooks.extraByteAtEof) {
              buffer[offset] = node.byteValue ?? 0;
              return {bytesRead: 1};
            }
            const remaining = Math.max(0, node.length - position);
            const maxChunk = hooks.maxReadChunk ?? Number.MAX_SAFE_INTEGER;
            const bytesRead = Math.min(length, remaining, maxChunk);
            if (bytesRead > 0) {
              if (node.bytes) {
                buffer.set(
                  node.bytes.subarray(position, position + bytesRead),
                  offset
                );
              } else {
                buffer.fill(node.byteValue ?? 0, offset, offset + bytesRead);
              }
            }
            return {bytesRead};
          };
          const result = hooks.read
            ? await hooks.read(record, defaultRead, calls)
            : defaultRead();
          if (result && Number.isSafeInteger(result.bytesRead) &&
              result.bytesRead > 0 && position < node.length) {
            calls.payloadBytes += result.bytesRead;
          }
          return result;
        },
        async close() {
          calls.close.push(path);
          if (hooks.close) await hooks.close(path, calls);
        }
      };
      if (hooks.open) {
        const replacement = await hooks.open(path, flags, handle, calls);
        if (replacement !== undefined) return replacement;
      }
      return handle;
    }
  };
  return {fs, uid: ownerUid, calls, nodes, filesByPath};
}

function makeArtifactFilesFixture(specifications, hooks = {}) {
  const config = makeConfig();
  const stageRoot = join(
    config.scope, 'output', `run-${config.job_id}`, 'stage'
  );
  const fileSpecs = specifications.map(specification => {
    const payload = specification.payload instanceof Uint8Array
      ? {
        bytes: new Uint8Array(specification.payload),
        length: specification.payload.length,
        byteValue: specification.payload[0] ?? 0,
        sha256: hash(specification.payload)
      }
      : {
        bytes: null,
        length: specification.payload.length,
        byteValue: specification.payload.byteValue ?? 0,
        sha256: specification.payload.sha256 ??
          repeatedByteSha(
            specification.payload.byteValue ?? 0,
            specification.payload.length
          )
      };
    const root = specification.root === undefined ||
      specification.root === 'stage'
      ? stageRoot
      : specification.root;
    return {
      artifact_id: specification.artifact_id,
      role: specification.role,
      root,
      relative_path: specification.relative_path,
      byte_count: specification.declaredByteCount ?? payload.length,
      sha256: specification.declaredSha256 ?? payload.sha256,
      staged_artifact_id:
        specification.staged_artifact_id ?? null,
      payload
    };
  });
  const artifacts = fileSpecs.map(spec => makeArtifact({
    artifact_id: spec.artifact_id,
    role: spec.role,
    root: spec.root,
    relative_path: spec.relative_path,
    byte_count: spec.byte_count,
    sha256: spec.sha256,
    staged_artifact_id: spec.staged_artifact_id
  }));
  const checks = [makeCheck(
    'check-files',
    artifacts.map(artifact => artifact.artifact_id)
  )];
  const fixture = makeFixture({config, artifacts, checks});
  const captured = captureFixture(fixture);
  const fake = makeArtifactFileSystem(fileSpecs, hooks);
  return {
    fixture,
    captured,
    ports: {fs: fake.fs, uid: fake.uid},
    fake,
    stageRoot,
    fileSpecs
  };
}

function assertArtifactFileFailure(result, reason, ioFailures) {
  assert.equal(result.verification_scope, 'ARTIFACT_FILES_ONLY');
  assert.equal(result.verified, false);
  assert.deepEqual(result.artifact_witness, []);
  assert.deepEqual(result.io_failures, ioFailures);
  assert.equal(result.reason, reason);
}

test('captures independent frozen synthetic context and pinned config data', () => {
  const fixture = makeFixture();
  const validated = validateProjectArtifactCheckContext(fixture.context);
  const originalConfigHash = hash(fixture.configBytes);
  const originalContextHash = hash(fixture.contextBytes);
  const captured = captureFixture(fixture);
  fixture.context.candidate.stage_root = '/synthetic/changed';
  assert.equal(hash(fixture.configBytes), originalConfigHash);
  assert.equal(hash(fixture.contextBytes), originalContextHash);
  assert.equal(validated.candidate.stage_root, captured.context.candidate.stage_root);
  assert.equal(captured.operation_config_sha256, originalConfigHash);
  assert.equal(captured.validation_scope, 'PURE_DATA_ONLY');
  assert.ok(Object.isFrozen(captured));
  assert.ok(Object.isFrozen(captured.config));
  assert.ok(Object.isFrozen(captured.context));
  assert.ok(Object.isFrozen(captured.context.artifacts[0]));
  assert.ok(Object.isFrozen(captured.context.required_checks[0].definition_pin));
});

test('binds exact config bytes rather than semantic JSON equivalence', () => {
  const fixture = makeFixture();
  const original = captureFixture(fixture);
  const changedBytes = new Uint8Array(fixture.configBytes.length + 1);
  changedBytes.set(fixture.configBytes);
  changedBytes[changedBytes.length - 1] = 0x20;
  expectInvalidContext(() => captureProjectArtifactCheckData({
    configBytes: changedBytes,
    artifactContextBytes: fixture.contextBytes
  }));

  fixture.configBytes = changedBytes;
  fixture.context.operation_config_sha256 = hash(changedBytes);
  const rebound = captureFixture(fixture);
  assert.notEqual(rebound.operation_config_sha256, original.operation_config_sha256);
  assert.notEqual(
    projectArtifactSubsetHash(rebound, 'check-main'),
    projectArtifactSubsetHash(original, 'check-main')
  );
});

test('isolates config, job, source, stage operation, and derived stage-root bindings', () => {
  const mutations = [
    context => { context.operation_config_sha256 = '9'.repeat(64); },
    context => { context.job_id = uuid2; },
    context => { context.candidate.source_commit = '8'.repeat(40); },
    context => { context.candidate.stage_operation_id += '-other'; }
  ];
  for (const mutate of mutations) {
    const fixture = makeFixture();
    mutate(fixture.context);
    assert.doesNotThrow(() =>
      validateProjectArtifactCheckContext(fixture.context)
    );
    expectInvalidContext(() => captureFixture(fixture));
  }

  const alternate = makeFixture();
  alternate.context.candidate.stage_root += '-alternate';
  for (const artifact of alternate.context.artifacts) {
    if (artifact.role === 'staged') {
      artifact.root = alternate.context.candidate.stage_root;
    }
  }
  assert.doesNotThrow(() =>
    validateProjectArtifactCheckContext(alternate.context)
  );
  expectInvalidContext(() => captureFixture(alternate));
});

test('enforces closed context, candidate, artifact, check, and pin records', () => {
  const mutations = [
    context => { context.extra = true; },
    context => { context.candidate.extra = true; },
    context => { context.artifacts[0].extra = true; },
    context => { context.required_checks[0].extra = true; },
    context => { context.required_checks[0].definition_pin.extra = true; },
    context => { context.required_checks[0].receipt_pin.extra = true; },
    context => { context.companion_source_pins['src/extra.mjs'] = {
      bytes: 1, sha256: 'd'.repeat(64)
    }; }
  ];
  for (const mutate of mutations) {
    const fixture = makeFixture();
    mutate(fixture.context);
    expectInvalidContext(() =>
      validateProjectArtifactCheckContext(fixture.context)
    );
  }
});

test('rejects proxies, getters, and custom prototypes without invoking traps', () => {
  const fixture = makeFixture();
  let traps = 0;
  const proxy = new Proxy(fixture.context, {
    ownKeys(target) {
      traps++;
      return Reflect.ownKeys(target);
    },
    getPrototypeOf(target) {
      traps++;
      return Reflect.getPrototypeOf(target);
    }
  });
  expectInvalidContext(() => validateProjectArtifactCheckContext(proxy));
  assert.equal(traps, 0);

  let getterCalls = 0;
  const getterContext = copy(fixture.context);
  Object.defineProperty(getterContext.candidate, 'stage_root', {
    enumerable: true,
    get() {
      getterCalls++;
      return '/synthetic/task/output/run-id/stage';
    }
  });
  expectInvalidContext(() =>
    validateProjectArtifactCheckContext(getterContext)
  );
  assert.equal(getterCalls, 0);

  const custom = Object.assign(Object.create({marker: true}), fixture.context);
  expectInvalidContext(() => validateProjectArtifactCheckContext(custom));
});

test('rejects unsafe numbers, sparse arrays, and reserved data keys', () => {
  for (const value of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const fixture = makeFixture();
    fixture.context.artifacts[0].byte_count = value;
    expectInvalidContext(() =>
      validateProjectArtifactCheckContext(fixture.context)
    );
  }

  const sparse = makeFixture();
  sparse.context.artifacts = new Array(2);
  sparse.context.artifacts[0] = makeArtifact({
    artifact_id: 'app-main', role: 'staged',
    root: sparse.context.candidate.stage_root,
    relative_path: 'src/app.js'
  });
  expectInvalidContext(() =>
    validateProjectArtifactCheckContext(sparse.context)
  );

  const reserved = makeFixture();
  Object.defineProperty(reserved.context.artifacts[0], '__proto__', {
    value: 'synthetic', enumerable: true
  });
  expectInvalidContext(() =>
    validateProjectArtifactCheckContext(reserved.context)
  );
});

test('applies exact approved relative bounds and preserves case-distinct identities', () => {
  for (const relative of [
    'resume-é.js',
    'a/b/c/d/e/f/g/h',
    'a'.repeat(65),
    'é'.repeat(128),
    Array.from({length: 16}, () => 'x').join('/')
  ]) {
    const fixture = makeFixture();
    fixture.context.artifacts[0].relative_path = relative;
    assert.doesNotThrow(() =>
      validateProjectArtifactCheckContext(fixture.context)
    );
  }

  for (const relative of [
    'a'.repeat(257),
    Array.from({length: 17}, () => 'x').join('/'),
    'src/../escape.js',
    'src//empty.js',
    '/absolute.js',
    'C:/drive.js',
    'src/back\\slash.js',
    'src/line\nbreak.js',
    '   '
  ]) {
    const fixture = makeFixture();
    fixture.context.artifacts[0].relative_path = relative;
    expectInvalidContext(() =>
      validateProjectArtifactCheckContext(fixture.context)
    );
  }

  const caseDistinct = makeFixture();
  caseDistinct.context.artifacts[0].relative_path = 'src/App.js';
  caseDistinct.context.artifacts[1].root = '/synthetic/Delivery';
  caseDistinct.context.required_checks[0].definition_pin.path =
    '/SYNTHETIC/DELIVERY/check.definition';
  assert.doesNotThrow(() =>
    validateProjectArtifactCheckContext(caseDistinct.context)
  );

  const caseFiles = makeFixture();
  caseFiles.context.artifacts.push(makeArtifact({
    artifact_id: 'app-lower', role: 'staged',
    root: caseFiles.context.candidate.stage_root,
    relative_path: 'src/App.js'
  }));
  assert.doesNotThrow(() =>
    validateProjectArtifactCheckContext(caseFiles.context)
  );
});

test('rejects exact duplicate root and relative path identities', () => {
  const duplicate = makeFixture();
  duplicate.context.artifacts.push(makeArtifact({
    artifact_id: 'app-second', role: 'staged',
    root: duplicate.context.candidate.stage_root,
    relative_path: 'src/app.js'
  }));
  expectInvalidContext(() =>
    validateProjectArtifactCheckContext(duplicate.context)
  );

  const wrongStagedRoot = makeFixture();
  wrongStagedRoot.context.artifacts[0].root = '/synthetic/other-stage';
  expectInvalidContext(() =>
    validateProjectArtifactCheckContext(wrongStagedRoot.context)
  );
});

test('requires delivered copies to bind one byte-identical staged source', () => {
  const mutations = [
    context => { context.artifacts[1].staged_artifact_id = 'missing'; },
    context => { context.artifacts[1].byte_count++; },
    context => { context.artifacts[1].sha256 = '9'.repeat(64); },
    context => {
      context.artifacts[1].root = context.artifacts[0].root;
      context.artifacts[1].relative_path =
        context.artifacts[0].relative_path;
    },
    context => {
      context.artifacts.push(makeArtifact({
        artifact_id: 'copy-of-copy', role: 'delivered_copy',
        root: '/synthetic/delivery-two', relative_path: 'app.js',
        staged_artifact_id: 'app-copy'
      }));
    },
    context => { context.artifacts[1].transform = 'synthetic-transform'; }
  ];
  for (const mutate of mutations) {
    const fixture = makeFixture();
    mutate(fixture.context);
    expectInvalidContext(() =>
      validateProjectArtifactCheckContext(fixture.context)
    );
  }
});

test('enforces artifact and required-check counts, payload totals, and sorted subsets', () => {
  const config = makeConfig();
  const stageRoot = join(config.scope, 'output', `run-${config.job_id}`, 'stage');
  const sixteen = Array.from({length: 16}, (_, index) =>
    makeArtifact({
      artifact_id: `artifact-${String(index).padStart(2, '0')}`,
      role: 'staged', root: stageRoot,
      relative_path: `src/file-${String(index).padStart(2, '0')}.js`,
      byte_count: 1
    })
  );
  const ids = sorted(sixteen.map(item => item.artifact_id));
  const valid16 = makeFixture({
    config, artifacts: sixteen, checks: [makeCheck('check-many', ids)]
  });
  assert.equal(validateProjectArtifactCheckContext(valid16.context).artifacts.length, 16);
  valid16.context.artifacts.push(makeArtifact({
    artifact_id: 'artifact-extra', role: 'staged', root: stageRoot,
    relative_path: 'src/extra.js', byte_count: 1
  }));
  expectInvalidContext(() =>
    validateProjectArtifactCheckContext(valid16.context)
  );

  const payloadAtLimit = makeFixture({
    artifacts: [
      makeArtifact({
        artifact_id: 'large-one', role: 'staged', root: stageRoot,
        relative_path: 'src/one.js', byte_count: 67_108_864
      }),
      makeArtifact({
        artifact_id: 'large-two', role: 'staged', root: stageRoot,
        relative_path: 'src/two.js', byte_count: 67_108_864
      })
    ],
    checks: [makeCheck('check-large', ['large-one', 'large-two'])]
  });
  assert.equal(
    validateProjectArtifactCheckContext(payloadAtLimit.context).artifacts.length,
    2
  );
  payloadAtLimit.context.artifacts[1].byte_count++;
  expectInvalidContext(() =>
    validateProjectArtifactCheckContext(payloadAtLimit.context)
  );

  for (const artifactIds of [
    [], ['app-main', 'app-main'], ['unknown'], ['app-main', 'app-copy']
  ]) {
    const fixture = makeFixture();
    fixture.context.required_checks[0].artifact_ids = artifactIds;
    expectInvalidContext(() =>
      validateProjectArtifactCheckContext(fixture.context)
    );
  }
});

test('enforces four exact companion pins and definition byte ceilings', () => {
  const atSourceLimit = makeFixture({sourceBytes: 1_048_576});
  assert.equal(
    Object.keys(
      validateProjectArtifactCheckContext(atSourceLimit.context)
        .companion_source_pins
    ).length,
    4
  );
  const tooLarge = makeFixture({sourceBytes: 1_048_577});
  expectInvalidContext(() =>
    validateProjectArtifactCheckContext(tooLarge.context)
  );

  const config = makeConfig();
  const stageRoot = join(config.scope, 'output', `run-${config.job_id}`, 'stage');
  const artifact = makeArtifact({
    artifact_id: 'app-main', role: 'staged', root: stageRoot,
    relative_path: 'src/app.js', byte_count: 1
  });
  const checks = Array.from({length: 16}, (_, index) => {
    const id = `check-${String(index).padStart(2, '0')}`;
    return makeCheck(id, ['app-main'], {
      definitionBytesCount: 1_048_576,
      definitionSha256: 'e'.repeat(64)
    });
  });
  const atDefinitionLimit = makeFixture({
    config, artifacts: [artifact], checks
  });
  assert.equal(
    validateProjectArtifactCheckContext(atDefinitionLimit.context)
      .required_checks.length,
    16
  );
  atDefinitionLimit.context.required_checks[0].definition_pin.bytes =
    1_048_577;
  expectInvalidContext(() =>
    validateProjectArtifactCheckContext(atDefinitionLimit.context)
  );
});

test('projects the exact canonical subset digest without roots', () => {
  const fixture = makeFixture();
  const captured = captureFixture(fixture);
  const context = captured.context;
  const expectedArtifacts = context.required_checks[0].artifact_ids.map(id => {
    const artifact = context.artifacts.find(item => item.artifact_id === id);
    return {
      artifact_id: artifact.artifact_id,
      role: artifact.role,
      relative_path: artifact.relative_path,
      byte_count: artifact.byte_count,
      sha256: artifact.sha256,
      staged_artifact_id: artifact.staged_artifact_id
    };
  }).sort((left, right) => left.artifact_id < right.artifact_id ? -1 : 1);
  const expected = hash(canonicalBytes({
    domain: 'squire.project-artifact-check.subset.v2',
    value: {
      job_id: context.job_id,
      operation_config_sha256: captured.operation_config_sha256,
      stage_manifest_sha256: context.candidate.stage_manifest_sha256,
      artifacts: expectedArtifacts
    }
  }));
  assert.equal(projectArtifactSubsetHash(captured, 'check-main'), expected);

  const reordered = makeFixture();
  reordered.context.artifacts.reverse();
  const reorderedCapture = captureFixture(reordered);
  assert.equal(projectArtifactSubsetHash(reorderedCapture, 'check-main'), expected);

  const moved = makeFixture();
  moved.context.artifacts[1].root = '/synthetic/another-delivery';
  const movedCapture = captureFixture(moved);
  assert.equal(projectArtifactSubsetHash(movedCapture, 'check-main'), expected);
});

test('subset binds IDs and operation, job, and manifest data; rejects forged captures', () => {
  const config = makeConfig();
  const stageRoot = join(config.scope, 'output', `run-${config.job_id}`, 'stage');
  const artifacts = [
    makeArtifact({
      artifact_id: 'source', role: 'staged', root: stageRoot,
      relative_path: 'src/app.js'
    }),
    makeArtifact({
      artifact_id: 'copy-a', role: 'delivered_copy',
      root: '/synthetic/delivery-a', relative_path: 'same.js',
      staged_artifact_id: 'source'
    }),
    makeArtifact({
      artifact_id: 'copy-b', role: 'delivered_copy',
      root: '/synthetic/delivery-b', relative_path: 'same.js',
      staged_artifact_id: 'source'
    })
  ];
  const checks = [
    makeCheck('check-a', ['source', 'copy-a']),
    makeCheck('check-b', ['source', 'copy-b'])
  ];
  const fixture = makeFixture({config, artifacts, checks});
  const captured = captureFixture(fixture);
  assert.notEqual(
    projectArtifactSubsetHash(captured, 'check-a'),
    projectArtifactSubsetHash(captured, 'check-b')
  );
  expectCode('BINDING_MISMATCH', () =>
    projectArtifactSubsetHash({...captured}, 'check-a')
  );
  expectCode('BINDING_MISMATCH', () =>
    projectArtifactSubsetHash(captured, 'unknown-check')
  );

  const otherJob = makeFixture({config: makeConfig({jobId: uuid2})});
  const otherCapture = captureFixture(otherJob);
  assert.notEqual(
    projectArtifactSubsetHash(captured, 'check-a'),
    projectArtifactSubsetHash(otherCapture, 'check-main')
  );

  const otherManifest = makeFixture();
  otherManifest.context.candidate.stage_manifest_sha256 = '9'.repeat(64);
  const otherManifestCapture = captureFixture(otherManifest);
  assert.notEqual(
    projectArtifactSubsetHash(captureFixture(makeFixture()), 'check-main'),
    projectArtifactSubsetHash(otherManifestCapture, 'check-main')
  );
});

test('accepts passed, failed, blocked, and not-run receipt data faithfully', () => {
  const allLimitations = [
    'DESCENDANTS_NOT_ESTABLISHED', 'HOST_IO_NOT_PREEMPTIBLE',
    'NATIVE_NOT_EXECUTED_BY_RESOLVER', 'PRODUCT_NOT_EVALUATED',
    'STAGE_ACKNOWLEDGEMENT_UNKNOWN', 'TRUSTED_CALLER_ORIGIN'
  ];
  for (const limitations of [[], ['PRODUCT_NOT_EVALUATED',
    'TRUSTED_CALLER_ORIGIN'], allLimitations]) {
    const bundle = makeReceiptBundle(makeFixture(), {limitations});
    const accepted = captureProjectArtifactCheckReceipt({
      captured: bundle.captured, check_id: 'check-main',
      receiptBytes: bundle.receiptBytes,
      definitionBytes: bundle.definitionBytes
    });
    assert.deepEqual(accepted.receipt.limitations, limitations);
  }

  const passed = makeReceiptBundle(makeFixture());
  const accepted = captureProjectArtifactCheckReceipt({
    captured: passed.captured, check_id: 'check-main',
    receiptBytes: passed.receiptBytes,
    definitionBytes: passed.definitionBytes
  });
  assert.equal(accepted.receipt.status, 'passed');
  assert.equal(accepted.receipt.terminal.exit_code, 0);
  assert.equal(accepted.validation_scope, 'PURE_DATA_ONLY');

  const naturalZero = makeReceiptBundle(makeFixture(), {
    status: 'failed', reason: 'CHECK_FAILED'
  });
  assert.equal(captureProjectArtifactCheckReceipt({
    captured: naturalZero.captured, check_id: 'check-main',
    receiptBytes: naturalZero.receiptBytes,
    definitionBytes: naturalZero.definitionBytes
  }).receipt.status, 'failed');

  const naturalNonzero = makeReceiptBundle(makeFixture(), {
    status: 'failed', reason: 'CHECK_FAILED',
    terminal: terminal({exit_code: 7})
  });
  assert.equal(captureProjectArtifactCheckReceipt({
    captured: naturalNonzero.captured, check_id: 'check-main',
    receiptBytes: naturalNonzero.receiptBytes,
    definitionBytes: naturalNonzero.definitionBytes
  }).receipt.terminal.exit_code, 7);

  const signaled = makeReceiptBundle(makeFixture(), {
    status: 'failed', reason: 'CHECK_FAILED',
    terminal: terminal({exit_kind: 'signal', exit_code: null, signal: 'SIGTERM'})
  });
  assert.equal(captureProjectArtifactCheckReceipt({
    captured: signaled.captured, check_id: 'check-main',
    receiptBytes: signaled.receiptBytes,
    definitionBytes: signaled.definitionBytes
  }).receipt.terminal.signal, 'SIGTERM');

  for (const [status, reason] of [
    ['blocked', 'CHECK_UNAVAILABLE'],
    ['not_run', 'EXPLICIT_NOT_RUN']
  ]) {
    const bundle = makeReceiptBundle(makeFixture(), {
      status, reason, terminal: null
    });
    assert.equal(captureProjectArtifactCheckReceipt({
      captured: bundle.captured, check_id: 'check-main',
      receiptBytes: bundle.receiptBytes,
      definitionBytes: bundle.definitionBytes
    }).receipt.terminal, null);
  }
});

test('rejects partial, unknown, inconsistent, or unclean terminal claims', () => {
  const invalid = [
    {
      status: 'passed', reason: 'NONE',
      terminal: terminal({direct_child_exit_observed: false}),
      code: 'TERMINAL_INCOMPLETE'
    },
    {
      status: 'passed', reason: 'NONE',
      terminal: terminal({stderr_eof: false}),
      code: 'TERMINAL_INCOMPLETE'
    },
    {
      status: 'passed', reason: 'NONE',
      terminal: terminal({exit_kind: 'unknown', exit_code: null, signal: null}),
      code: 'TERMINAL_INCOMPLETE'
    },
    {
      status: 'passed', reason: 'NONE',
      terminal: terminal({stop_codes: ['TERM_ATTEMPTED']}),
      code: 'TERMINAL_INCOMPLETE'
    },
    {
      status: 'passed', reason: 'NONE',
      terminal: terminal({cleanup_codes: ['CLOSE_FAILED']}),
      code: 'TERMINAL_INCOMPLETE'
    },
    {
      status: 'passed', reason: 'CHECK_FAILED',
      terminal: terminal(), code: 'INVALID_EVIDENCE'
    },
    {
      status: 'failed', reason: 'NONE',
      terminal: terminal(), code: 'INVALID_EVIDENCE'
    },
    {
      status: 'blocked', reason: 'EXPLICIT_NOT_RUN',
      terminal: null, code: 'TERMINAL_INCOMPLETE'
    },
    {
      status: 'not_run', reason: 'CHECK_UNAVAILABLE',
      terminal: null, code: 'TERMINAL_INCOMPLETE'
    },
    {
      status: 'failed', reason: 'CHECK_FAILED',
      terminal: terminal({
        exit_kind: 'signal', exit_code: 1, signal: 'SIGTERM'
      }),
      code: 'TERMINAL_INCOMPLETE'
    }
  ];
  for (const item of invalid) {
    const bundle = makeReceiptBundle(makeFixture(), {
      status: item.status, reason: item.reason, terminal: item.terminal
    });
    expectCode(item.code, () => captureProjectArtifactCheckReceipt({
      captured: bundle.captured, check_id: 'check-main',
      receiptBytes: bundle.receiptBytes,
      definitionBytes: bundle.definitionBytes
    }));
  }
});

test('checks each receipt binding after independently rebinding raw pins', () => {
  const mutations = [
    {check_id: 'other-check'},
    {definition_sha256: '9'.repeat(64)},
    {job_id: uuid2},
    {operation_config_sha256: '9'.repeat(64)},
    {stage_manifest_sha256: '9'.repeat(64)},
    {artifact_subset_sha256: '9'.repeat(64)},
    {observer_policy_sha256: '9'.repeat(64)}
  ];
  for (const change of mutations) {
    const bundle = makeReceiptBundle(makeFixture(), change);
    expectCode('BINDING_MISMATCH', () =>
      captureProjectArtifactCheckReceipt({
        captured: bundle.captured, check_id: 'check-main',
        receiptBytes: bundle.receiptBytes,
        definitionBytes: bundle.definitionBytes
      })
    );
  }

  const wrongRole = makeReceiptBundle(makeFixture(), {
    observer_role: 'candidate_test'
  });
  expectCode('ROLE_INSUFFICIENT', () =>
    captureProjectArtifactCheckReceipt({
      captured: wrongRole.captured, check_id: 'check-main',
      receiptBytes: wrongRole.receiptBytes,
      definitionBytes: wrongRole.definitionBytes
    })
  );
});

test('verifies raw receipt and definition byte lengths and hashes before parsing', () => {
  const bundle = makeReceiptBundle(makeFixture());
  const tamperedReceipt = new Uint8Array(bundle.receiptBytes.length);
  tamperedReceipt.set(bundle.receiptBytes);
  tamperedReceipt[tamperedReceipt.length - 2] ^= 1;
  const receiptHash = hash(bundle.receiptBytes);
  const definitionHash = hash(bundle.definitionBytes);
  expectCode('INVALID_EVIDENCE', () =>
    captureProjectArtifactCheckReceipt({
      captured: bundle.captured, check_id: 'check-main',
      receiptBytes: tamperedReceipt, definitionBytes: bundle.definitionBytes
    })
  );
  assert.equal(hash(bundle.receiptBytes), receiptHash);

  const wrongDefinition = encoder.encode('different synthetic definition');
  expectCode('INVALID_EVIDENCE', () =>
    captureProjectArtifactCheckReceipt({
      captured: bundle.captured, check_id: 'check-main',
      receiptBytes: bundle.receiptBytes, definitionBytes: wrongDefinition
    })
  );
  assert.equal(hash(bundle.definitionBytes), definitionHash);
});

test('accepts exact byte caps and rejects one-byte-over config, context, receipt, and definition', () => {
  const fixture = makeFixture();
  fixture.configBytes = paddedJson(fixture.config, 65_536);
  fixture.context.operation_config_sha256 = hash(fixture.configBytes);
  fixture.contextBytes = paddedJson(fixture.context, 65_536);
  const configBefore = hash(fixture.configBytes);
  const contextBefore = hash(fixture.contextBytes);
  const captured = captureProjectArtifactCheckData({
    configBytes: fixture.configBytes,
    artifactContextBytes: fixture.contextBytes
  });
  assert.equal(captured.operation_config_sha256, configBefore);
  assert.equal(hash(fixture.configBytes), configBefore);
  assert.equal(hash(fixture.contextBytes), contextBefore);

  const configTooLarge = new Uint8Array(65_537);
  configTooLarge.set(fixture.configBytes);
  configTooLarge[65_536] = 0x20;
  expectInvalidContext(() => captureProjectArtifactCheckData({
    configBytes: configTooLarge, artifactContextBytes: fixture.contextBytes
  }));

  const contextTooLarge = new Uint8Array(65_537);
  contextTooLarge.set(fixture.contextBytes);
  contextTooLarge[65_536] = 0x20;
  expectInvalidContext(() => captureProjectArtifactCheckData({
    configBytes: fixture.configBytes, artifactContextBytes: contextTooLarge
  }));

  const largeDefinition = new Uint8Array(1_048_576);
  largeDefinition.fill(0x41);
  const evidenceFixture = makeFixture({definitionBytes: largeDefinition});
  const bundle = makeReceiptBundle(evidenceFixture, {}, {
    receiptLength: 65_536
  });
  const receiptBefore = hash(bundle.receiptBytes);
  const definitionBefore = hash(bundle.definitionBytes);
  const accepted = captureProjectArtifactCheckReceipt({
    captured: bundle.captured, check_id: 'check-main',
    receiptBytes: bundle.receiptBytes,
    definitionBytes: bundle.definitionBytes
  });
  assert.equal(accepted.receipt_sha256, receiptBefore);
  assert.equal(hash(bundle.receiptBytes), receiptBefore);
  assert.equal(hash(bundle.definitionBytes), definitionBefore);

  const receiptTooLarge = new Uint8Array(65_537);
  receiptTooLarge.set(bundle.receiptBytes);
  receiptTooLarge[65_536] = 0x20;
  expectCode('ARTIFACT_LIMIT', () =>
    captureProjectArtifactCheckReceipt({
      captured: bundle.captured, check_id: 'check-main',
      receiptBytes: receiptTooLarge,
      definitionBytes: bundle.definitionBytes
    })
  );
  const definitionTooLarge = new Uint8Array(1_048_577);
  definitionTooLarge.fill(0x41);
  expectCode('ARTIFACT_LIMIT', () =>
    captureProjectArtifactCheckReceipt({
      captured: bundle.captured, check_id: 'check-main',
      receiptBytes: bundle.receiptBytes,
      definitionBytes: definitionTooLarge
    })
  );
});

test('rejects evidence pins inside stage or delivered artifact roots', () => {
  for (const which of ['definition_pin', 'receipt_pin']) {
    const fixture = makeFixture();
    fixture.context.required_checks[0][which].path =
      `${fixture.context.candidate.stage_root}/src/evidence.json`;
    expectInvalidContext(() =>
      validateProjectArtifactCheckContext(fixture.context)
    );
  }
  const deliveredRoot = makeFixture();
  deliveredRoot.context.required_checks[0].definition_pin.path =
    '/synthetic/delivery/private-definition';
  expectInvalidContext(() =>
    validateProjectArtifactCheckContext(deliveredRoot.context)
  );
  const boundarySibling = makeFixture();
  boundarySibling.context.required_checks[0].definition_pin.path =
    '/synthetic/delivery-extra/private-definition';
  assert.doesNotThrow(() =>
    validateProjectArtifactCheckContext(boundarySibling.context)
  );
});

test('rejects unsorted, duplicate, and unknown limitation codes', () => {
  for (const limitations of [
    ['TRUSTED_CALLER_ORIGIN', 'PRODUCT_NOT_EVALUATED'],
    ['PRODUCT_NOT_EVALUATED', 'PRODUCT_NOT_EVALUATED'],
    ['RAW_EVIDENCE_TEXT']
  ]) {
    const bundle = makeReceiptBundle(makeFixture(), {limitations});
    expectCode('INVALID_EVIDENCE', () =>
      captureProjectArtifactCheckReceipt({
        captured: bundle.captured, check_id: 'check-main',
        receiptBytes: bundle.receiptBytes,
        definitionBytes: bundle.definitionBytes
      })
    );
  }
});

test('pure data envelopes expose no roots or physical and coverage acceptance', () => {
  const fixture = makeFixture();
  const captured = captureFixture(fixture);
  const bundle = makeReceiptBundle(fixture);
  const checked = captureProjectArtifactCheckReceipt({
    captured: bundle.captured, check_id: 'check-main',
    receiptBytes: bundle.receiptBytes,
    definitionBytes: bundle.definitionBytes
  });
  const serialized = JSON.stringify(checked);
  assert.equal(serialized.includes(fixture.context.candidate.stage_root), false);
  assert.equal(serialized.includes('/synthetic/delivery'), false);
  assert.equal(checked.validation_scope, 'PURE_DATA_ONLY');
  assert.equal(Object.hasOwn(checked, 'coverage'), false);
  assert.equal(Object.hasOwn(checked, 'artifact_witness'), false);
  assert.equal(captured.validation_scope, 'PURE_DATA_ONLY');
});

test('rejects open input envelopes, accessors, proxies, and nonintrinsic bytes', () => {
  const fixture = makeFixture();
  const captured = captureFixture(fixture);
  expectInvalidContext(() => captureProjectArtifactCheckData({
    configBytes: fixture.configBytes,
    artifactContextBytes: fixture.contextBytes,
    extra: true
  }));
  const getterInput = {};
  let getterCalls = 0;
  Object.defineProperties(getterInput, {
    configBytes: {
      enumerable: true,
      get() {
        getterCalls++;
        return fixture.configBytes;
      }
    },
    artifactContextBytes: {
      enumerable: true, value: fixture.contextBytes
    }
  });
  expectInvalidContext(() => captureProjectArtifactCheckData(getterInput));
  assert.equal(getterCalls, 0);

  const bundle = makeReceiptBundle(fixture);
  const proxyBytes = new Proxy(bundle.receiptBytes, {});
  expectCode('INVALID_EVIDENCE', () =>
    captureProjectArtifactCheckReceipt({
      captured, check_id: 'check-main', receiptBytes: proxyBytes,
      definitionBytes: bundle.definitionBytes
    })
  );
});

// Declared top-level pure-data test count: 22.
// Those accepted fixtures use no filesystem, native, checker, child, model,
// producer, or provider operation. The following adapter fixtures use only
// injected native-like IO.
// Existing pure-data test bodies: 22.
// Existing artifact-file adapter test bodies: 17 (14 adapter, 2 attribution,
// 1 safe-port-capture). Existing total: 39.
// Added candidate-stage test bodies: 8. Final top-level test count: 47.
// Added stage-signal and authoritative-manifest regressions: 5.
// Final top-level test count after v47 corrections: 52.
// The v48 proxy-chain ordering regression expands an existing test body.

test('verifies sorted root-free witnesses across staged and delivered roots', async () => {
  const sourceBytes = encoder.encode('synthetic staged application');
  const longCopyRoot = `/${'r'.repeat(500)}`;
  const longCopyPath = 'x'.repeat(64);
  const fixture = makeArtifactFilesFixture([
    {
      artifact_id: 'app-main', role: 'staged',
      relative_path: 'src/app.js', payload: sourceBytes
    },
    {
      artifact_id: 'app-copy', role: 'delivered_copy',
      root: longCopyRoot, relative_path: longCopyPath,
      staged_artifact_id: 'app-main', payload: sourceBytes
    }
  ]);
  const result = await verifyProjectArtifactFilesWithPorts(
    fixture.captured, undefined, fixture.ports
  );
  assert.equal(result.verified, true);
  assert.equal(result.reason, 'NONE');
  assert.deepEqual(result.io_failures, []);
  assert.deepEqual(result.artifact_witness, [
    {
      artifact_id: 'app-copy', role: 'delivered_copy',
      relative_path: longCopyPath, byte_count: sourceBytes.length,
      sha256: hash(sourceBytes), staged_artifact_id: 'app-main'
    },
    {
      artifact_id: 'app-main', role: 'staged',
      relative_path: 'src/app.js', byte_count: sourceBytes.length,
      sha256: hash(sourceBytes), staged_artifact_id: null
    }
  ]);
  assert.ok(fixture.fake.filesByPath.get('app-copy').length > 512);
  assert.equal(fixture.fake.calls.open.length, 2);
  assert.equal(fixture.fake.calls.eofReads, 2);
  assert.equal(JSON.stringify(result).includes(fixture.stageRoot), false);
  assert.equal(JSON.stringify(result).includes(longCopyRoot), false);
  assert.deepEqual(Object.keys(result).sort(), [
    'artifact_witness', 'io_failures', 'reason', 'verification_scope',
    'verified'
  ]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.artifact_witness));
  assert.ok(Object.isFrozen(result.artifact_witness[0]));
});

test('rejects forged captures, unsafe ports, accessors, and invalid signals before IO', async () => {
  const fixture = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js', payload: encoder.encode('bytes')
  }]);
  const invalid = [
    () => verifyProjectArtifactFilesWithPorts(
      {...fixture.captured}, undefined, fixture.ports
    ),
    () => verifyProjectArtifactFilesWithPorts(
      fixture.captured, {aborted: false}, fixture.ports
    ),
    () => verifyProjectArtifactFilesWithPorts(
      fixture.captured, new Proxy(new AbortController().signal, {}),
      fixture.ports
    ),
    () => verifyProjectArtifactFilesWithPorts(
      fixture.captured, undefined,
      {fs: fixture.ports.fs, uid: -1}
    ),
    () => verifyProjectArtifactFilesWithPorts(
      fixture.captured, undefined,
      {fs: fixture.ports.fs, uid: Number.MAX_SAFE_INTEGER + 1}
    ),
    () => verifyProjectArtifactFilesWithPorts(
      fixture.captured, undefined,
      new Proxy({fs: fixture.ports.fs, uid: ARTIFACT_FILE_TEST_UID}, {
        ownKeys() { throw new Error('must not run'); }
      })
    )
  ];
  for (const invoke of invalid) {
    await assert.rejects(invoke(), error =>
      error instanceof ProjectArtifactCheckValidationError &&
      error.code === 'INVALID_ARTIFACT_CONTEXT' &&
      error.message === 'INVALID_ARTIFACT_CONTEXT'
    );
  }

  let getterCalls = 0;
  const hostileFs = {};
  Object.defineProperties(hostileFs, {
    lstat: {
      enumerable: true,
      get() {
        getterCalls++;
        return fixture.ports.fs.lstat;
      }
    },
    realpath: {enumerable: true, value: fixture.ports.fs.realpath},
    open: {enumerable: true, value: fixture.ports.fs.open}
  });
  await assert.rejects(
    verifyProjectArtifactFilesWithPorts(
      fixture.captured, undefined,
      {fs: hostileFs, uid: ARTIFACT_FILE_TEST_UID}
    ),
    error => error instanceof ProjectArtifactCheckValidationError &&
      error.code === 'INVALID_ARTIFACT_CONTEXT'
  );
  assert.equal(getterCalls, 0);

  const rootUid = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js', payload: encoder.encode('uid zero')
  }], {uid: 0});
  assert.equal(rootUid.ports.uid, 0);
  assert.equal(
    (await verifyProjectArtifactFilesWithPorts(
      rootUid.captured, undefined, rootUid.ports
    )).verified,
    true
  );
  assert.equal(fixture.fake.calls.lstat.length, 0);
  assert.equal(fixture.fake.calls.realpath.length, 0);
  assert.equal(fixture.fake.calls.open.length, 0);
});

test('captures original filesystem receivers and methods before suspension', async () => {
  const entered = deferred();
  const release = deferred();
  let paused = false;
  const fixture = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js',
    payload: encoder.encode('caller mutation cannot rebind')
  }], {
    beforeLstat: async () => {
      if (paused) return;
      paused = true;
      entered.resolve();
      await release.promise;
    }
  });
  const filesystem = fixture.ports.fs;
  let receiverChecks = 0;
  for (const key of ['lstat', 'realpath', 'open']) {
    const original = filesystem[key];
    filesystem[key] = function (...args) {
      assert.equal(this, filesystem);
      receiverChecks++;
      return Reflect.apply(original, this, args);
    };
  }

  const pending = verifyProjectArtifactFilesWithPorts(
    fixture.captured, undefined, fixture.ports
  );
  // Resolve the gate on early success or failure too, so a regression cannot
  // strand this test waiting for an IO operation that never starts.
  pending.then(() => entered.resolve(), () => entered.resolve());
  await entered.promise;
  try {
    fixture.fixture.context.artifacts[0].sha256 = '9'.repeat(64);
    fixture.ports.uid = Number.MAX_SAFE_INTEGER;
    fixture.ports.fs.open = async () => {
      throw new Error('mutated method must not be used');
    };
  } finally {
    release.resolve();
  }
  const result = await pending;
  assert.equal(result.verified, true);
  assert.ok(receiverChecks >= 3);
  assert.equal(
    result.artifact_witness[0].sha256,
    hash(encoder.encode('caller mutation cannot rebind'))
  );
});

test('captures callable filesystem ports without reading metadata or leaking errors', async () => {
  const operations = ['lstat', 'realpath', 'open'];
  for (const behavior of ['return', 'throw']) {
    for (const operation of operations) {
      const fixture = makeArtifactFilesFixture([{
        artifact_id: 'app-main', role: 'staged',
        relative_path: 'src/app.js',
        payload: encoder.encode(`metadata ${behavior} ${operation}`)
      }]);
      const filesystem = fixture.ports.fs;
      const original = filesystem[operation];
      const metadataReads = {name: 0, length: 0};
      let receiverMatches = true;
      const suppliedMethod = function (...args) {
        if (this !== filesystem) receiverMatches = false;
        return Reflect.apply(original, this, args);
      };
      for (const key of ['name', 'length']) {
        Object.defineProperty(suppliedMethod, key, {
          configurable: true,
          get() {
            metadataReads[key]++;
            if (behavior === 'throw') {
              throw new Error('PRIVATE_FUNCTION_METADATA');
            }
            return `synthetic-${key}`;
          }
        });
      }
      filesystem[operation] = suppliedMethod;

      const result = await verifyProjectArtifactFilesWithPorts(
        fixture.captured, undefined, fixture.ports
      );
      assert.equal(result.verified, true);
      assert.deepEqual(metadataReads, {name: 0, length: 0});
      assert.equal(receiverMatches, true);
      assert.ok(fixture.fake.calls[operation].length > 0);
      assert.equal(fixture.fake.calls.close.length, 1);
    }
  }

  const invalidFixture = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js', payload: encoder.encode('invalid ports')
  }]);
  let propertyGetterCalls = 0;
  const accessorFs = {};
  Object.defineProperties(accessorFs, {
    lstat: {
      enumerable: true,
      get() {
        propertyGetterCalls++;
        return invalidFixture.ports.fs.lstat;
      }
    },
    realpath: {
      enumerable: true,
      value: invalidFixture.ports.fs.realpath
    },
    open: {
      enumerable: true,
      value: invalidFixture.ports.fs.open
    }
  });
  let proxyTraps = 0;
  const proxyFs = new Proxy(invalidFixture.ports.fs, {
    ownKeys(target) {
      proxyTraps++;
      return Reflect.ownKeys(target);
    },
    getPrototypeOf(target) {
      proxyTraps++;
      return Reflect.getPrototypeOf(target);
    }
  });
  const invalidFilesystems = [
    accessorFs,
    proxyFs,
    {
      lstat: 1,
      realpath: invalidFixture.ports.fs.realpath,
      open: invalidFixture.ports.fs.open
    }
  ];
  for (const fs of invalidFilesystems) {
    await assert.rejects(
      verifyProjectArtifactFilesWithPorts(
        invalidFixture.captured, undefined,
        {fs, uid: ARTIFACT_FILE_TEST_UID}
      ),
      error => error instanceof ProjectArtifactCheckValidationError &&
        error.code === 'INVALID_ARTIFACT_CONTEXT' &&
        error.message === 'INVALID_ARTIFACT_CONTEXT'
    );
  }
  assert.equal(propertyGetterCalls, 0);
  assert.equal(proxyTraps, 0);
  assert.equal(invalidFixture.fake.calls.lstat.length, 0);
  assert.equal(invalidFixture.fake.calls.realpath.length, 0);
  assert.equal(invalidFixture.fake.calls.open.length, 0);

  let leafPath;
  const hostFailure = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js', payload: encoder.encode('host failure')
  }], {
    lstat(path) {
      if (path === leafPath) throw undefined;
      return undefined;
    }
  });
  leafPath = hostFailure.fake.filesByPath.get('app-main');
  const filesystem = hostFailure.ports.fs;
  const originalLstat = filesystem.lstat;
  const metadataReads = {name: 0, length: 0};
  let receiverMatches = true;
  const failingLstat = function (...args) {
    if (this !== filesystem) receiverMatches = false;
    return Reflect.apply(originalLstat, this, args);
  };
  for (const key of ['name', 'length']) {
    Object.defineProperty(failingLstat, key, {
      configurable: true,
      get() {
        metadataReads[key]++;
        throw new Error('PRIVATE_FUNCTION_METADATA');
      }
    });
  }
  filesystem.lstat = failingLstat;
  assertArtifactFileFailure(
    await verifyProjectArtifactFilesWithPorts(
      hostFailure.captured, undefined, hostFailure.ports
    ),
    'ARTIFACT_IO', ['IO_FAILED']
  );
  assert.deepEqual(metadataReads, {name: 0, length: 0});
  assert.equal(receiverMatches, true);
  assert.ok(hostFailure.fake.calls.lstat.length > 0);
  assert.equal(hostFailure.fake.calls.open.length, 0);
});

test('reads the exact 64 MiB per-file and 128 MiB aggregate caps with real EOF probes', async () => {
  const payload = {
    length: ARTIFACT_FILE_TEST_CAP,
    byteValue: 0x5a,
    sha256: repeatedByteSha(0x5a, ARTIFACT_FILE_TEST_CAP)
  };
  const fixture = makeArtifactFilesFixture([
    {
      artifact_id: 'app-main', role: 'staged',
      relative_path: 'src/app.js', payload
    },
    {
      artifact_id: 'app-copy', role: 'delivered_copy',
      root: '/synthetic/delivery', relative_path: 'app.js',
      staged_artifact_id: 'app-main', payload
    }
  ]);
  const result = await verifyProjectArtifactFilesWithPorts(
    fixture.captured, undefined, fixture.ports
  );
  assert.equal(result.verified, true);
  assert.equal(result.artifact_witness.length, 2);
  assert.equal(fixture.fake.calls.payloadBytes, 2 * ARTIFACT_FILE_TEST_CAP);
  assert.equal(fixture.fake.calls.eofReads, 2);
  assert.equal(
    fixture.fake.calls.requestedBytes,
    2 * ARTIFACT_FILE_TEST_CAP + 2
  );
});

test('rejects a real extra byte returned by the EOF probe', async () => {
  const fixture = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js', payload: encoder.encode('growth')
  }], {extraByteAtEof: true});
  const result = await verifyProjectArtifactFilesWithPorts(
    fixture.captured, undefined, fixture.ports
  );
  assertArtifactFileFailure(
    result, 'ARTIFACT_CHANGED', ['FILE_CHANGED']
  );
  assert.equal(fixture.fake.calls.eofReads, 1);
  assert.equal(fixture.fake.calls.close.length, 1);
});

test('accepts short reads at sequential positions and rejects malformed byte counts', async () => {
  const bytes = encoder.encode('short reads keep moving forward');
  const fixture = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js', payload: bytes
  }], {maxReadChunk: 3});
  const result = await verifyProjectArtifactFilesWithPorts(
    fixture.captured, undefined, fixture.ports
  );
  assert.equal(result.verified, true);
  const reads = fixture.fake.calls.read;
  const payloadReads = reads.filter(read => read.position < bytes.length);
  assert.deepEqual(
    payloadReads.map(read => read.position),
    Array.from({length: payloadReads.length}, (_, index) => index * 3)
  );
  assert.deepEqual(reads.at(-1), {
    path: fixture.fake.filesByPath.get('app-main'),
    offset: 0, length: 1, position: bytes.length
  });
  assert.equal(fixture.fake.calls.payloadBytes, bytes.length);
  assert.equal(fixture.fake.calls.eofReads, 1);

  for (const malformed of [
    NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, -1, 1.5
  ]) {
    const bad = makeArtifactFilesFixture([{
      artifact_id: 'app-main', role: 'staged',
      relative_path: 'src/app.js', payload: bytes
    }], {
      read(record, defaultRead) {
        return {
          ...defaultRead(),
          bytesRead: malformed === 1.5
            ? malformed
            : malformed === -1
              ? malformed
              : malformed
        };
      }
    });
    assertArtifactFileFailure(
      await verifyProjectArtifactFilesWithPorts(
        bad.captured, undefined, bad.ports
      ),
      'ARTIFACT_CHANGED', ['FILE_CHANGED']
    );
    assert.equal(bad.fake.calls.read.length, 1);
    assert.equal(bad.fake.calls.close.length, 1);
  }

  const overRequest = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js', payload: bytes
  }], {
    read(record, defaultRead) {
      return {...defaultRead(), bytesRead: record.length + 1};
    }
  });
  assertArtifactFileFailure(
    await verifyProjectArtifactFilesWithPorts(
      overRequest.captured, undefined, overRequest.ports
    ),
    'ARTIFACT_CHANGED', ['FILE_CHANGED']
  );
  assert.equal(overRequest.fake.calls.read.length, 1);
});

test('rejects wrong file size, owner, link count, kind, and symlink stats before reading', async () => {
  const cases = [
    ['size', (path, stat) => ({...stat, size: stat.size + 1n})],
    ['owner', (path, stat) => ({...stat, uid: BigInt(ARTIFACT_FILE_TEST_UID + 1)})],
    ['links', (path, stat) => ({...stat, nlink: 2n})],
    ['kind', (path, stat) => ({...stat, isFile: () => false})],
    ['symlink', (path, stat) => ({...stat, isSymbolicLink: () => true})]
  ];
  for (const [name, replace] of cases) {
    let filePath;
    const fixture = makeArtifactFilesFixture([{
      artifact_id: 'app-main', role: 'staged',
      relative_path: 'src/app.js', payload: encoder.encode(name)
    }], {
      lstat(path, count, stat) {
        if (path === filePath && count === 1) return replace(path, stat);
        return stat;
      }
    });
    filePath = fixture.fake.filesByPath.get('app-main');
    const result = await verifyProjectArtifactFilesWithPorts(
      fixture.captured, undefined, fixture.ports
    );
    assertArtifactFileFailure(
      result, 'ARTIFACT_CHANGED', ['FILE_CHANGED']
    );
    assert.equal(fixture.fake.calls.open.length, 0);
    assert.equal(fixture.fake.calls.read.length, 0);
  }
});

test('closes opened handles on opened-stat failure, mismatch, and pre-return abort', async () => {
  const failedStat = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js', payload: encoder.encode('stat failure')
  }], {
    handleStat() { throw undefined; }
  });
  assertArtifactFileFailure(
    await verifyProjectArtifactFilesWithPorts(
      failedStat.captured, undefined, failedStat.ports
    ),
    'ARTIFACT_IO', ['IO_FAILED']
  );
  assert.equal(failedStat.fake.calls.close.length, 1);

  let wrongSizePath;
  const wrongOpenedStat = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js', payload: encoder.encode('wrong opened size')
  }], {
    handleStat(path, count, stat) {
      if (path === wrongSizePath && count === 1) {
        return {...stat, size: stat.size + 1n};
      }
      return stat;
    }
  });
  wrongSizePath = wrongOpenedStat.fake.filesByPath.get('app-main');
  assertArtifactFileFailure(
    await verifyProjectArtifactFilesWithPorts(
      wrongOpenedStat.captured, undefined, wrongOpenedStat.ports
    ),
    'ARTIFACT_CHANGED', ['FILE_CHANGED']
  );
  assert.equal(wrongOpenedStat.fake.calls.close.length, 1);

  const controller = new AbortController();
  const abortedOpen = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js', payload: encoder.encode('abort after open')
  }], {
    async open(path, flags, handle) {
      controller.abort();
      return handle;
    }
  });
  assertArtifactFileFailure(
    await verifyProjectArtifactFilesWithPorts(
      abortedOpen.captured, controller.signal, abortedOpen.ports
    ),
    'ABORTED', ['ABORTED']
  );
  assert.equal(abortedOpen.fake.calls.open.length, 1);
  assert.equal(abortedOpen.fake.calls.handleStat.length, 0);
  assert.equal(abortedOpen.fake.calls.close.length, 1);
});

test('checks pre-abort and aborts during a pending read while still closing', async () => {
  const beforeController = new AbortController();
  beforeController.abort();
  const before = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js', payload: encoder.encode('already aborted')
  }]);
  assertArtifactFileFailure(
    await verifyProjectArtifactFilesWithPorts(
      before.captured, beforeController.signal, before.ports
    ),
    'ABORTED', ['ABORTED']
  );
  assert.equal(before.fake.calls.lstat.length, 0);

  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  let paused = false;
  const during = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js', payload: encoder.encode('pending read')
  }], {
    async read(record, defaultRead) {
      if (!paused) {
        paused = true;
        entered.resolve();
        await release.promise;
      }
      return defaultRead();
    }
  });
  const pending = verifyProjectArtifactFilesWithPorts(
    during.captured, controller.signal, during.ports
  );
  pending.then(() => entered.resolve(), () => entered.resolve());
  await entered.promise;
  try {
    controller.abort();
  } finally {
    release.resolve();
  }
  assertArtifactFileFailure(
    await pending, 'ABORTED', ['ABORTED']
  );
  assert.equal(during.fake.calls.close.length, 1);
});

test('preserves falsy IO failures and applies close-failure precedence', async () => {
  for (const thrown of [undefined, null, false, 0, '']) {
    const stages = [
      {
        hooks: {open() { throw thrown; }},
        reason: 'ARTIFACT_IO',
        failures: ['IO_FAILED'],
        closes: 0
      },
      {
        hooks: {handleStat() { throw thrown; }},
        reason: 'ARTIFACT_IO',
        failures: ['IO_FAILED'],
        closes: 1
      },
      {
        hooks: {read() { throw thrown; }},
        reason: 'ARTIFACT_IO',
        failures: ['IO_FAILED'],
        closes: 1
      },
      {
        hooks: {close() { throw thrown; }},
        reason: 'CLOSE_FAILED',
        failures: ['CLOSE_FAILED'],
        closes: 1
      }
    ];
    for (const stage of stages) {
      const fixture = makeArtifactFilesFixture([{
        artifact_id: 'app-main', role: 'staged',
        relative_path: 'src/app.js', payload: encoder.encode('falsy error')
      }], stage.hooks);
      assertArtifactFileFailure(
        await verifyProjectArtifactFilesWithPorts(
          fixture.captured, undefined, fixture.ports
        ),
        stage.reason, stage.failures
      );
      assert.equal(fixture.fake.calls.close.length, stage.closes);
    }
  }

  const readAndClose = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js', payload: encoder.encode('read and close fail')
  }], {
    read() { throw undefined; },
    close() { throw false; }
  });
  assertArtifactFileFailure(
    await verifyProjectArtifactFilesWithPorts(
      readAndClose.captured, undefined, readAndClose.ports
    ),
    'CLOSE_FAILED', ['CLOSE_FAILED', 'IO_FAILED']
  );
  assert.equal(readAndClose.fake.calls.close.length, 1);

  const controller = new AbortController();
  const combined = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js', payload: encoder.encode('abort and close')
  }], {
    read(record, defaultRead) {
      const result = defaultRead();
      controller.abort();
      return result;
    },
    close() { throw null; }
  });
  assertArtifactFileFailure(
    await verifyProjectArtifactFilesWithPorts(
      combined.captured, controller.signal, combined.ports
    ),
    'CLOSE_FAILED', ['ABORTED', 'CLOSE_FAILED']
  );
  assert.equal(combined.fake.calls.close.length, 1);
});

test('reduces verifier negatives and clears witnesses after any group fails', async () => {
  const wrongHash = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js',
    payload: encoder.encode('expected mismatch'),
    declaredSha256: '9'.repeat(64)
  }]);
  assertArtifactFileFailure(
    await verifyProjectArtifactFilesWithPorts(
      wrongHash.captured, undefined, wrongHash.ports
    ),
    'ARTIFACT_CHANGED', ['FILE_CHANGED']
  );

  let missingPath;
  const missing = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js', payload: encoder.encode('missing')
  }], {
    lstat(path) {
      if (path === missingPath) {
        throw Object.assign(new Error('private missing detail'), {
          code: 'ENOENT'
        });
      }
      return undefined;
    }
  });
  missingPath = missing.fake.filesByPath.get('app-main');
  assertArtifactFileFailure(
    await verifyProjectArtifactFilesWithPorts(
      missing.captured, undefined, missing.ports
    ),
    'ARTIFACT_IO', ['IO_FAILED']
  );

  let thisRoot;
  const aliasedRealpath = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js', payload: encoder.encode('alias')
  }], {
    realpath(path) {
      return path === thisRoot ? `${path}-alias` : path;
    }
  });
  thisRoot = aliasedRealpath.stageRoot;
  assertArtifactFileFailure(
    await verifyProjectArtifactFilesWithPorts(
      aliasedRealpath.captured, undefined, aliasedRealpath.ports
    ),
    'ARTIFACT_IO', ['IO_FAILED']
  );

  const bytes = encoder.encode('same declared copy bytes');
  const differentCopyBytes = encoder.encode('different physical copy!');
  assert.equal(differentCopyBytes.length, bytes.length);
  const wrongCopy = makeArtifactFilesFixture([
    {
      artifact_id: 'app-main', role: 'staged',
      relative_path: 'src/app.js', payload: bytes
    },
    {
      artifact_id: 'app-copy', role: 'delivered_copy',
      root: '/synthetic/delivery', relative_path: 'app.js',
      staged_artifact_id: 'app-main',
      payload: differentCopyBytes,
      declaredByteCount: bytes.length,
      declaredSha256: hash(bytes)
    }
  ]);
  const result = await verifyProjectArtifactFilesWithPorts(
    wrongCopy.captured, undefined, wrongCopy.ports
  );
  assertArtifactFileFailure(
    result, 'ARTIFACT_CHANGED', ['FILE_CHANGED']
  );
  assert.equal(wrongCopy.fake.calls.open.length, 2);
  assert.equal(wrongCopy.fake.calls.payloadBytes, 2 * bytes.length);
  assert.equal(wrongCopy.fake.calls.eofReads, 2);
});

test('uses one real EOF read per artifact up to the sixteen-entry limit', async () => {
  const specifications = Array.from({length: 16}, (_, index) => ({
    artifact_id: `artifact-${String(index).padStart(2, '0')}`,
    role: 'staged',
    relative_path: `src/file-${String(index).padStart(2, '0')}.js`,
    payload: encoder.encode(String(index))
  }));
  const fixture = makeArtifactFilesFixture(specifications);
  const result = await verifyProjectArtifactFilesWithPorts(
    fixture.captured, undefined, fixture.ports
  );
  assert.equal(result.verified, true);
  assert.equal(result.artifact_witness.length, 16);
  assert.equal(fixture.fake.calls.eofReads, 16);
  assert.equal(
    fixture.fake.calls.read.filter(read => {
      const spec = fixture.fileSpecs.find(item =>
        fixture.fake.filesByPath.get(item.artifact_id) === read.path
      );
      return spec && read.position === spec.payload.length;
    }).length,
    16
  );
});

test('fails closed when distinct context identities resolve to one lexical file path', async () => {
  const config = makeConfig();
  const stageRoot = join(
    config.scope, 'output', `run-${config.job_id}`, 'stage'
  );
  const bytes = encoder.encode('one physical path');
  const fixture = makeArtifactFilesFixture([
    {
      artifact_id: 'app-main', role: 'staged',
      relative_path: 'src/app.js', payload: bytes
    },
    {
      artifact_id: 'app-copy', role: 'delivered_copy',
      root: join(stageRoot, 'src'), relative_path: 'app.js',
      staged_artifact_id: 'app-main', payload: bytes
    }
  ]);
  const result = await verifyProjectArtifactFilesWithPorts(
    fixture.captured, undefined, fixture.ports
  );
  assertArtifactFileFailure(
    result, 'ARTIFACT_CHANGED', ['FILE_CHANGED']
  );
  assert.equal(fixture.fake.calls.lstat.length, 0);
  assert.equal(fixture.fake.calls.open.length, 0);
});

test('keeps verifier post-read file and directory change checks active', async () => {
  let filePath;
  const fileChange = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js', payload: encoder.encode('file changes')
  }], {
    lstat(path, count, stat) {
      if (path === filePath && count === 2) {
        return {...stat, mtimeNs: stat.mtimeNs + 1n};
      }
      return stat;
    }
  });
  filePath = fileChange.fake.filesByPath.get('app-main');
  assertArtifactFileFailure(
    await verifyProjectArtifactFilesWithPorts(
      fileChange.captured, undefined, fileChange.ports
    ),
    'ARTIFACT_CHANGED', ['FILE_CHANGED']
  );

  let rootPath;
  const directoryChange = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js', payload: encoder.encode('directory changes')
  }], {
    lstat(path, count, stat) {
      if (path === rootPath && count === 2) {
        return {...stat, ino: stat.ino + 1n};
      }
      return stat;
    }
  });
  rootPath = directoryChange.stageRoot;
  assertArtifactFileFailure(
    await verifyProjectArtifactFilesWithPorts(
      directoryChange.captured, undefined, directoryChange.ports
    ),
    'ARTIFACT_CHANGED', ['FILE_CHANGED']
  );
});

test('separates internal controls from falsy host IO and cleanup failures', async () => {
  let leafPath;
  const failedLstat = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js', payload: encoder.encode('lstat failure')
  }], {
    lstat(path) {
      if (path === leafPath) throw undefined;
      return undefined;
    }
  });
  leafPath = failedLstat.fake.filesByPath.get('app-main');
  assertArtifactFileFailure(
    await verifyProjectArtifactFilesWithPorts(
      failedLstat.captured, undefined, failedLstat.ports
    ),
    'ARTIFACT_IO', ['IO_FAILED']
  );
  assert.equal(failedLstat.fake.calls.open.length, 0);

  let rootPath;
  const failedRealpath = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js', payload: encoder.encode('realpath failure')
  }], {
    realpath(path) {
      if (path === rootPath) throw null;
      return undefined;
    }
  });
  rootPath = failedRealpath.stageRoot;
  assertArtifactFileFailure(
    await verifyProjectArtifactFilesWithPorts(
      failedRealpath.captured, undefined, failedRealpath.ports
    ),
    'ARTIFACT_IO', ['IO_FAILED']
  );
  assert.equal(failedRealpath.fake.calls.open.length, 0);

  const changedAndCloseFailed = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js', payload: encoder.encode('changed stat')
  }], {
    handleStat(path, count, stat) {
      return count === 1 ? {...stat, size: stat.size + 1n} : stat;
    },
    close() { throw false; }
  });
  assertArtifactFileFailure(
    await verifyProjectArtifactFilesWithPorts(
      changedAndCloseFailed.captured, undefined,
      changedAndCloseFailed.ports
    ),
    'CLOSE_FAILED', ['CLOSE_FAILED', 'FILE_CHANGED']
  );
  assert.equal(changedAndCloseFailed.fake.calls.close.length, 1);

  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  const hostIOAndAbort = makeArtifactFilesFixture([{
    artifact_id: 'app-main', role: 'staged',
    relative_path: 'src/app.js', payload: encoder.encode('host IO and abort')
  }], {
    async read() {
      entered.resolve();
      await release.promise;
      throw null;
    }
  });
  const pending = verifyProjectArtifactFilesWithPorts(
    hostIOAndAbort.captured, controller.signal, hostIOAndAbort.ports
  );
  pending.then(() => entered.resolve(), () => entered.resolve());
  try {
    await entered.promise;
    controller.abort();
  } finally {
    release.resolve();
  }
  assertArtifactFileFailure(
    await pending, 'ABORTED', ['ABORTED', 'IO_FAILED']
  );
  assert.equal(hostIOAndAbort.fake.calls.close.length, 1);
});

test('isolates attribution across concurrent calls and keeps group failures global', async () => {
  const abortController = new AbortController();
  const entered = deferred();
  const release = deferred();
  let paused = false;
  const aborting = makeArtifactFilesFixture([{
    artifact_id: 'abort-file', role: 'staged',
    relative_path: 'src/abort.js', payload: encoder.encode('abort this call')
  }], {
    async read(record, defaultRead) {
      if (!paused) {
        paused = true;
        entered.resolve();
        await release.promise;
      }
      return defaultRead();
    }
  });
  const failingController = new AbortController();
  const hostFailure = makeArtifactFilesFixture([{
    artifact_id: 'io-file', role: 'staged',
    relative_path: 'src/io.js', payload: encoder.encode('IO in other call')
  }], {
    read() { throw 0; }
  });
  const successful = makeArtifactFilesFixture([{
    artifact_id: 'ok-file', role: 'staged',
    relative_path: 'src/ok.js', payload: encoder.encode('independent success')
  }]);

  const abortedPending = verifyProjectArtifactFilesWithPorts(
    aborting.captured, abortController.signal, aborting.ports
  );
  abortedPending.then(() => entered.resolve(), () => entered.resolve());
  const failedPending = verifyProjectArtifactFilesWithPorts(
    hostFailure.captured, failingController.signal, hostFailure.ports
  );
  const successfulPending = verifyProjectArtifactFilesWithPorts(
    successful.captured, undefined, successful.ports
  );
  try {
    await entered.promise;
    abortController.abort();
  } finally {
    release.resolve();
  }

  const [aborted, failed, passed] = await Promise.all([
    abortedPending, failedPending, successfulPending
  ]);
  assertArtifactFileFailure(aborted, 'ABORTED', ['ABORTED']);
  assertArtifactFileFailure(failed, 'ARTIFACT_IO', ['IO_FAILED']);
  assert.equal(passed.verified, true);
  assert.equal(
    passed.artifact_witness[0].sha256,
    hash(encoder.encode('independent success'))
  );

  const bytes = encoder.encode('first group succeeds');
  const laterBytes = encoder.encode('second group throws!');
  assert.equal(laterBytes.length, bytes.length);
  let laterReadCalls = 0;
  const laterFailure = makeArtifactFilesFixture([
    {
      artifact_id: 'first-file', role: 'staged',
      relative_path: 'src/first.js', payload: bytes
    },
    {
      artifact_id: 'later-file', role: 'delivered_copy',
      root: '/synthetic/later-root', relative_path: 'later.js',
      staged_artifact_id: 'first-file',
      payload: laterBytes,
      declaredByteCount: bytes.length,
      declaredSha256: hash(bytes)
    }
  ], {
    read(record, defaultRead) {
      if (record.path.includes('later-root')) {
        laterReadCalls++;
        throw false;
      }
      return defaultRead();
    }
  });
  const laterPath = laterFailure.fake.filesByPath.get('later-file');
  assert.equal(
    laterFailure.fake.nodes.get(laterPath).length,
    laterFailure.fileSpecs[1].byte_count
  );
  assertArtifactFileFailure(
    await verifyProjectArtifactFilesWithPorts(
      laterFailure.captured, undefined, laterFailure.ports
    ),
    'ARTIFACT_IO', ['IO_FAILED']
  );
  assert.equal(laterReadCalls, 1);
  assert.equal(laterFailure.fake.calls.open.length, 2);
  assert.equal(laterFailure.fake.calls.close.length, 2);
});

const CANDIDATE_STAGE_TEST_UID = 71;
const CANDIDATE_STAGE_MANIFEST_MAX = 65_536;

function makeCandidateStageStat(node, overrides = {}) {
  return {
    dev: 1,
    ino: node.ino,
    size: node.kind === 'file' ? node.bytes.length : 1,
    mtimeMs: 2,
    ctimeMs: 3,
    mode: node.kind === 'file' ? 0o100400 : 0o040700,
    uid: CANDIDATE_STAGE_TEST_UID,
    nlink: 1,
    isFile() { return node.kind === 'file'; },
    isDirectory() { return node.kind === 'directory'; },
    isSymbolicLink() { return false; },
    ...overrides
  };
}

function makeCandidateStageIO(stagePlan, stageRoot, hooks = {}) {
  const nodes = new Map();
  const calls = {
    lstat: [], open: [], mkdir: [], chmod: [], readdir: [],
    realpath: [], handleStat: [], read: [], close: [], readBytes: []
  };
  let nextInode = 10;
  const addDirectory = path => {
    if (nodes.has(path)) return nodes.get(path);
    const node = {kind: 'directory', ino: nextInode++};
    nodes.set(path, node);
    return node;
  };
  const ensureDirectory = path => {
    if (nodes.has(path)) return nodes.get(path);
    const parent = dirname(path);
    if (parent !== path) ensureDirectory(parent);
    return addDirectory(path);
  };
  ensureDirectory('/');
  ensureDirectory(stageRoot);
  for (const file of stagePlan.files) {
    const parts = file.path.split('/');
    let directory = stageRoot;
    for (const part of parts.slice(0, -1)) {
      directory = join(directory, part);
      ensureDirectory(directory);
    }
    nodes.set(join(stageRoot, file.path), {
      kind: 'file', ino: nextInode++, bytes: new Uint8Array(file.content)
    });
  }
  const manifestPath = join(stageRoot, 'stage-manifest.json');
  nodes.set(manifestPath, {
    kind: 'file',
    ino: nextInode++,
    bytes: new Uint8Array(stagePlan.manifest_bytes)
  });

  const fs = {
    async lstat(path, ...args) {
      calls.lstat.push({path, args});
      if (hooks.beforeLstat) await hooks.beforeLstat(path, calls);
      const node = nodes.get(path);
      if (!node) {
        throw Object.assign(new Error('synthetic missing path'), {
          code: 'ENOENT'
        });
      }
      const stat = makeCandidateStageStat(node);
      if (hooks.lstat) {
        const replacement = hooks.lstat(path, node, stat, calls);
        if (replacement !== undefined) return replacement;
      }
      return stat;
    },
    async open(path, flags, ...args) {
      calls.open.push({path, flags, args});
      const node = nodes.get(path);
      if (!node || node.kind !== 'file') {
        throw Object.assign(new Error('synthetic missing file'), {
          code: 'ENOENT'
        });
      }
      const handle = {
        async stat(...statArgs) {
          calls.handleStat.push({path, args: statArgs});
          const stat = makeCandidateStageStat(node);
          if (hooks.handleStat) {
            const replacement = hooks.handleStat(
              path, node, stat, calls
            );
            if (replacement !== undefined) return replacement;
          }
          return stat;
        },
        async read(buffer, offset, length, position) {
          calls.read.push({path, offset, length, position});
          if (hooks.read) {
            const replacement = await hooks.read(
              path, node, buffer, offset, length, position, calls
            );
            if (replacement !== undefined) return replacement;
          }
          const count = Math.min(
            length, Math.max(0, node.bytes.length - position)
          );
          if (count > 0) {
            buffer.set(node.bytes.subarray(position, position + count), offset);
          }
          return {bytesRead: count};
        },
        async close() {
          calls.close.push(path);
          if (hooks.close) await hooks.close(path, calls);
        }
      };
      if (hooks.open) {
        const replacement = await hooks.open(path, flags, handle, calls);
        if (replacement !== undefined) return replacement;
      }
      return handle;
    },
    async mkdir(...args) {
      calls.mkdir.push(args);
      if (hooks.mkdir) await hooks.mkdir(...args);
    },
    async chmod(...args) {
      calls.chmod.push(args);
      if (hooks.chmod) await hooks.chmod(...args);
    },
    async readdir(path, ...args) {
      calls.readdir.push({path, args});
      if (hooks.readdir) {
        const replacement = await hooks.readdir(path, calls);
        if (replacement !== undefined) return replacement;
      }
      if (!nodes.has(path) || nodes.get(path).kind !== 'directory') {
        throw Object.assign(new Error('synthetic missing directory'), {
          code: 'ENOENT'
        });
      }
      return [...nodes.keys()]
        .filter(candidate => candidate !== path &&
          dirname(candidate) === path)
        .map(candidate => candidate.slice(path.length + 1));
    },
    async realpath(path, ...args) {
      calls.realpath.push({path, args});
      return path;
    }
  };
  const readBytes = async (path, maxBytes) => {
    calls.readBytes.push({path, maxBytes});
    if (hooks.readBytes) {
      const replacement = await hooks.readBytes(
        path, maxBytes, new Uint8Array(stagePlan.manifest_bytes), calls
      );
      if (replacement !== undefined) return replacement;
    }
    return new Uint8Array(stagePlan.manifest_bytes);
  };
  return {fs, readBytes, uid: CANDIDATE_STAGE_TEST_UID, calls, nodes};
}

function makeCandidateStageFixture(options = {}) {
  const config = options.config ?? makeConfig();
  const stageRoot = join(
    config.scope, 'output', `run-${config.job_id}`, 'stage'
  );
  const stageOperationId =
    options.stageOperationId ?? `stage-${config.job_id}`;
  const files = options.files ?? [{
    path: 'src/app.js',
    classification: 'SOURCE',
    content: encoder.encode('synthetic candidate source')
  }];
  const stagePlan = planLargeProjectStaging({
    stage_operation_id: stageOperationId,
    caller_label: 'synthetic-stage',
    output_profile: PROJECT_OUTPUT_LARGE_PROFILE,
    files: files.map(file => ({
      path: file.path,
      classification: file.classification,
      content: file.content
    }))
  });
  const defaultArtifacts = stagePlan.files.map((file, index) =>
    makeArtifact({
      artifact_id: `stage-file-${String(index).padStart(2, '0')}`,
      role: 'staged',
      root: stageRoot,
      relative_path: file.path,
      byte_count: file.bytes,
      sha256: file.sha256
    })
  );
  const artifacts = options.artifacts
    ? options.artifacts(stagePlan, stageRoot, defaultArtifacts)
    : defaultArtifacts;
  const fixture = makeFixture({
    config,
    artifacts,
    checks: [makeCheck(
      'check-stage',
      artifacts.map(artifact => artifact.artifact_id)
    )]
  });
  fixture.context.candidate.stage_manifest_sha256 =
    options.candidateHash ?? stagePlan.manifest_sha256;
  const captured = captureFixture(fixture);
  const fake = makeCandidateStageIO(stagePlan, stageRoot, options.hooks);
  return {
    config, stageRoot, stagePlan, fixture, captured, fake,
    ports: {fs: fake.fs, uid: fake.uid, readBytes: fake.readBytes}
  };
}

function assertCandidateStageFailure(result, reason) {
  assert.deepEqual(Object.keys(result).sort(), [
    'reason', 'stage_manifest_sha256', 'stage_operation_id',
    'staged_artifacts', 'verification_scope', 'verified'
  ]);
  assert.equal(result.verification_scope, 'CANDIDATE_STAGE_ONLY');
  assert.equal(result.verified, false);
  assert.equal(result.stage_operation_id, null);
  assert.equal(result.stage_manifest_sha256, null);
  assert.deepEqual(result.staged_artifacts, []);
  assert.equal(result.reason, reason);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.staged_artifacts));
}

test('verifies and binds a staged subset through the unchanged stage verifier', async () => {
  const docOne = new Uint8Array(65_536).fill(0x41);
  const docTwo = new Uint8Array(65_536).fill(0x42);
  const fixture = makeCandidateStageFixture({
    files: [
      {
        path: 'src/app.js',
        classification: 'SOURCE',
        content: encoder.encode('verified staged application')
      },
      {path: 'docs/one.md', classification: 'DOC', content: docOne},
      {path: 'docs/two.md', classification: 'DOC', content: docTwo}
    ],
    artifacts: (plan, stageRoot) => {
      const source = plan.files.find(file => file.path === 'src/app.js');
      const staged = makeArtifact({
        artifact_id: 'app-main',
        role: 'staged',
        root: stageRoot,
        relative_path: source.path,
        byte_count: source.bytes,
        sha256: source.sha256
      });
      return [
        staged,
        makeArtifact({
          artifact_id: 'app-copy',
          role: 'delivered_copy',
          root: '/synthetic/delivery',
          relative_path: 'app.js',
          byte_count: source.bytes,
          sha256: source.sha256,
          staged_artifact_id: 'app-main'
        })
      ];
    }
  });
  const result = await verifyProjectArtifactStageWithPorts(
    fixture.captured, undefined, fixture.ports
  );
  assert.deepEqual(result, {
    verification_scope: 'CANDIDATE_STAGE_ONLY',
    verified: true,
    stage_operation_id: `stage-${fixture.config.job_id}`,
    stage_manifest_sha256: fixture.stagePlan.manifest_sha256,
    staged_artifacts: [{
      artifact_id: 'app-main',
      role: 'staged',
      relative_path: 'src/app.js',
      byte_count: encoder.encode('verified staged application').length,
      sha256: hash(encoder.encode('verified staged application')),
      staged_artifact_id: null
    }],
    reason: 'NONE'
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.staged_artifacts));
  assert.ok(Object.isFrozen(result.staged_artifacts[0]));
  assert.deepEqual(
    result.staged_artifacts.map(artifact => artifact.artifact_id),
    ['app-main']
  );
  assert.equal(JSON.stringify(result).includes(fixture.stageRoot), false);
  assert.equal(JSON.stringify(result).includes('/synthetic/delivery'), false);
  assert.deepEqual(fixture.fake.calls.readBytes, [{
    path: join(fixture.stageRoot, 'stage-manifest.json'),
    maxBytes: CANDIDATE_STAGE_MANIFEST_MAX
  }]);
  assert.equal(fixture.fake.calls.mkdir.length, 0);
  assert.equal(fixture.fake.calls.chmod.length, 0);
  assert.equal(fixture.fake.calls.close.length, fixture.stagePlan.files.length + 1);
});

test('rejects forged captures, invalid closed ports, and shadowed abort accessors before IO', async () => {
  const fixture = makeCandidateStageFixture();
  const validCaptured = fixture.captured;
  const forged = {...validCaptured};
  await assert.rejects(
    verifyProjectArtifactStageWithPorts(forged, undefined, fixture.ports),
    error => error instanceof ProjectArtifactCheckValidationError &&
      error.code === 'INVALID_ARTIFACT_CONTEXT' &&
      error.message === 'INVALID_ARTIFACT_CONTEXT'
  );

  let proxyTraps = 0;
  const proxyFs = new Proxy(fixture.ports.fs, {
    ownKeys() {
      proxyTraps++;
      throw new Error('private proxy trap');
    },
    getPrototypeOf() {
      proxyTraps++;
      throw new Error('private proxy trap');
    }
  });
  const invalidPorts = [
    {...fixture.ports, extra: true},
    {fs: fixture.ports.fs, uid: -1, readBytes: fixture.ports.readBytes},
    {
      fs: fixture.ports.fs,
      uid: Number.MAX_SAFE_INTEGER + 1,
      readBytes: fixture.ports.readBytes
    },
    {
      fs: proxyFs,
      uid: CANDIDATE_STAGE_TEST_UID,
      readBytes: fixture.ports.readBytes
    },
    {
      fs: {...fixture.ports.fs, open: 1},
      uid: CANDIDATE_STAGE_TEST_UID,
      readBytes: fixture.ports.readBytes
    }
  ];
  for (const ports of invalidPorts) {
    await assert.rejects(
      verifyProjectArtifactStageWithPorts(
        validCaptured, undefined, ports
      ),
      error => error instanceof ProjectArtifactCheckValidationError &&
        error.code === 'INVALID_ARTIFACT_CONTEXT' &&
        error.message === 'INVALID_ARTIFACT_CONTEXT'
    );
  }

  let fsGetterCalls = 0;
  const accessorFs = {};
  Object.defineProperties(accessorFs, {
    open: {enumerable: true, value: fixture.ports.fs.open},
    mkdir: {enumerable: true, value: fixture.ports.fs.mkdir},
    lstat: {
      enumerable: true,
      get() {
        fsGetterCalls++;
        return fixture.ports.fs.lstat;
      }
    },
    chmod: {enumerable: true, value: fixture.ports.fs.chmod},
    readdir: {enumerable: true, value: fixture.ports.fs.readdir},
    realpath: {enumerable: true, value: fixture.ports.fs.realpath}
  });
  await assert.rejects(
    verifyProjectArtifactStageWithPorts(validCaptured, undefined, {
      fs: accessorFs,
      uid: CANDIDATE_STAGE_TEST_UID,
      readBytes: fixture.ports.readBytes
    }),
    error => error instanceof ProjectArtifactCheckValidationError &&
      error.code === 'INVALID_ARTIFACT_CONTEXT' &&
      error.message === 'INVALID_ARTIFACT_CONTEXT'
  );

  let readBytesGetterCalls = 0;
  const accessorPorts = {
    fs: fixture.ports.fs,
    uid: CANDIDATE_STAGE_TEST_UID
  };
  Object.defineProperty(accessorPorts, 'readBytes', {
    enumerable: true,
    get() {
      readBytesGetterCalls++;
      return fixture.ports.readBytes;
    }
  });
  await assert.rejects(
    verifyProjectArtifactStageWithPorts(
      validCaptured, undefined, accessorPorts
    ),
    error => error instanceof ProjectArtifactCheckValidationError &&
      error.code === 'INVALID_ARTIFACT_CONTEXT' &&
      error.message === 'INVALID_ARTIFACT_CONTEXT'
  );

  const controller = new AbortController();
  let signalGetterCalls = 0;
  Object.defineProperty(controller.signal, 'aborted', {
    configurable: true,
    get() {
      signalGetterCalls++;
      return false;
    }
  });
  await assert.rejects(
    verifyProjectArtifactStageWithPorts(
      validCaptured, controller.signal, fixture.ports
    ),
    error => error instanceof ProjectArtifactCheckValidationError &&
      error.code === 'INVALID_ARTIFACT_CONTEXT' &&
      error.message === 'INVALID_ARTIFACT_CONTEXT'
  );
  assert.equal(proxyTraps, 0);
  assert.equal(fsGetterCalls, 0);
  assert.equal(readBytesGetterCalls, 0);
  assert.equal(signalGetterCalls, 0);
  assert.equal(fixture.fake.calls.lstat.length, 0);
  assert.equal(fixture.fake.calls.open.length, 0);
  assert.equal(fixture.fake.calls.readBytes.length, 0);
});

test('ignores port function metadata and preserves captured receivers across awaits', async () => {
  for (const behavior of ['return', 'throw']) {
    const entered = deferred();
    const release = deferred();
    let paused = false;
    const fixture = makeCandidateStageFixture({
      hooks: behavior === 'throw' ? {
        async beforeLstat() {
          if (paused) return;
          paused = true;
          entered.resolve();
          await release.promise;
        }
      } : {}
    });
    const originalPorts = fixture.ports;
    const filesystem = fixture.ports.fs;
    const metadataReads = new Map();
    let receiverMatches = true;
    for (const key of [
      'open', 'mkdir', 'lstat', 'chmod', 'readdir', 'realpath'
    ]) {
      const original = filesystem[key];
      const reads = {name: 0, length: 0};
      metadataReads.set(key, reads);
      const supplied = function (...args) {
        if (this !== filesystem) receiverMatches = false;
        return Reflect.apply(original, this, args);
      };
      for (const property of ['name', 'length']) {
        Object.defineProperty(supplied, property, {
          configurable: true,
          get() {
            reads[property]++;
            if (behavior === 'throw') {
              throw new Error('PRIVATE_PORT_FUNCTION_METADATA');
            }
            return `synthetic-${property}`;
          }
        });
      }
      filesystem[key] = supplied;
    }
    const readBytesReads = {name: 0, length: 0};
    const originalReadBytes = fixture.ports.readBytes;
    const suppliedReadBytes = function (...args) {
      if (this !== originalPorts) receiverMatches = false;
      return Reflect.apply(originalReadBytes, this, args);
    };
    for (const property of ['name', 'length']) {
      Object.defineProperty(suppliedReadBytes, property, {
        configurable: true,
        get() {
          readBytesReads[property]++;
          if (behavior === 'throw') {
            throw new Error('PRIVATE_READBYTES_METADATA');
          }
          return `synthetic-${property}`;
        }
      });
    }
    fixture.ports.readBytes = suppliedReadBytes;

    const pending = verifyProjectArtifactStageWithPorts(
      fixture.captured, undefined, fixture.ports
    );
    if (behavior === 'throw') {
      pending.then(() => entered.resolve(), () => entered.resolve());
      await entered.promise;
      try {
        fixture.ports.uid = Number.MAX_SAFE_INTEGER;
        fixture.ports.fs.lstat = async () => {
          throw new Error('mutated lstat must not run');
        };
        fixture.ports.readBytes = async () => {
          throw new Error('mutated readBytes must not run');
        };
      } finally {
        release.resolve();
      }
    }
    const result = await pending;
    assert.equal(result.verified, true);
    assert.equal(receiverMatches, true);
    assert.deepEqual(readBytesReads, {name: 0, length: 0});
    for (const reads of metadataReads.values()) {
      assert.deepEqual(reads, {name: 0, length: 0});
    }
    assert.deepEqual(fixture.fake.calls.mkdir, []);
    assert.deepEqual(fixture.fake.calls.chmod, []);
    assert.equal(fixture.fake.calls.readBytes.length, 1);
  }
});

test('rejects valid stages whose operation or manifest hash differs from the candidate', async () => {
  const wrongHash = makeCandidateStageFixture({
    candidateHash: '9'.repeat(64)
  });
  const hashResult = await verifyProjectArtifactStageWithPorts(
    wrongHash.captured, undefined, wrongHash.ports
  );
  assertCandidateStageFailure(hashResult, 'BINDING_MISMATCH');
  assert.equal(wrongHash.fake.calls.readBytes.length, 0);

  const wrongOperation = makeCandidateStageFixture({
    stageOperationId: 'stage-other-operation'
  });
  const operationResult = await verifyProjectArtifactStageWithPorts(
    wrongOperation.captured, undefined, wrongOperation.ports
  );
  assertCandidateStageFailure(operationResult, 'BINDING_MISMATCH');
  assert.equal(wrongOperation.fake.calls.readBytes.length, 0);
});

test('binds each staged context member and never treats the manifest as an artifact', async () => {
  const base = makeCandidateStageFixture();
  const valid = base.stagePlan.files[0];
  const cases = [
    makeArtifact({
      artifact_id: 'missing-member', role: 'staged',
      root: base.stageRoot, relative_path: 'src/missing.js',
      byte_count: valid.bytes, sha256: valid.sha256
    }),
    makeArtifact({
      artifact_id: 'wrong-byte-count', role: 'staged',
      root: base.stageRoot, relative_path: valid.path,
      byte_count: valid.bytes + 1, sha256: valid.sha256
    }),
    makeArtifact({
      artifact_id: 'wrong-hash', role: 'staged',
      root: base.stageRoot, relative_path: valid.path,
      byte_count: valid.bytes, sha256: '9'.repeat(64)
    }),
    makeArtifact({
      artifact_id: 'manifest-as-artifact', role: 'staged',
      root: base.stageRoot, relative_path: 'stage-manifest.json',
      byte_count: base.stagePlan.manifest_bytes.length,
      sha256: hash(base.stagePlan.manifest_bytes)
    })
  ];
  for (const artifact of cases) {
    const fixture = makeCandidateStageFixture({
      artifacts: () => [artifact]
    });
    const result = await verifyProjectArtifactStageWithPorts(
      fixture.captured, undefined, fixture.ports
    );
    assertCandidateStageFailure(result, 'BINDING_MISMATCH');
    assert.equal(fixture.fake.calls.readBytes.length, 1);
  }
});

test('returns only conservative stage failure for physical corruption and IO faults', async () => {
  const tampered = makeCandidateStageFixture({
    hooks: {
      read(path, node, _buffer, _offset, _length, position) {
        if (path.endsWith('/src/app.js') && position === 0) {
          node.bytes[0] ^= 1;
        }
        return undefined;
      }
    }
  });
  assertCandidateStageFailure(
    await verifyProjectArtifactStageWithPorts(
      tampered.captured, undefined, tampered.ports
    ),
    'STAGE_CORRUPT_OR_INCOMPLETE'
  );

  const missingInventory = makeCandidateStageFixture({
    hooks: {
      readdir(path) {
        if (path.endsWith('/stage')) return [];
        return undefined;
      }
    }
  });
  assertCandidateStageFailure(
    await verifyProjectArtifactStageWithPorts(
      missingInventory.captured, undefined, missingInventory.ports
    ),
    'STAGE_CORRUPT_OR_INCOMPLETE'
  );

  const unexpectedInventory = makeCandidateStageFixture({
    hooks: {
      readdir(path) {
        if (path.endsWith('/stage')) {
          return ['stage-manifest.json', 'src', 'unexpected.txt'];
        }
        return undefined;
      }
    }
  });
  assertCandidateStageFailure(
    await verifyProjectArtifactStageWithPorts(
      unexpectedInventory.captured, undefined, unexpectedInventory.ports
    ),
    'STAGE_CORRUPT_OR_INCOMPLETE'
  );

  const faults = [
    {
      hooks: {
        open(path) {
          if (path.endsWith('/stage-manifest.json')) throw undefined;
        }
      },
      openedPath: null
    },
    {
      hooks: {
        handleStat(path) {
          if (path.endsWith('/stage-manifest.json')) throw null;
        }
      },
      openedPath: '/stage-manifest.json'
    },
    {
      hooks: {
        lstat(path, _node, stat) {
          if (path.endsWith('/src/app.js')) return {...stat, mode: 0o100600};
        }
      },
      openedPath: null
    },
    {
      hooks: {
        lstat(path, _node, stat) {
          if (path.endsWith('/src/app.js')) {
            return {...stat, uid: CANDIDATE_STAGE_TEST_UID + 1};
          }
        }
      },
      openedPath: null
    },
    {
      hooks: {
        lstat(path, _node, stat) {
          if (path.endsWith('/src/app.js')) return {...stat, nlink: 2};
        }
      },
      openedPath: null
    },
    {
      hooks: {
        lstat(path, _node, stat) {
          if (path.endsWith('/src/app.js')) {
            return {...stat, isSymbolicLink: () => true};
          }
        }
      },
      openedPath: null
    },
    {
      hooks: {
        lstat(path, _node, stat) {
          if (path === '/synthetic/task/output') {
            return {...stat, mode: 0o040777};
          }
        }
      },
      openedPath: null
    },
    {
      hooks: {
        read(path) {
          if (path.endsWith('/src/app.js')) throw false;
        }
      },
      openedPath: '/src/app.js'
    },
    {
      hooks: {
        close(path) {
          if (path.endsWith('/stage-manifest.json')) throw false;
        }
      },
      openedPath: '/stage-manifest.json'
    }
  ];
  for (const {hooks, openedPath} of faults) {
    const fixture = makeCandidateStageFixture({hooks});
    const result = await verifyProjectArtifactStageWithPorts(
      fixture.captured, undefined, fixture.ports
    );
    assertCandidateStageFailure(result, 'STAGE_CORRUPT_OR_INCOMPLETE');
    if (openedPath) {
      assert.equal(
        fixture.fake.calls.close.filter(path =>
          path.endsWith(openedPath)
        ).length,
        1
      );
    }
  }
});

test('reports aborts before stage IO and after deferred stage or manifest IO settles', async () => {
  const beforeController = new AbortController();
  beforeController.abort();
  const before = makeCandidateStageFixture();
  assertCandidateStageFailure(
    await verifyProjectArtifactStageWithPorts(
      before.captured, beforeController.signal, before.ports
    ),
    'ABORTED'
  );
  assert.equal(before.fake.calls.lstat.length, 0);
  assert.equal(before.fake.calls.readBytes.length, 0);

  const stageController = new AbortController();
  const stageEntered = deferred();
  const stageRelease = deferred();
  let stagePaused = false;
  const duringStage = makeCandidateStageFixture({
    hooks: {
      async beforeLstat() {
        if (stagePaused) return;
        stagePaused = true;
        stageEntered.resolve();
        await stageRelease.promise;
      }
    }
  });
  const stagePending = verifyProjectArtifactStageWithPorts(
    duringStage.captured, stageController.signal, duringStage.ports
  );
  stagePending.then(() => stageEntered.resolve(), () => stageEntered.resolve());
  await stageEntered.promise;
  try {
    stageController.abort();
  } finally {
    stageRelease.resolve();
  }
  assertCandidateStageFailure(await stagePending, 'ABORTED');

  const manifestController = new AbortController();
  const manifestEntered = deferred();
  const manifestRelease = deferred();
  const duringManifest = makeCandidateStageFixture({
    hooks: {
      async readBytes(_path, _maxBytes, bytes) {
        manifestEntered.resolve();
        await manifestRelease.promise;
        return bytes;
      }
    }
  });
  const manifestPending = verifyProjectArtifactStageWithPorts(
    duringManifest.captured,
    manifestController.signal,
    duringManifest.ports
  );
  manifestPending.then(
    () => manifestEntered.resolve(),
    () => manifestEntered.resolve()
  );
  await manifestEntered.promise;
  try {
    manifestController.abort();
  } finally {
    manifestRelease.resolve();
  }
  assertCandidateStageFailure(await manifestPending, 'ABORTED');
  assert.equal(
    duringManifest.fake.calls.close.length,
    duringManifest.stagePlan.files.length + 1
  );
});

test('bounds and copies the stage manifest control read without leaking reader errors', async () => {
  const valid = makeCandidateStageFixture();
  const verified = await verifyProjectArtifactStageWithPorts(
    valid.captured, undefined, valid.ports
  );
  assert.equal(verified.verified, true);
  assert.deepEqual(valid.fake.calls.readBytes, [{
    path: join(valid.stageRoot, 'stage-manifest.json'),
    maxBytes: CANDIDATE_STAGE_MANIFEST_MAX
  }]);

  let oversizedInput;
  let oversizedInputHash;
  let oversizedHookCalls = 0;
  const oversized = makeCandidateStageFixture({
    hooks: {
      readBytes(_path, maxBytes, bytes) {
        oversizedHookCalls++;
        assert.equal(maxBytes, CANDIDATE_STAGE_MANIFEST_MAX);
        oversizedInput = new Uint8Array(maxBytes + 1);
        oversizedInput.set(bytes);
        oversizedInput.fill(0x20, bytes.length);
        oversizedInputHash = hash(oversizedInput);
        return oversizedInput;
      }
    }
  });
  const oversizedResult = await verifyProjectArtifactStageWithPorts(
    oversized.captured, undefined, oversized.ports
  );
  assertCandidateStageFailure(
    oversizedResult, 'STAGE_CORRUPT_OR_INCOMPLETE'
  );
  assert.equal(oversizedHookCalls, 1);
  assert.equal(oversizedInput.length, CANDIDATE_STAGE_MANIFEST_MAX + 1);
  assert.equal(hash(oversizedInput), oversizedInputHash);

  let customPropertyGetterCalls = 0;
  const badProperties = makeCandidateStageFixture({
    hooks: {
      readBytes(_path, _maxBytes, bytes) {
        Object.defineProperty(bytes, 'private', {
          configurable: true,
          get() {
            customPropertyGetterCalls++;
            throw new Error('PRIVATE_BYTE_PROPERTY');
          }
        });
        return bytes;
      }
    }
  });
  assertCandidateStageFailure(
    await verifyProjectArtifactStageWithPorts(
      badProperties.captured, undefined, badProperties.ports
    ),
    'STAGE_CORRUPT_OR_INCOMPLETE'
  );
  assert.equal(customPropertyGetterCalls, 0);

  let byteProxyTraps = 0;
  const proxyBytes = makeCandidateStageFixture({
    hooks: {
      readBytes(_path, _maxBytes, bytes) {
        return new Proxy(bytes, {
          ownKeys() {
            byteProxyTraps++;
            throw new Error('private byte proxy trap');
          }
        });
      }
    }
  });
  assertCandidateStageFailure(
    await verifyProjectArtifactStageWithPorts(
      proxyBytes.captured, undefined, proxyBytes.ports
    ),
    'STAGE_CORRUPT_OR_INCOMPLETE'
  );
  assert.equal(byteProxyTraps, 0);

  const nonIntrinsic = makeCandidateStageFixture({
    hooks: {
      readBytes(_path, _maxBytes, bytes) {
        return Buffer.from(bytes);
      }
    }
  });
  assertCandidateStageFailure(
    await verifyProjectArtifactStageWithPorts(
      nonIntrinsic.captured, undefined, nonIntrinsic.ports
    ),
    'STAGE_CORRUPT_OR_INCOMPLETE'
  );

  const privateReaderError = makeCandidateStageFixture({
    hooks: {
      readBytes() {
        throw new Error('PRIVATE_STAGE_READER_DETAIL');
      }
    }
  });
  const failure = await verifyProjectArtifactStageWithPorts(
    privateReaderError.captured, undefined, privateReaderError.ports
  );
  assertCandidateStageFailure(
    failure, 'STAGE_CORRUPT_OR_INCOMPLETE'
  );
  assert.equal(
    JSON.stringify(failure).includes('PRIVATE_STAGE_READER_DETAIL'),
    false
  );
});

function canonicalCandidateStageManifest(value) {
  const sort = item => Array.isArray(item)
    ? item.map(sort)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [
        key, sort(item[key])
      ]))
      : item;
  return encoder.encode(JSON.stringify(sort(value)));
}

function rebindCandidateStagePhysicalManifest(fixture, mutate) {
  const manifestPath = join(fixture.stageRoot, 'stage-manifest.json');
  const node = fixture.fake.nodes.get(manifestPath);
  assert.ok(node);
  const manifest = JSON.parse(new TextDecoder().decode(node.bytes));
  mutate(manifest);
  node.bytes = canonicalCandidateStageManifest(manifest);
  fixture.fixture.context.candidate.stage_manifest_sha256 = hash(node.bytes);
  fixture.captured = captureFixture(fixture.fixture);
  assert.equal(
    fixture.captured.context.candidate.stage_manifest_sha256,
    hash(node.bytes)
  );
  return node.bytes;
}

async function assertCandidateStagePhysicalManifestRejected(fixture) {
  const manifestPath = join(fixture.stageRoot, 'stage-manifest.json');
  const result = await verifyProjectArtifactStageWithPorts(
    fixture.captured, undefined, fixture.ports
  );
  assertCandidateStageFailure(result, 'STAGE_CORRUPT_OR_INCOMPLETE');
  assert.equal(fixture.fake.calls.readBytes.length, 0);
  assert.equal(
    fixture.fake.calls.open.filter(call => call.path === manifestPath).length,
    1
  );
  assert.ok(
    fixture.fake.calls.read.some(call => call.path === manifestPath)
  );
  assert.equal(
    fixture.fake.calls.close.filter(path => path === manifestPath).length,
    1
  );
}

test('rejects forged abort brands and proxy prototype chains before stage IO', async () => {
  const positive = makeCandidateStageFixture();
  const genuineResult = await verifyProjectArtifactStageWithPorts(
    positive.captured, new AbortController().signal, positive.ports
  );
  assert.equal(genuineResult.verified, true);

  const fixture = makeCandidateStageFixture();
  const forged = Object.create(AbortSignal.prototype);
  const proxyTraps = {
    get: 0,
    has: 0,
    getPrototypeOf: 0,
    getOwnPropertyDescriptor: 0
  };
  const makeTrapProxy = target => new Proxy(target, {
    get() {
      proxyTraps.get++;
      throw new Error('private signal proxy get trap');
    },
    has() {
      proxyTraps.has++;
      throw new Error('private signal proxy has trap');
    },
    getPrototypeOf() {
      proxyTraps.getPrototypeOf++;
      throw new Error('private signal proxy prototype trap');
    },
    getOwnPropertyDescriptor() {
      proxyTraps.getOwnPropertyDescriptor++;
      throw new Error('private signal proxy descriptor trap');
    }
  });

  const wrappedController = new AbortController();
  const proxiedSignal = makeTrapProxy(wrappedController.signal);

  const proxyPrototype = makeTrapProxy(
    Object.create(AbortSignal.prototype)
  );
  const forgedReceiverWithProxyPrototype = Object.create(proxyPrototype);

  const chainedController = new AbortController();
  Object.setPrototypeOf(chainedController.signal, proxyPrototype);
  assert.deepEqual(proxyTraps, {
    get: 0,
    has: 0,
    getPrototypeOf: 0,
    getOwnPropertyDescriptor: 0
  });

  const ordinaryObject = {aborted: false};
  for (const signal of [
    forged,
    forgedReceiverWithProxyPrototype,
    proxiedSignal,
    chainedController.signal,
    ordinaryObject
  ]) {
    await assert.rejects(
      verifyProjectArtifactStageWithPorts(
        fixture.captured, signal, fixture.ports
      ),
      error => error instanceof ProjectArtifactCheckValidationError &&
        error.code === 'INVALID_ARTIFACT_CONTEXT' &&
        error.message === 'INVALID_ARTIFACT_CONTEXT'
    );
  }
  assert.deepEqual(proxyTraps, {
    get: 0,
    has: 0,
    getPrototypeOf: 0,
    getOwnPropertyDescriptor: 0
  });
  assert.equal(fixture.fake.calls.lstat.length, 0);
  assert.equal(fixture.fake.calls.open.length, 0);
  assert.equal(fixture.fake.calls.readBytes.length, 0);
});

test('keeps stage cancellation intrinsic when caller signal properties change across awaits', async () => {
  for (const location of ['filesystem', 'manifest-reader']) {
    const controller = new AbortController();
    const entered = deferred();
    const release = deferred();
    let getterCalls = 0;
    let paused = false;
    const hooks = location === 'filesystem'
      ? {
        async beforeLstat() {
          if (paused) return;
          paused = true;
          Object.defineProperty(controller.signal, 'aborted', {
            configurable: true,
            get() {
              getterCalls++;
              throw new Error('PRIVATE_CALLER_SIGNAL_GETTER');
            }
          });
          entered.resolve();
          await release.promise;
        }
      }
      : {
        async readBytes(_path, _maxBytes, bytes) {
          if (!paused) {
            paused = true;
            Object.defineProperty(controller.signal, 'aborted', {
              configurable: true,
              get() {
                getterCalls++;
                return false;
              }
            });
            entered.resolve();
            await release.promise;
          }
          return bytes;
        }
      };
    const fixture = makeCandidateStageFixture({hooks});
    const pending = verifyProjectArtifactStageWithPorts(
      fixture.captured, controller.signal, fixture.ports
    );
    pending.then(() => entered.resolve(), () => entered.resolve());
    await entered.promise;
    try {
      assert.equal(getterCalls, 0);
    } finally {
      release.resolve();
    }
    const result = await pending;
    assert.equal(result.verified, true);
    assert.equal(getterCalls, 0);
    assert.equal(fixture.fake.calls.readBytes.length, 1);
  }

  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  let getterCalls = 0;
  let paused = false;
  const fixture = makeCandidateStageFixture({
    hooks: {
      async read(path, _node, _buffer, _offset, _length, position) {
        if (path.endsWith('/src/app.js') && position === 0 && !paused) {
          paused = true;
          Object.defineProperty(controller.signal, 'aborted', {
            configurable: true,
            get() {
              getterCalls++;
              throw new Error('PRIVATE_CALLER_SIGNAL_GETTER');
            }
          });
          entered.resolve();
          await release.promise;
        }
        return undefined;
      }
    }
  });
  const pending = verifyProjectArtifactStageWithPorts(
    fixture.captured, controller.signal, fixture.ports
  );
  pending.then(() => entered.resolve(), () => entered.resolve());
  await entered.promise;
  try {
    controller.abort();
  } finally {
    release.resolve();
  }
  assertCandidateStageFailure(await pending, 'ABORTED');
  assert.equal(getterCalls, 0);
  assert.equal(
    fixture.fake.calls.close.filter(path => path.endsWith('/src/app.js')).length,
    1
  );
});

test('binds changed manifest reread bytes after successful physical verification', async () => {
  let hookCalls = 0;
  let returnedBytes;
  let returnedHash;
  let hookInput;
  let hookInputHash;
  const fixture = makeCandidateStageFixture({
    hooks: {
      readBytes(_path, maxBytes, bytes) {
        hookCalls++;
        assert.equal(maxBytes, CANDIDATE_STAGE_MANIFEST_MAX);
        hookInput = bytes;
        hookInputHash = hash(bytes);
        const originalText = new TextDecoder().decode(bytes);
        const changedText = originalText.replace(
          '"caller_label":"synthetic-stage"',
          '"caller_label":"synthetic-stagf"'
        );
        assert.notEqual(changedText, originalText);
        returnedBytes = encoder.encode(changedText);
        assert.equal(returnedBytes.length, bytes.length);
        returnedHash = hash(returnedBytes);
        return returnedBytes;
      }
    }
  });
  const manifestPath = join(fixture.stageRoot, 'stage-manifest.json');
  const expectedHash = fixture.stagePlan.manifest_sha256;
  assert.equal(
    fixture.captured.context.candidate.stage_manifest_sha256, expectedHash
  );

  const result = await verifyProjectArtifactStageWithPorts(
    fixture.captured, undefined, fixture.ports
  );
  assertCandidateStageFailure(result, 'BINDING_MISMATCH');
  assert.equal(hookCalls, 1);
  assert.equal(fixture.fake.calls.readBytes.length, 1);
  assert.equal(
    fixture.fake.calls.open.filter(call => call.path === manifestPath).length,
    1
  );
  assert.ok(fixture.fake.calls.read.some(call => call.path === manifestPath));
  assert.equal(
    fixture.fake.calls.close.filter(path => path === manifestPath).length,
    1
  );
  assert.notEqual(returnedHash, expectedHash);
  assert.equal(hash(returnedBytes), returnedHash);
  assert.equal(hash(hookInput), hookInputHash);
});

test('rejects malformed physical manifest metadata through the unchanged verifier', async () => {
  const mutations = [
    ['schema', manifest => {
      manifest.schema_version = 'squire4.large_project_stage_manifest.v999';
    }],
    ['profile', manifest => {
      manifest.output_profile.max_source_total_bytes++;
    }],
    ['count', manifest => {
      manifest.file_counts.source = 0;
    }],
    ['member metadata', manifest => {
      manifest.files[0].sha256 = '9'.repeat(64);
    }],
    ['unsafe integer', manifest => {
      manifest.files[0].bytes = Number.MAX_SAFE_INTEGER + 1;
    }]
  ];
  for (const [_name, mutate] of mutations) {
    const fixture = makeCandidateStageFixture();
    rebindCandidateStagePhysicalManifest(fixture, mutate);
    await assertCandidateStagePhysicalManifestRejected(fixture);
  }
});

test('accepts the DOC aggregate boundary and rejects one byte above it physically', async () => {
  const sourceBytes = encoder.encode('valid source at DOC boundary');
  const docOne = new Uint8Array(65_536).fill(0x41);
  const docTwo = new Uint8Array(65_536).fill(0x42);
  const atBoundary = makeCandidateStageFixture({
    files: [
      {path: 'src/app.js', classification: 'SOURCE', content: sourceBytes},
      {path: 'docs/one.md', classification: 'DOC', content: docOne},
      {path: 'docs/two.md', classification: 'DOC', content: docTwo}
    ],
    artifacts: (plan, stageRoot) => {
      const source = plan.files.find(file => file.path === 'src/app.js');
      return [makeArtifact({
        artifact_id: 'app-main',
        role: 'staged',
        root: stageRoot,
        relative_path: source.path,
        byte_count: source.bytes,
        sha256: source.sha256
      })];
    }
  });
  assert.equal(
    atBoundary.stagePlan.files
      .filter(file => file.classification === 'DOC')
      .reduce((total, file) => total + file.bytes, 0),
    131_072
  );
  const boundaryResult = await verifyProjectArtifactStageWithPorts(
    atBoundary.captured, undefined, atBoundary.ports
  );
  assert.equal(boundaryResult.verified, true);

  const overBoundary = makeCandidateStageFixture({
    files: [
      {path: 'src/app.js', classification: 'SOURCE', content: sourceBytes},
      {path: 'docs/one.md', classification: 'DOC', content: docOne},
      {path: 'docs/two.md', classification: 'DOC', content: docTwo},
      {path: 'docs/empty.md', classification: 'DOC', content: new Uint8Array()}
    ],
    artifacts: (plan, stageRoot) => {
      const source = plan.files.find(file => file.path === 'src/app.js');
      return [makeArtifact({
        artifact_id: 'app-main',
        role: 'staged',
        root: stageRoot,
        relative_path: source.path,
        byte_count: source.bytes,
        sha256: source.sha256
      })];
    }
  });
  rebindCandidateStagePhysicalManifest(overBoundary, manifest => {
    const emptyDoc = manifest.files.find(
      file => file.path === 'docs/empty.md'
    );
    assert.ok(emptyDoc);
    emptyDoc.bytes = 1;
    emptyDoc.sha256 = hash(encoder.encode('x'));
    manifest.total_bytes++;
  });
  await assertCandidateStagePhysicalManifestRejected(overBoundary);
});

const SIDECAR_TEST_CONTROL_MAX = 65_536;

function sidecarReceiptBytes(value, size = null) {
  const raw = encoder.encode(JSON.stringify(value));
  if (size === null) return raw;
  if (raw.length > size) throw new Error('SIDECAR_FIXTURE_SIZE');
  const padded = new Uint8Array(size);
  padded.set(raw);
  padded.fill(0x20, raw.length);
  return padded;
}

function sidecarFakePayload(value) {
  const bytes = new Uint8Array(value);
  return {
    bytes,
    length: bytes.length,
    byteValue: bytes[0] ?? 0,
    sha256: hash(bytes)
  };
}

function makeSidecarFixture(options = {}) {
  const config = options.config ?? makeConfig();
  const stageRoot = join(
    config.scope, 'output', `run-${config.job_id}`, 'stage'
  );
  const sourceBytes = options.sourceBytes ??
    encoder.encode('sidecar synthetic application');
  const stagePlan = planLargeProjectStaging({
    stage_operation_id: `stage-${config.job_id}`,
    caller_label: 'sidecar-stage',
    output_profile: PROJECT_OUTPUT_LARGE_PROFILE,
    files: [{
      path: 'src/app.js', classification: 'SOURCE', content: sourceBytes
    }]
  });
  const source = stagePlan.files[0];
  const artifacts = [
    makeArtifact({
      artifact_id: 'main-app', role: 'staged', root: stageRoot,
      relative_path: source.path, byte_count: source.bytes,
      sha256: source.sha256
    }),
    makeArtifact({
      artifact_id: 'copy-app', role: 'delivered_copy',
      root: '/synthetic/delivery', relative_path: 'app.js',
      byte_count: source.bytes, sha256: source.sha256,
      staged_artifact_id: 'main-app'
    })
  ];
  const ids = options.checkIds ?? ['check-main'];
  const definitions = options.definitions ?? ids.map(() =>
    encoder.encode('sidecar synthetic definition')
  );
  const checks = ids.map((id, index) => makeCheck(
    id, ['copy-app', 'main-app'], {
      definitionPath: `/synthetic/evidence/${id}.definition`,
      definitionBytes: definitions[index],
      receiptPath: `/synthetic/evidence/${id}.receipt`
    }
  ));
  const fixture = makeFixture({config, artifacts, checks});
  fixture.context.candidate.stage_manifest_sha256 =
    stagePlan.manifest_sha256;
  let captured = captureFixture(fixture);
  const evidence = new Map();
  const receipts = options.receipts ?? ids.map(() => ({}));
  for (let index = 0; index < checks.length; index++) {
    const check = captured.context.required_checks[index];
    const receipt = {
      schema: 'squire.project_artifact_check_receipt.v2',
      check_id: check.check_id,
      definition_sha256: check.definition_pin.sha256,
      job_id: captured.context.job_id,
      operation_config_sha256: captured.operation_config_sha256,
      stage_manifest_sha256:
        captured.context.candidate.stage_manifest_sha256,
      artifact_subset_sha256:
        projectArtifactSubsetHash(captured, check.check_id),
      observer_policy_sha256:
        captured.context.observer_policy_sha256,
      observer_role: 'trusted_owner_fixture',
      status: 'passed',
      reason: 'NONE',
      terminal: terminal(),
      limitations: [],
      ...copy(receipts[index])
    };
    const bytes = sidecarReceiptBytes(
      receipt, options.receiptLength ?? null
    );
    fixture.context.required_checks[index].receipt_pin = {
      ...fixture.context.required_checks[index].receipt_pin,
      bytes: bytes.length,
      sha256: hash(bytes)
    };
    evidence.set(check.definition_pin.path, new Uint8Array(definitions[index]));
    evidence.set(check.receipt_pin.path, bytes);
  }
  fixture.contextBytes = encoder.encode(JSON.stringify(fixture.context));
  captured = captureProjectArtifactCheckData({
    configBytes: fixture.configBytes,
    artifactContextBytes: fixture.contextBytes
  });

  const fileSpecs = [
    {
      artifact_id: 'main-app', role: 'staged', root: stageRoot,
      relative_path: source.path, payload: sidecarFakePayload(sourceBytes)
    },
    {
      artifact_id: 'copy-app', role: 'delivered_copy',
      root: '/synthetic/delivery', relative_path: 'app.js',
      payload: sidecarFakePayload(sourceBytes)
    },
    ...[...evidence].map(([path, bytes], index) => ({
      artifact_id: `evidence-${index}`,
      root: dirname(path),
      relative_path: path.slice(dirname(path).length + 1),
      payload: sidecarFakePayload(bytes)
    }))
  ];
  const stageFake = makeCandidateStageIO(
    stagePlan, stageRoot, options.stageHooks
  );
  const fileFake = makeArtifactFileSystem(fileSpecs, options.fileHooks);
  const manifestPath = join(stageRoot, 'stage-manifest.json');
  const calls = {
    readBytes: [], factories: 0, next: 0, returns: 0,
    verifyFile: 0, mkdir: 0, chmod: 0
  };
  let stageComplete = false;
  const fs = {
    async lstat(path, ...args) {
      return args[0]?.bigint === true
        ? fileFake.fs.lstat(path, ...args)
        : stageFake.fs.lstat(path, ...args);
    },
    async realpath(path, ...args) {
      if (path === stageRoot || path === manifestPath ||
          !stageComplete && path.startsWith(`${stageRoot}/`)) {
        return stageFake.fs.realpath(path, ...args);
      }
      return fileFake.fs.realpath(path, ...args);
    },
    async open(path, ...args) {
      if (path === manifestPath ||
          !stageComplete && path.startsWith(`${stageRoot}/`)) {
        return stageFake.fs.open(path, ...args);
      }
      return fileFake.fs.open(path, ...args);
    },
    async mkdir(...args) { calls.mkdir++; return stageFake.fs.mkdir(...args); },
    async chmod(...args) { calls.chmod++; return stageFake.fs.chmod(...args); },
    async readdir(...args) { return stageFake.fs.readdir(...args); }
  };
  const readBytes = async (path, maxBytes) => {
    calls.readBytes.push({path, maxBytes});
    if (path === manifestPath) {
      const bytes = await stageFake.readBytes(path, maxBytes);
      stageComplete = true;
      return bytes;
    }
    const bytes = evidence.get(path);
    if (!bytes) {
      throw Object.assign(new Error('synthetic missing'), {code: 'ENOENT'});
    }
    if (maxBytes > SIDECAR_TEST_CONTROL_MAX) {
      throw new Error('control read over-request');
    }
    return new Uint8Array(bytes);
  };
  const reads = {
    async lstat(path) {
      const stat = await fileFake.fs.lstat(path, {bigint: true});
      return {
        size: Number(stat.size),
        isFile: stat.isFile,
        isDirectory: stat.isDirectory,
        isSymbolicLink: stat.isSymbolicLink
      };
    },
    readChunks(path) {
      calls.factories++;
      const bytes = evidence.get(path);
      if (!bytes) {
        throw Object.assign(new Error('synthetic missing'), {code: 'ENOENT'});
      }
      let offset = 0;
      let closed = false;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              calls.next++;
              if (closed || offset >= bytes.length) {
                closed = true;
                return {done: true};
              }
              const end = Math.min(offset + 16_384, bytes.length);
              const value = new Uint8Array(bytes.subarray(offset, end));
              offset = end;
              return {done: false, value};
            },
            async return() {
              calls.returns++;
              closed = true;
              return {done: true};
            }
          };
        }
      };
    }
  };
  const verifyFile = async (identity, suppliedReads) => {
    calls.verifyFile++;
    return verifyExactFile(identity, suppliedReads);
  };
  return {
    fixture, captured, stagePlan, stageFake, fileFake, evidence, calls,
    ports: {fs, uid: ARTIFACT_FILE_TEST_UID, readBytes, verifyFile, reads}
  };
}

test('resolves actual stage and file helpers, streams definitions, and encodes canonical bytes', async () => {
  const fixture = makeSidecarFixture({checkIds: ['z-check', 'a-check']});
  const result = await resolveProjectArtifactChecksWithPorts(
    fixture.fixture.configBytes, fixture.fixture.contextBytes,
    undefined, fixture.ports
  );
  assert.equal(result.sidecar.coverage, 'DECLARED_CHECKS_PASSED');
  assert.equal(result.sidecar.reason, 'NONE');
  assert.deepEqual(
    result.sidecar.check_results.map(item => item.check_id),
    ['z-check', 'a-check']
  );
  assert.deepEqual(
    result.sidecar.artifact_witness.map(item => item.artifact_id),
    ['copy-app', 'main-app']
  );
  assert.deepEqual(result.sidecar.limitations, [
    'DESCENDANTS_NOT_ESTABLISHED', 'HOST_IO_NOT_PREEMPTIBLE',
    'NATIVE_NOT_EXECUTED_BY_RESOLVER', 'PRODUCT_NOT_EVALUATED',
    'STAGE_ACKNOWLEDGEMENT_UNKNOWN', 'TRUSTED_CALLER_ORIGIN'
  ]);
  assert.equal(result.sidecar.task_correctness, 'NOT_EVALUATED');
  assert.equal(result.sidecar.task_outcome_evaluated, false);
  assert.equal(
    result.sidecar.provenance_authenticity,
    'TRUSTED_CALLER_EVIDENCE_NOT_CRYPTOGRAPHICALLY_ESTABLISHED'
  );
  assert.equal(JSON.stringify(result.sidecar).includes('/synthetic/task'), false);
  assert.equal(JSON.stringify(result.sidecar).includes('/synthetic/delivery'), false);
  assert.equal(fixture.calls.verifyFile, 2);
  assert.equal(fixture.calls.factories, 2);
  assert.equal(fixture.calls.mkdir, 0);
  assert.equal(fixture.calls.chmod, 0);
  assert.ok(fixture.calls.readBytes.every(
    call => call.maxBytes <= SIDECAR_TEST_CONTROL_MAX
  ));
  assert.equal(fixture.stageFake.calls.readBytes.length, 1);
  assert.equal(fixture.stageFake.calls.open.length, 2);
  assert.equal(fixture.fileFake.calls.open.length, 2);
  assert.equal(fixture.fileFake.calls.payloadBytes,
    2 * encoder.encode('sidecar synthetic application').length);
  assert.equal(fixture.fileFake.calls.eofReads, 2);
  assert.deepEqual(
    [...fixture.fileFake.nodes.get(
      join(fixture.stagePlan.files[0] ?
        fixture.fixture.context.candidate.stage_root : '', 'src/app.js')
    ).bytes],
    [...encoder.encode('sidecar synthetic application')]
  );
  const canonical = encodeProjectArtifactCheckSidecar(result.sidecar);
  assert.deepEqual([...result.bytes], [...canonical]);
  assert.notEqual(result.bytes.buffer, canonical.buffer);
  assert.ok(Object.isFrozen(result.sidecar));
});

test('reduces failed, signaled, blocked, and explicit not-run receipts as declared failures', async () => {
  const negatives = [
    {status: 'failed', reason: 'CHECK_FAILED'},
    {status: 'failed', reason: 'ABORTED'},
    {
      status: 'failed', reason: 'CHECK_FAILED',
      terminal: terminal({exit_code: 9})
    },
    {
      status: 'failed', reason: 'CHECK_FAILED',
      terminal: terminal({exit_kind: 'signal', exit_code: null, signal: 'SIGTERM'})
    },
    {status: 'blocked', reason: 'CHECK_UNAVAILABLE', terminal: null},
    {status: 'not_run', reason: 'EXPLICIT_NOT_RUN', terminal: null}
  ];
  for (const receipt of negatives) {
    const fixture = makeSidecarFixture({receipts: [receipt]});
    const result = await resolveProjectArtifactChecksWithPorts(
      fixture.fixture.configBytes, fixture.fixture.contextBytes,
      undefined, fixture.ports
    );
    assert.equal(result.sidecar.coverage, 'DECLARED_CHECKS_FAILED');
    assert.equal(result.sidecar.check_results[0].status, receipt.status);
    assert.equal(result.sidecar.check_results[0].evidence_binding, 'verified');
    if (receipt.reason === 'ABORTED') {
      assert.equal(result.sidecar.reason, 'ABORTED');
      assert.deepEqual(result.sidecar.io_failures, []);
    }
  }
});

test('retains later check results after missing, malformed, and binding-invalid evidence', async () => {
  for (const fault of ['missing-receipt', 'missing-definition', 'bad-subset']) {
    const fixture = makeSidecarFixture({
      checkIds: ['first-check', 'later-check'],
      receipts: [{}, {status: 'failed', reason: 'CHECK_FAILED'}]
    });
    const first = fixture.fixture.context.required_checks[0];
    if (fault === 'missing-receipt') {
      fixture.evidence.delete(first.receipt_pin.path);
    } else if (fault === 'missing-definition') {
      fixture.evidence.delete(first.definition_pin.path);
    } else {
      const receipt = JSON.parse(new TextDecoder().decode(
        fixture.evidence.get(first.receipt_pin.path)
      ));
      receipt.artifact_subset_sha256 = '9'.repeat(64);
      const bytes = sidecarReceiptBytes(receipt);
      fixture.evidence.set(first.receipt_pin.path, bytes);
      first.receipt_pin.bytes = bytes.length;
      first.receipt_pin.sha256 = hash(bytes);
      fixture.fixture.contextBytes =
        encoder.encode(JSON.stringify(fixture.fixture.context));
    }
    const result = await resolveProjectArtifactChecksWithPorts(
      fixture.fixture.configBytes, fixture.fixture.contextBytes,
      undefined, fixture.ports
    );
    assert.equal(result.sidecar.coverage, 'BLOCKED');
    assert.equal(result.sidecar.check_results.length, 2);
    assert.equal(result.sidecar.check_results[0].evidence_binding, 'unresolved');
    assert.equal(result.sidecar.check_results[1].status, 'failed');
    assert.equal(result.sidecar.check_results[1].evidence_binding, 'verified');
    assert.ok(result.sidecar.check_results[0].artifact_subset_sha256);
  }
});

test('blocks stage and artifact failures with empty witnesses and every required ID', async () => {
  const badStage = makeSidecarFixture({
    checkIds: ['first-check', 'second-check'],
    stageHooks: {readdir(path) { return path.endsWith('/stage') ? [] : undefined; }}
  });
  const stage = await resolveProjectArtifactChecksWithPorts(
    badStage.fixture.configBytes, badStage.fixture.contextBytes,
    undefined, badStage.ports
  );
  assert.equal(stage.sidecar.coverage, 'BLOCKED');
  assert.deepEqual(stage.sidecar.artifact_witness, []);
  assert.equal(stage.sidecar.check_results.length, 2);
  assert.equal(badStage.calls.readBytes.length, 0);

  const badFiles = makeSidecarFixture({
    checkIds: ['first-check', 'second-check'],
    fileHooks: {read(record) {
      if (record.path.endsWith('/src/app.js')) throw undefined;
      return undefined;
    }}
  });
  const files = await resolveProjectArtifactChecksWithPorts(
    badFiles.fixture.configBytes, badFiles.fixture.contextBytes,
    undefined, badFiles.ports
  );
  assert.equal(files.sidecar.coverage, 'BLOCKED');
  assert.deepEqual(files.sidecar.artifact_witness, []);
  assert.equal(files.sidecar.check_results.length, 2);
  assert.ok(files.sidecar.check_results.every(
    item => item.evidence_binding === 'unresolved'
  ));
  assert.equal(badFiles.calls.readBytes.length, 1);
});

test('rejects physical aliases and changed evidence stats while retaining independent post-read IO', async () => {
  const alias = makeSidecarFixture({
    fileHooks: {realpath(path) {
      return path.endsWith('.definition')
        ? `${PROJECT_SCOPE}/output/run-${uuid}/stage/alias`
        : undefined;
    }}
  });
  const aliased = await resolveProjectArtifactChecksWithPorts(
    alias.fixture.configBytes, alias.fixture.contextBytes,
    undefined, alias.ports
  );
  assert.equal(aliased.sidecar.coverage, 'BLOCKED');
  assert.equal(aliased.sidecar.reason, 'BINDING_MISMATCH');

  for (const mutate of [
    stat => ({...stat, uid: BigInt(ARTIFACT_FILE_TEST_UID + 1)}),
    stat => ({...stat, nlink: 2n}),
    stat => ({...stat, size: stat.size + 1n}),
    stat => ({...stat, isDirectory: () => true}),
    stat => ({...stat, isSymbolicLink: () => true})
  ]) {
    let target;
    const fixture = makeSidecarFixture({
      fileHooks: {lstat(path, _count, stat) {
        return path === target ? mutate(stat) : undefined;
      }}
    });
    target = fixture.fixture.context.required_checks[0].definition_pin.path;
    const result = await resolveProjectArtifactChecksWithPorts(
      fixture.fixture.configBytes, fixture.fixture.contextBytes,
      undefined, fixture.ports
    );
    assert.equal(result.sidecar.coverage, 'BLOCKED');
    assert.equal(result.sidecar.reason, 'ARTIFACT_CHANGED');
  }

  const trace = [];
  let target;
  const combined = makeSidecarFixture({
    fileHooks: {lstat(path, count) {
      if (path === target && count >= 2) {
        trace.push('post-read-stat');
        throw null;
      }
      return undefined;
    }}
  });
  const check = combined.fixture.context.required_checks[0];
  target = check.receipt_pin.path;
  const originalPinHash = check.receipt_pin.sha256;
  const receipt = JSON.parse(new TextDecoder().decode(
    combined.evidence.get(target)
  ));
  receipt.job_id = uuid2;
  const invalidRawBytes = sidecarReceiptBytes(receipt);
  assert.equal(invalidRawBytes.length, check.receipt_pin.bytes);
  assert.notEqual(hash(invalidRawBytes), originalPinHash);
  combined.evidence.set(target, invalidRawBytes);
  const originalReadBytes = combined.ports.readBytes;
  combined.ports.readBytes = async function (path, maxBytes) {
    if (path === target) trace.push('receipt-read');
    return Reflect.apply(originalReadBytes, this, [path, maxBytes]);
  };
  const combinedResult = await resolveProjectArtifactChecksWithPorts(
    combined.fixture.configBytes, combined.fixture.contextBytes,
    undefined, combined.ports
  );
  assert.deepEqual(trace, ['receipt-read', 'post-read-stat']);
  assert.equal(combinedResult.sidecar.coverage, 'BLOCKED');
  assert.equal(combinedResult.sidecar.check_results[0].reason, 'ARTIFACT_IO');
  assert.ok(combinedResult.sidecar.io_failures.includes('IO_FAILED'));
  assert.equal(combinedResult.sidecar.reason, 'ARTIFACT_IO');
});

test('accepts one MiB definitions and sixteen MiB aggregate while bounding control reads', async () => {
  const definition = new Uint8Array(1_048_576).fill(0x41);
  const ids = Array.from({length: 16}, (_, index) =>
    `check-${String(index).padStart(2, '0')}`
  );
  const fixture = makeSidecarFixture({
    checkIds: ids,
    definitions: ids.map(() => definition),
    receiptLength: SIDECAR_TEST_CONTROL_MAX
  });
  const result = await resolveProjectArtifactChecksWithPorts(
    fixture.fixture.configBytes, fixture.fixture.contextBytes,
    undefined, fixture.ports
  );
  assert.equal(result.sidecar.coverage, 'DECLARED_CHECKS_PASSED');
  assert.equal(result.sidecar.check_results.length, 16);
  assert.equal(fixture.calls.verifyFile, 16);
  assert.equal(fixture.calls.factories, 16);
  assert.ok(fixture.calls.readBytes.every(
    call => call.maxBytes <= SIDECAR_TEST_CONTROL_MAX
  ));
});

test('settles every started definition stat before reducing the sidecar', async () => {
  const positive = makeSidecarFixture();
  const positiveDefinition =
    positive.fixture.context.required_checks[0].definition_pin.path;
  const positiveVerifyFile = positive.ports.verifyFile;
  let positiveStatOutcome = null;
  positive.ports.verifyFile = async function (identity, reads) {
    if (identity.path !== positiveDefinition) {
      return Reflect.apply(positiveVerifyFile, this, [identity, reads]);
    }
    const extra = reads.lstat(identity.path);
    const observer = extra.then(
      () => { positiveStatOutcome = 'resolved'; },
      () => { positiveStatOutcome = 'rejected'; }
    );
    const verification = await Reflect.apply(
      positiveVerifyFile, this, [identity, reads]
    );
    await observer;
    return verification;
  };
  const positiveResult = await resolveProjectArtifactChecksWithPorts(
    positive.fixture.configBytes, positive.fixture.contextBytes,
    undefined, positive.ports
  );
  assert.equal(positiveResult.sidecar.coverage, 'DECLARED_CHECKS_PASSED');
  assert.equal(positiveStatOutcome, 'resolved');
  assert.equal(positive.calls.verifyFile, 1);
  assert.ok(positive.calls.next > 0);

  for (const thrown of [undefined, null, false, 0, '']) {
    const fixture = makeSidecarFixture({
      checkIds: ['first-check', 'later-check']
    });
    const target =
      fixture.fixture.context.required_checks[0].definition_pin.path;
    const releaseExtraStat = deferred();
    const releasePostReadStat = deferred();
    const verifierCompleted = deferred();
    const events = [];
    const originalReadsLstat = fixture.ports.reads.lstat;
    const originalFsLstat = fixture.ports.fs.lstat;
    const originalVerifyFile = fixture.ports.verifyFile;
    let extraStatStarted = false;
    let extraStatSettled = false;
    let verifyFileReturned = false;
    let postReadStatCalls = 0;
    let extraObserver = null;
    let verificationForwarder = null;

    fixture.ports.reads.lstat = function (path, ...args) {
      if (path === target && !extraStatStarted) {
        extraStatStarted = true;
        return releaseExtraStat.promise.then(() => {
          events.push('extra-stat-rejected');
          throw thrown;
        });
      }
      return Reflect.apply(originalReadsLstat, this, [path, ...args]);
    };
    fixture.ports.fs.lstat = function (path, ...args) {
      if (path === target && verifyFileReturned) {
        postReadStatCalls++;
        events.push('post-read-stat');
        return releasePostReadStat.promise.then(() =>
          Reflect.apply(originalFsLstat, this, [path, ...args])
        );
      }
      return Reflect.apply(originalFsLstat, this, [path, ...args]);
    };
    fixture.ports.verifyFile = function (identity, reads) {
      if (identity.path !== target) {
        return Reflect.apply(originalVerifyFile, this, [identity, reads]);
      }
      const extra = reads.lstat(identity.path);
      extraObserver = extra.then(
        () => {
          extraStatSettled = true;
          return {kind: 'resolved'};
        },
        error => {
          extraStatSettled = true;
          return {kind: 'rejected', error};
        }
      );
      const actualVerification = Reflect.apply(
        originalVerifyFile, this, [identity, reads]
      );
      return {
        then(resolve, reject) {
          verificationForwarder = actualVerification.then(
            value => {
              verifyFileReturned = true;
              resolve(value);
              verifierCompleted.resolve();
            },
            error => {
              verifyFileReturned = true;
              reject(error);
              verifierCompleted.resolve();
            }
          );
          return verificationForwarder;
        }
      };
    };

    const pending = resolveProjectArtifactChecksWithPorts(
      fixture.fixture.configBytes, fixture.fixture.contextBytes,
      undefined, fixture.ports
    );
    const watch = observeGateOrSettlement(pending, verifierCompleted);
    let prerequisiteError = null;
    try {
      const first = await watch.observed;
      assert.equal(first.kind, 'entered');
      assert.equal(extraStatStarted, true);
      assert.equal(extraStatSettled, false);
      assert.equal(verifyFileReturned, true);
      assert.equal(fixture.calls.verifyFile, 1);
      assert.ok(fixture.calls.factories > 0);
      assert.ok(fixture.calls.next > 0);
      assert.equal(postReadStatCalls, 0);
    } catch (error) {
      prerequisiteError = error;
    } finally {
      releaseExtraStat.resolve();
      releasePostReadStat.resolve();
    }

    const extraOutcome = extraObserver
      ? await extraObserver
      : {kind: 'not-started'};
    if (verificationForwarder) await verificationForwarder;
    const outcome = await watch.settled;
    if (prerequisiteError) throw prerequisiteError;
    assert.equal(extraOutcome.kind, 'rejected');
    assert.equal(outcome.ok, true);
    assert.equal(outcome.value.sidecar.coverage, 'BLOCKED');
    assert.equal(outcome.value.sidecar.check_results.length, 2);
    assert.deepEqual(
      outcome.value.sidecar.check_results.map(item => item.check_id),
      ['first-check', 'later-check']
    );
    assert.equal(outcome.value.sidecar.check_results[0].status, 'blocked');
    assert.equal(outcome.value.sidecar.check_results[0].reason, 'ARTIFACT_IO');
    assert.equal(
      outcome.value.sidecar.check_results[0].evidence_binding, 'unresolved'
    );
    assert.equal(outcome.value.sidecar.check_results[1].status, 'passed');
    assert.equal(
      outcome.value.sidecar.check_results[1].evidence_binding, 'verified'
    );
    assert.ok(outcome.value.sidecar.io_failures.includes('IO_FAILED'));
    assert.equal(outcome.value.sidecar.reason, 'ARTIFACT_IO');
    assert.deepEqual(events, ['extra-stat-rejected', 'post-read-stat']);
  }
});

test('rejects stream overflow, premature EOF, and malformed iterator results', async () => {
  const overflow = makeSidecarFixture();
  const original = overflow.ports.reads.readChunks;
  let returns = 0;
  overflow.ports.reads.readChunks = function (path) {
    const source = Reflect.apply(original, this, [path]);
    return {
      [Symbol.asyncIterator]() {
        const iterator = source[Symbol.asyncIterator]();
        let first = true;
        return {
          async next() {
            const item = await iterator.next();
            if (!first || item.done) return item;
            first = false;
            const extra = new Uint8Array(item.value.length + 2);
            extra.set(item.value);
            return {done: false, value: extra};
          },
          async return() {
            returns++;
            return iterator.return();
          }
        };
      }
    };
  };
  const overflowResult = await resolveProjectArtifactChecksWithPorts(
    overflow.fixture.configBytes, overflow.fixture.contextBytes,
    undefined, overflow.ports
  );
  assert.equal(overflowResult.sidecar.coverage, 'BLOCKED');
  assert.equal(returns, 1);

  for (const mode of ['premature-eof', 'malformed']) {
    const fixture = makeSidecarFixture();
    const originalReadChunks = fixture.ports.reads.readChunks;
    fixture.ports.reads.readChunks = function (path) {
      const source = Reflect.apply(originalReadChunks, this, [path]);
      if (mode === 'malformed') {
        return {
          [Symbol.asyncIterator]() {
            const iterator = source[Symbol.asyncIterator]();
            return {
              async next() {
                return {done: 'malformed', value: new Uint8Array([1])};
              },
              async return() {
                return iterator.return();
              }
            };
          }
        };
      }
      return {
        [Symbol.asyncIterator]() {
          const iterator = source[Symbol.asyncIterator]();
          return {
            async next() { return {done: true}; },
            async return() { return iterator.return(); }
          };
        }
      };
    };
    const result = await resolveProjectArtifactChecksWithPorts(
      fixture.fixture.configBytes, fixture.fixture.contextBytes,
      undefined, fixture.ports
    );
    assert.equal(result.sidecar.coverage, 'BLOCKED');
    assert.equal(result.sidecar.check_results[0].evidence_binding, 'unresolved');
    assert.equal(result.sidecar.check_results[0].reason,
      mode === 'malformed' ? 'INVALID_EVIDENCE' : 'ARTIFACT_CHANGED');
    assert.equal(fixture.calls.verifyFile, 1);
    assert.equal(fixture.calls.factories, 1);
    assert.equal(fixture.calls.returns, mode === 'malformed' ? 1 : 0);
  }
});

test('rejects iterator setup accessors and invalid methods without invoking getters and closes owners', async () => {
  for (const mode of ['accessor', 'proxy-method', 'invalid-method']) {
    let getterCalls = 0;
    const fixture = makeSidecarFixture({
      checkIds: ['first-check', 'later-check']
    });
    const original = fixture.ports.reads.readChunks;
    const firstDefinition =
      fixture.fixture.context.required_checks[0].definition_pin.path;
    fixture.ports.reads.readChunks = function (path) {
      const source = Reflect.apply(original, this, [path]);
      if (path !== firstDefinition) return source;
      return {
        [Symbol.asyncIterator]() {
          const iterator = {
            async return() {
              fixture.calls.returns++;
              return {done: true};
            }
          };
          if (mode === 'accessor') {
            Object.defineProperty(iterator, 'next', {
              get() {
                getterCalls++;
                throw new Error('PRIVATE_NEXT_GETTER');
              }
            });
          } else {
            Object.defineProperty(iterator, 'next', {
              value: mode === 'proxy-method'
                ? new Proxy(async () => ({done: true}), {})
                : 7,
              enumerable: true
            });
          }
          return iterator;
        }
      };
    };
    const result = await resolveProjectArtifactChecksWithPorts(
      fixture.fixture.configBytes, fixture.fixture.contextBytes,
      undefined, fixture.ports
    );
    assert.equal(result.sidecar.coverage, 'BLOCKED');
    assert.deepEqual(
      result.sidecar.check_results.map(item => item.check_id),
      ['first-check', 'later-check']
    );
    assert.equal(result.sidecar.check_results[0].status, 'blocked');
    assert.equal(result.sidecar.check_results[0].reason, 'INVALID_EVIDENCE');
    assert.equal(result.sidecar.check_results[0].evidence_binding, 'unresolved');
    assert.equal(result.sidecar.check_results[1].evidence_binding, 'verified');
    assert.equal(fixture.calls.returns, 1);
    assert.equal(getterCalls, 0);
  }
});

test('rejects duplicate iterator acquisition and closes the first owner once', async () => {
  const fixture = makeSidecarFixture();
  fixture.ports.verifyFile = async (identity, reads) => {
    const iterable = reads.readChunks(identity.path);
    const first = iterable[Symbol.asyncIterator]();
    iterable[Symbol.asyncIterator]();
    await first.next();
    return identity;
  };
  const result = await resolveProjectArtifactChecksWithPorts(
    fixture.fixture.configBytes, fixture.fixture.contextBytes,
    undefined, fixture.ports
  );
  assert.equal(result.sidecar.coverage, 'BLOCKED');
  assert.equal(fixture.calls.returns, 1);
  assert.ok(result.sidecar.io_failures.includes('LIMIT'));
});

test('records falsy host IO and cleanup failures independently', async () => {
  for (const thrown of [undefined, null, false, 0, '']) {
    const fixture = makeSidecarFixture();
    const original = fixture.ports.readBytes;
    fixture.ports.readBytes = async function (path, max) {
      if (path.endsWith('.receipt')) throw thrown;
      return Reflect.apply(original, this, [path, max]);
    };
    const result = await resolveProjectArtifactChecksWithPorts(
      fixture.fixture.configBytes, fixture.fixture.contextBytes,
      undefined, fixture.ports
    );
    assert.equal(result.sidecar.coverage, 'BLOCKED');
    assert.ok(result.sidecar.io_failures.includes('IO_FAILED'));
  }

  const fixture = makeSidecarFixture();
  const original = fixture.ports.reads.readChunks;
  fixture.ports.reads.readChunks = function (path) {
    const source = Reflect.apply(original, this, [path]);
    return {
      [Symbol.asyncIterator]() {
        const iterator = source[Symbol.asyncIterator]();
        return {
          async next() { throw false; },
          async return() { throw null; }
        };
      }
    };
  };
  const result = await resolveProjectArtifactChecksWithPorts(
    fixture.fixture.configBytes, fixture.fixture.contextBytes,
    undefined, fixture.ports
  );
  assert.equal(result.sidecar.coverage, 'BLOCKED');
  assert.ok(result.sidecar.io_failures.includes('IO_FAILED'));
  assert.ok(result.sidecar.io_failures.includes('CLOSE_FAILED'));
  assert.equal(result.sidecar.reason, 'CLOSE_FAILED');
});

test('cancels deferred file IO intrinsically and settles the resolver on every branch', async () => {
  const blockedGate = deferred();
  let blockedReadCalls = 0;
  const earlyBlocked = makeSidecarFixture({
    stageHooks: {
      readdir(path) {
        return path.endsWith('/stage') ? [] : undefined;
      }
    },
    fileHooks: {
      read() {
        blockedReadCalls++;
      }
    }
  });
  const blockedWatch = observeGateOrSettlement(
    resolveProjectArtifactChecksWithPorts(
      earlyBlocked.fixture.configBytes, earlyBlocked.fixture.contextBytes,
      undefined, earlyBlocked.ports
    ),
    blockedGate
  );
  let blockedFirst;
  try {
    blockedFirst = await blockedWatch.observed;
  } finally {
    blockedGate.resolve();
  }
  const blockedOutcome = await blockedWatch.settled;
  assert.equal(blockedFirst.kind, 'settled');
  assert.equal(blockedOutcome.ok, true);
  assert.equal(blockedOutcome.value.sidecar.coverage, 'BLOCKED');
  assert.equal(blockedReadCalls, 0);

  const rejectedGate = deferred();
  let rejectedReadCalls = 0;
  const earlyRejected = makeSidecarFixture({
    fileHooks: {
      read() {
        rejectedReadCalls++;
      }
    }
  });
  const rejectedWatch = observeGateOrSettlement(
    resolveProjectArtifactChecksWithPorts(
      earlyRejected.fixture.configBytes,
      earlyRejected.fixture.contextBytes,
      undefined, {...earlyRejected.ports, extra: true}
    ),
    rejectedGate
  );
  let rejectedFirst;
  try {
    rejectedFirst = await rejectedWatch.observed;
  } finally {
    rejectedGate.resolve();
  }
  const rejectedOutcome = await rejectedWatch.settled;
  assert.equal(rejectedFirst.kind, 'settled');
  assert.equal(rejectedOutcome.ok, false);
  assert.ok(
    rejectedOutcome.error instanceof ProjectArtifactCheckValidationError
  );
  assert.equal(rejectedOutcome.error.code, 'INVALID_ARTIFACT_CONTEXT');
  assert.equal(rejectedReadCalls, 0);
  assert.equal(earlyRejected.stageFake.calls.lstat.length, 0);

  const controller = new AbortController();
  const entered = deferred();
  const release = deferred();
  let reached = false;
  let getterCalls = 0;
  let paused = false;
  const fixture = makeSidecarFixture({
    fileHooks: {
      async read(record, defaultRead) {
        if (!paused) {
          paused = true;
          reached = true;
          Object.defineProperty(controller.signal, 'aborted', {
            configurable: true,
            get() {
              getterCalls++;
              throw new Error('PRIVATE_SIGNAL_GETTER');
            }
          });
          entered.resolve();
          await release.promise;
        }
        return defaultRead();
      }
    }
  });
  const pending = resolveProjectArtifactChecksWithPorts(
    fixture.fixture.configBytes, fixture.fixture.contextBytes,
    controller.signal, fixture.ports
  );
  const watch = observeGateOrSettlement(pending, entered);
  let prerequisiteError = null;
  try {
    const first = await watch.observed;
    assert.equal(first.kind, 'entered');
    assert.equal(reached, true);
    controller.abort();
  } catch (error) {
    prerequisiteError = error;
  } finally {
    release.resolve();
    entered.resolve();
  }
  const outcome = await watch.settled;
  if (prerequisiteError) throw prerequisiteError;
  if (!outcome.ok) throw outcome.error;
  const result = outcome.value;
  assert.equal(result.sidecar.coverage, 'BLOCKED');
  assert.ok(result.sidecar.io_failures.includes('ABORTED'));
  assert.ok(fixture.fileFake.calls.read.length > 0);
  assert.equal(fixture.fileFake.calls.close.length, 1);
  assert.equal(getterCalls, 0);
});

test('captures exact ports and receivers without function metadata reads', async () => {
  const fixture = makeSidecarFixture();
  const metadata = {name: 0, length: 0};
  const original = fixture.ports.fs.lstat;
  fixture.ports.fs.lstat = function (...args) {
    return Reflect.apply(original, this, args);
  };
  for (const key of ['name', 'length']) {
    Object.defineProperty(fixture.ports.fs.lstat, key, {
      configurable: true,
      get() {
        metadata[key]++;
        throw new Error('PRIVATE_FUNCTION_METADATA');
      }
    });
  }
  const result = await resolveProjectArtifactChecksWithPorts(
    fixture.fixture.configBytes, fixture.fixture.contextBytes,
    undefined, fixture.ports
  );
  assert.equal(result.sidecar.coverage, 'DECLARED_CHECKS_PASSED');
  assert.deepEqual(metadata, {name: 0, length: 0});

  let getterCalls = 0;
  const badFs = {...fixture.ports.fs};
  Object.defineProperty(badFs, 'lstat', {
    enumerable: true,
    get() {
      getterCalls++;
      return fixture.ports.fs.lstat;
    }
  });
  const before = fixture.calls.readBytes.length;
  await assert.rejects(
    resolveProjectArtifactChecksWithPorts(
      fixture.fixture.configBytes, fixture.fixture.contextBytes,
      undefined, {...fixture.ports, fs: badFs}
    ),
    error => error.code === 'INVALID_ARTIFACT_CONTEXT' &&
      error.message === 'INVALID_ARTIFACT_CONTEXT'
  );
  assert.equal(getterCalls, 0);
  assert.equal(fixture.calls.readBytes.length, before);
});

test('isolates concurrent resolver calls and retains later negative results', async () => {
  const leftFixture = makeSidecarFixture({
    checkIds: ['first-check', 'later-check'],
    receipts: [{status: 'failed', reason: 'CHECK_FAILED'}, {}]
  });
  const rightFixture = makeSidecarFixture({
    checkIds: ['first-check', 'later-check'],
    receipts: [{status: 'failed', reason: 'CHECK_FAILED'}, {}]
  });
  const [left, right] = await Promise.all([
    resolveProjectArtifactChecksWithPorts(
      leftFixture.fixture.configBytes, leftFixture.fixture.contextBytes,
      undefined, leftFixture.ports
    ),
    resolveProjectArtifactChecksWithPorts(
      rightFixture.fixture.configBytes, rightFixture.fixture.contextBytes,
      undefined, rightFixture.ports
    )
  ]);
  for (const result of [left, right]) {
    assert.equal(result.sidecar.coverage, 'DECLARED_CHECKS_FAILED');
    assert.deepEqual(
      result.sidecar.check_results.map(item => item.evidence_binding),
      ['verified', 'verified']
    );
  }
});

test('strict encoder rejects hostile shapes, bad limits, and inconsistent reduction', async () => {
  const fixture = makeSidecarFixture();
  const resolved = await resolveProjectArtifactChecksWithPorts(
    fixture.fixture.configBytes, fixture.fixture.contextBytes,
    undefined, fixture.ports
  );
  const valid = resolved.sidecar;
  const hostile = new Proxy(valid, {
    ownKeys() { throw new Error('PRIVATE_PROXY'); }
  });
  expectInvalidContext(() => encodeProjectArtifactCheckSidecar(hostile));

  let getterCalls = 0;
  const accessor = copy(valid);
  Object.defineProperty(accessor, 'job_id', {
    enumerable: true,
    get() {
      getterCalls++;
      throw new Error('PRIVATE_GETTER');
    }
  });
  expectInvalidContext(() => encodeProjectArtifactCheckSidecar(accessor));
  assert.equal(getterCalls, 0);

  const badValues = [
    value => { value.extra = 'private'; },
    value => { value.artifact_witness = new Array(2); },
    value => { value.io_failures = ['IO_FAILED', 'ABORTED']; },
    value => { value.task_correctness = 'PASSED'; },
    value => { value.check_results[0].observer_role = 'candidate_test'; },
    value => { value.coverage = 'DECLARED_CHECKS_FAILED'; },
    value => { value.provenance_authenticity = 'AUTHENTICATED'; },
    value => {
      const base = value.artifact_witness[0];
      value.artifact_witness = Array.from({length: 3}, (_, index) => ({
        ...base,
        artifact_id: `large-${index}`,
        role: 'staged',
        staged_artifact_id: null,
        byte_count: 67_108_864
      })).sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
    },
    value => {
      value.check_results[0].status = 'blocked';
      value.check_results[0].reason = 'CHECK_FAILED';
      value.check_results[0].evidence_binding = 'unresolved';
      value.coverage = 'BLOCKED';
      value.reason = 'CHECK_FAILED';
    },
    value => {
      value.check_results[0].status = 'blocked';
      value.check_results[0].reason = 'EXPLICIT_NOT_RUN';
      value.check_results[0].evidence_binding = 'unresolved';
      value.coverage = 'BLOCKED';
      value.reason = 'EXPLICIT_NOT_RUN';
    },
    value => {
      value.check_results[0].status = 'blocked';
      value.check_results[0].reason = 'CHECK_UNAVAILABLE';
      value.check_results[0].evidence_binding = 'unresolved';
      value.coverage = 'BLOCKED';
      value.reason = 'CHECK_UNAVAILABLE';
    },
    value => {
      value.check_results[0].status = 'blocked';
      value.check_results[0].reason = 'NONE';
      value.check_results[0].evidence_binding = 'unresolved';
      value.coverage = 'BLOCKED';
      value.io_failures = ['IO_FAILED'];
      value.reason = 'ARTIFACT_IO';
    }
  ];
  for (const mutate of badValues) {
    const invalid = copy(valid);
    mutate(invalid);
    expectInvalidContext(() => encodeProjectArtifactCheckSidecar(invalid));
  }

  const unresolvedReasons = [
    ['CLOSE_FAILED', ['CLOSE_FAILED']],
    ['ABORTED', ['ABORTED']],
    ['ARTIFACT_LIMIT', ['LIMIT']],
    ['ARTIFACT_CHANGED', ['FILE_CHANGED']],
    ['ARTIFACT_IO', ['IO_FAILED']],
    ['STAGE_CORRUPT_OR_INCOMPLETE', []],
    ['MISSING_EVIDENCE', []],
    ['INVALID_EVIDENCE', []],
    ['BINDING_MISMATCH', []],
    ['ROLE_INSUFFICIENT', []],
    ['TERMINAL_INCOMPLETE', []]
  ];
  for (const [reason, ioFailures] of unresolvedReasons) {
    const unresolved = copy(valid);
    unresolved.check_results[0].status = 'blocked';
    unresolved.check_results[0].reason = reason;
    unresolved.check_results[0].evidence_binding = 'unresolved';
    unresolved.coverage = 'BLOCKED';
    unresolved.reason = reason;
    unresolved.io_failures = ioFailures;
    assert.doesNotThrow(() =>
      encodeProjectArtifactCheckSidecar(unresolved)
    );
  }

  const first = encodeProjectArtifactCheckSidecar(valid);
  const before = new Uint8Array(first);
  first.fill(0);
  const second = encodeProjectArtifactCheckSidecar(valid);
  assert.deepEqual([...second], [...before]);
  assert.notEqual(second.buffer, before.buffer);
});

// Resolver test counts: 15 added; 67 total, including all 52 accepted tests.
