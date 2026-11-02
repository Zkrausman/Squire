import test from 'node:test';
import assert from 'node:assert/strict';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {
  DESKTOP_READINESS_COMPANION_PATHS,
  DesktopReadinessValidationError,
  assertDesktopReadinessCurrent,
  captureDesktopReadinessData,
  captureDesktopReadinessFromFilesWithPorts,
  copyCapturedDesktopReadinessBytes,
  readinessDomainHash,
  resolveDesktopReadinessCompanionSourcePins,
  validateDesktopReadinessCompanionSourcePins,
  validateDesktopReadinessContext,
  validateDesktopReadinessExecutedTerminal,
  validateDesktopReadinessRoute,
  verifyDesktopReadinessPinnedFilesAndScopeWithPorts,
  verifyDesktopReadinessProbeArtifactsWithPorts
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
import {verifyArtifacts} from '../src/artifact-verifier.mjs';
import {RETENTION_POLICY} from '../src/local-rejected-retention.mjs';

const encoder = new TextEncoder();
const SELECTED_ROUTE_BYTE_LIMIT = 16_384;
const sha = value => hash(encoder.encode(value));
const rawDomainHash = (domain, value) => hash(canonicalBytes({domain, value}));
const uuid = '10000000-0000-4000-8000-000000000001';

const copy = value => structuredClone(value);
const makeController = () => ({
  pid: 101, start_ticks: '11', boot_id: '00000000-0000-0000-0000-000000000001'
});
const makeServer = () => ({
  pid: 102, start_ticks: '12', boot_id: '00000000-0000-0000-0000-000000000001'
});
const makeFixtureProcess = () => ({
  pid: 103, start_ticks: '13', boot_id: '00000000-0000-0000-0000-000000000001'
});

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

function makeConfig({
  jobId = uuid,
  scope = '/synthetic/task',
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

function makeRoute(runtimeIdentity = makeDescriptor(), probeRunId = 'probe-1') {
  return {
    backend: 'broadway',
    backend_gtype: 'GdkBroadwayDisplay',
    display_name: 'Broadway',
    environment: {
      GDK_BACKEND: 'broadway',
      BROADWAY_DISPLAY: ':41',
      XDG_RUNTIME_DIR: '/synthetic/runtime'
    },
    session: {
      probe_run_id: probeRunId,
      controller: makeController(),
      server: makeServer(),
      host: '127.0.0.1', port: 8121,
      socket_path: '/synthetic/runtime/broadway42.socket',
      socket_dev: '0', socket_ino: '44'
    },
    runtime_identity: copy(runtimeIdentity)
  };
}

function makeWitness() {
  return {'captures/window.png': {byte_count: 8, sha256: '2'.repeat(64)}};
}

function makeFixture(options = {}) {
  const descriptor = makeDescriptor();
  const config = makeConfig({...options, desktopRuntimeIdentity: descriptor});
  const configBytes = encoder.encode(JSON.stringify(config));
  const route = makeRoute(descriptor);
  const fixtureProcess = makeFixtureProcess();
  const fixtureDefinitionBytes = encoder.encode('fixture definition');
  const observerDefinitionBytes = encoder.encode('observer definition');
  const witness = makeWitness();
  const requirements = {
    schema: 'squire.desktop_readiness_requirements.v2',
    operation_config_sha256: hash(configBytes),
    job_id: config.job_id,
    scope: config.scope,
    source_commit: config.source_commit,
    prompt_sha256: config.prompt.sha256,
    desktop_descriptor_sha256: readinessDomainHash(
      'squire.desktop-runtime-descriptor.v2', config.desktop_runtime_identity
    ),
    route: copy(route),
    observer_policy_sha256: '3'.repeat(64),
    needs_input: options.needsInput ?? true,
    required_capabilities: options.needsInput === false
      ? ['api_shape', 'own_widget_render_readback', 'artifact_return', 'direct_owned_cleanup']
      : ['api_shape', 'own_widget_render_readback', 'artifact_return',
        'own_window_active', 'direct_owned_cleanup'],
    max_age_ms: 300000,
    fixture_definition_sha256: hash(fixtureDefinitionBytes),
    observer_definition_sha256: hash(observerDefinitionBytes)
  };
  const terminal = {
    schema: 'squire.desktop_readiness_terminal.v2',
    probe_run_id: route.session.probe_run_id,
    requirements_sha256: readinessDomainHash(
      'squire.desktop-readiness.requirements.v2', requirements
    ),
    route_sha256: readinessDomainHash('squire.desktop-readiness.route.v2', route),
    fixture_definition_sha256: requirements.fixture_definition_sha256,
    observer_definition_sha256: requirements.observer_definition_sha256,
    terminal: {
      process: copy(fixtureProcess),
      started_at_ms: 900,
      ended_at_ms: 1100,
      direct_child_exit_observed: true,
      exit_kind: 'natural',
      exit_code: 0,
      signal: null,
      stdout_eof: true,
      stderr_eof: true,
      stop_codes: [],
      cleanup_codes: [],
      descendant_guarantee: 'NOT_ESTABLISHED'
    }
  };
  const terminalBytes = encoder.encode(JSON.stringify(terminal));
  const proof = {
    schema: 'squire.desktop_readiness_observation.v2',
    requirements_sha256: readinessDomainHash(
      'squire.desktop-readiness.requirements.v2', requirements
    ),
    observed_at_ms: 1000,
    route: copy(route),
    fixture_definition_sha256: requirements.fixture_definition_sha256,
    observer_definition_sha256: requirements.observer_definition_sha256,
    observer_policy_sha256: requirements.observer_policy_sha256,
    capabilities: [
      {
        name: 'api_shape', status: 'passed', evidence_kind: 'API_CONTRACT',
        detail: {
          activity_property_kind: 'boolean',
          backend_gtype: 'GdkBroadwayDisplay',
          display_name: 'Broadway'
        }
      },
      {
        name: 'own_widget_render_readback', status: 'passed',
        evidence_kind: 'NATIVE_RENDER',
        detail: {
          mapped: true, width: 640, height: 480,
          decoded_width: 640, decoded_height: 480,
          png_relative: 'captures/window.png'
        }
      },
      {
        name: 'artifact_return', status: 'passed',
        evidence_kind: 'ARTIFACT_READBACK',
        detail: {
          witness_sha256: readinessDomainHash(
            'squire.desktop-readiness.artifact-witness.v2', witness
          )
        }
      },
      ...(requirements.needs_input ? [{
        name: 'own_window_active', status: 'passed',
        evidence_kind: 'NATIVE_ACTIVE',
        detail: {
          active: true, target: 'OWN_FIXTURE', process: copy(fixtureProcess)
        }
      }] : []),
      {
        name: 'direct_owned_cleanup', status: 'passed',
        evidence_kind: 'DIRECT_PROCESS_CLEANUP',
        detail: {terminal_sha256: hash(terminalBytes)}
      }
    ],
    terminal_receipt_sha256: hash(terminalBytes),
    artifact_witness_sha256: readinessDomainHash(
      'squire.desktop-readiness.artifact-witness.v2', witness
    )
  };
  const proofBytes = encoder.encode(JSON.stringify(proof));
  const companion_source_pins = Object.fromEntries(
    DESKTOP_READINESS_COMPANION_PATHS.map(relative => [
      relative, {bytes: 1, sha256: '4'.repeat(64)}
    ])
  );
  const context = {
    schema: 'squire.desktop_readiness_context.v2',
    requirements,
    proof_pin: {path: '/synthetic/evidence/proof.json', bytes: proofBytes.length, sha256: hash(proofBytes)},
    observer_definition_pin: {
      path: '/synthetic/evidence/observer.py',
      bytes: observerDefinitionBytes.length, sha256: hash(observerDefinitionBytes)
    },
    fixture_definition_pin: {
      path: '/synthetic/evidence/fixture.py',
      bytes: fixtureDefinitionBytes.length, sha256: hash(fixtureDefinitionBytes)
    },
    observer_terminal_pin: {
      path: '/synthetic/evidence/terminal.json',
      bytes: terminalBytes.length, sha256: hash(terminalBytes)
    },
    probe_artifacts: {root: '/synthetic/probe', witness},
    companion_source_pins
  };
  const readinessContextBytes = encoder.encode(JSON.stringify(context));
  const selectedRouteBytes = encoder.encode(JSON.stringify(route));
  return {
    config, configBytes, route, selectedRouteBytes, context,
    readinessContextBytes, proof, proofBytes, terminal, terminalBytes,
    fixtureDefinitionBytes, observerDefinitionBytes,
    input: {
      configBytes, readinessContextBytes, selectedRouteBytes, proofBytes,
      observerTerminalBytes: terminalBytes,
      fixtureDefinitionBytes, observerDefinitionBytes
    }
  };
}

function refreshFixtureEvidence(fixture, {
  definitionBindings = false,
  witnessDigest = null
} = {}) {
  if (definitionBindings) {
    const fixtureHash = hash(fixture.fixtureDefinitionBytes);
    const observerHash = hash(fixture.observerDefinitionBytes);
    fixture.context.fixture_definition_pin.sha256 = fixtureHash;
    fixture.context.observer_definition_pin.sha256 = observerHash;
    fixture.context.requirements.fixture_definition_sha256 = fixtureHash;
    fixture.context.requirements.observer_definition_sha256 = observerHash;
    fixture.proof.fixture_definition_sha256 = fixtureHash;
    fixture.proof.observer_definition_sha256 = observerHash;
    fixture.terminal.fixture_definition_sha256 = fixtureHash;
    fixture.terminal.observer_definition_sha256 = observerHash;
  }

  const requirementsHash = readinessDomainHash(
    'squire.desktop-readiness.requirements.v2',
    fixture.context.requirements
  );
  fixture.proof.requirements_sha256 = requirementsHash;
  fixture.terminal.requirements_sha256 = requirementsHash;
  fixture.terminal.route_sha256 = readinessDomainHash(
    'squire.desktop-readiness.route.v2', fixture.route
  );

  const resolvedWitnessDigest = witnessDigest ??
    readinessDomainHash(
      'squire.desktop-readiness.artifact-witness.v2',
      fixture.context.probe_artifacts.witness
    );
  fixture.proof.artifact_witness_sha256 = resolvedWitnessDigest;
  fixture.proof.capabilities.find(
    item => item.name === 'artifact_return'
  ).detail.witness_sha256 = resolvedWitnessDigest;

  fixture.selectedRouteBytes = encoder.encode(JSON.stringify(fixture.route));
  fixture.terminalBytes = encoder.encode(JSON.stringify(fixture.terminal));
  const cleanup = fixture.proof.capabilities.find(
    item => item.name === 'direct_owned_cleanup'
  );
  cleanup.detail.terminal_sha256 = hash(fixture.terminalBytes);
  fixture.proof.terminal_receipt_sha256 = hash(fixture.terminalBytes);
  fixture.proofBytes = encoder.encode(JSON.stringify(fixture.proof));
  fixture.context.observer_terminal_pin = {
    ...fixture.context.observer_terminal_pin,
    bytes: fixture.terminalBytes.length,
    sha256: hash(fixture.terminalBytes)
  };
  fixture.context.proof_pin = {
    ...fixture.context.proof_pin,
    bytes: fixture.proofBytes.length,
    sha256: hash(fixture.proofBytes)
  };
  fixture.readinessContextBytes = encoder.encode(JSON.stringify(fixture.context));
  fixture.input = {
    ...fixture.input,
    configBytes: fixture.configBytes,
    readinessContextBytes: fixture.readinessContextBytes,
    selectedRouteBytes: fixture.selectedRouteBytes,
    proofBytes: fixture.proofBytes,
    observerTerminalBytes: fixture.terminalBytes,
    fixtureDefinitionBytes: fixture.fixtureDefinitionBytes,
    observerDefinitionBytes: fixture.observerDefinitionBytes
  };
  return fixture.input;
}

function expectCode(code, fn) {
  assert.throws(fn, error =>
    error instanceof DesktopReadinessValidationError && error.code === code
  );
}

async function expectCodeAsync(code, fn) {
  await assert.rejects(fn, error =>
    error instanceof DesktopReadinessValidationError && error.code === code
  );
}

function makePhysicallyPinnedCapture(
  options = {}, probeContentsByRelative = null
) {
  const fixture = makeFixture(options);
  if (probeContentsByRelative !== null) {
    fixture.context.probe_artifacts.witness = Object.fromEntries(
      Object.entries(probeContentsByRelative).map(([relative, contents]) => [
        relative,
        {byte_count: contents.length, sha256: hash(contents)}
      ])
    );
  }
  const descriptor = copy(fixture.config.desktop_runtime_identity);
  const files = new Map();
  const bindRuntimePin = (pin, pathField, label) => {
    const contents = encoder.encode(label);
    pin.bytes = contents.length;
    pin.sha256 = hash(contents);
    files.set(pin[pathField], contents);
  };
  bindRuntimePin(descriptor.executable, 'path', 'runtime executable bytes');
  for (const entry of descriptor.typelibs) {
    bindRuntimePin(entry, 'typelib', `runtime typelib ${entry.namespace}`);
  }
  for (const entry of descriptor.libraries) {
    bindRuntimePin(entry, 'path', `runtime library ${entry.name}`);
  }

  fixture.config.desktop_runtime_identity = descriptor;
  fixture.route.runtime_identity = copy(descriptor);
  fixture.context.requirements.route.runtime_identity = copy(descriptor);
  fixture.proof.route.runtime_identity = copy(descriptor);
  fixture.context.requirements.desktop_descriptor_sha256 = readinessDomainHash(
    'squire.desktop-runtime-descriptor.v2', descriptor
  );
  fixture.configBytes = encoder.encode(JSON.stringify(fixture.config));
  fixture.context.requirements.operation_config_sha256 = hash(fixture.configBytes);
  const input = refreshFixtureEvidence(fixture);
  const captured = captureDesktopReadinessData(input);
  for (const [pinName, bytesName] of [
    ['proof_pin', 'proof'],
    ['observer_terminal_pin', 'observer_terminal'],
    ['fixture_definition_pin', 'fixture_definition'],
    ['observer_definition_pin', 'observer_definition']
  ]) {
    files.set(captured.context[pinName].path,
      copyCapturedDesktopReadinessBytes(captured, bytesName));
  }
  if (probeContentsByRelative !== null) {
    for (const [relative, contents] of Object.entries(probeContentsByRelative)) {
      files.set(
        join(captured.context.probe_artifacts.root, relative),
        new Uint8Array(contents)
      );
    }
  }
  return {fixture, captured, files};
}

function makeJointPhysicallyPinnedProbeCapture() {
  return makePhysicallyPinnedCapture({}, {
    'captures/window.png': encoder.encode('PNGbytes')
  });
}

function makeReadinessPreflightPorts(captured, files, hooks = {}) {
  const calls = {
    realpath: [],
    fsLstat: [],
    pinLstat: [],
    verify: [],
    readChunks: [],
    chunkNext: [],
    iteratorReturn: [],
    events: [],
    mutations: []
  };
  const enoent = () => Object.assign(new Error('missing'), {code: 'ENOENT'});
  const fs = {
    async realpath(path) {
      calls.realpath.push(path);
      if (hooks.realpath) return hooks.realpath(path, calls);
      return path;
    },
    async lstat(path) {
      calls.fsLstat.push(path);
      if (hooks.scopeLstat) return hooks.scopeLstat(path, calls);
      throw enoent();
    }
  };
  const reads = {
    async lstat(path) {
      calls.pinLstat.push(path);
      if (hooks.pinLstat) await hooks.pinLstat(path, calls);
      const contents = files.get(path);
      if (!contents) throw enoent();
      const fault = hooks.statFault?.(path);
      if (fault === 'missing') throw enoent();
      return {
        size: fault === 'size' ? contents.length + 1 : contents.length,
        isFile: () => fault !== 'not-file',
        isSymbolicLink: () => fault === 'symlink'
      };
    },
    readChunks(path) {
      calls.readChunks.push(path);
      if (hooks.readChunks) {
        return hooks.readChunks(path, calls, files.get(path));
      }
      const contents = files.get(path);
      if (!contents) throw enoent();
      if (hooks.iteratorForPath) {
        return hooks.iteratorForPath(path, calls, contents);
      }
      let sent = false;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              calls.chunkNext.push(path);
              if (hooks.chunkNext) await hooks.chunkNext(path, calls);
              if (sent) return {done: true};
              sent = true;
              const value = hooks.chunkBytes
                ? hooks.chunkBytes(path, contents)
                : contents;
              return {done: false, value};
            },
            async return(value) {
              calls.iteratorReturn.push(path);
              if (hooks.iteratorReturn) {
                await hooks.iteratorReturn(path, calls);
              }
              return {done: true, value};
            }
          };
        }
      };
    }
  };
  return {
    calls,
    ports: {
      fs,
      verifyFile(identity, suppliedReads) {
        calls.verify.push(identity);
        return verifyExactFile(identity, suppliedReads);
      },
      reads
    }
  };
}

const PROBE_TEST_UID = 71;

function makeProbeArtifactCapture(contentsByRelative = {
  'captures/window.png': encoder.encode('PNGbytes')
}) {
  const fixture = makeFixture();
  fixture.context.probe_artifacts.witness = Object.fromEntries(
    Object.entries(contentsByRelative).map(([relative, contents]) => [
      relative,
      {byte_count: contents.length, sha256: hash(contents)}
    ])
  );
  const input = refreshFixtureEvidence(fixture);
  const captured = captureDesktopReadinessData(input);
  const files = new Map(Object.entries(contentsByRelative).map(
    ([relative, contents]) => [
      join(captured.context.probe_artifacts.root, relative),
      new Uint8Array(contents)
    ]
  ));
  return {fixture, captured, files};
}

function makeProbeStat({
  kind, size = 0, uid = PROBE_TEST_UID, nlink = 1, ino = 10n,
  symbolicLink = false
}) {
  return {
    dev: 1n,
    ino: BigInt(ino),
    size: BigInt(size),
    mtimeNs: 2n,
    ctimeNs: 3n,
    mode: kind === 'file' ? 0o100600n : 0o040700n,
    uid,
    nlink,
    isFile() { return kind === 'file'; },
    isDirectory() { return kind === 'directory'; },
    isSymbolicLink() { return symbolicLink; }
  };
}

function makeProbeArtifactPorts(captured, files, hooks = {}) {
  const root = captured.context.probe_artifacts.root;
  const nodes = new Map([[root, {kind: 'directory'}]]);
  for (const relative of Object.keys(captured.context.probe_artifacts.witness)) {
    const parts = relative.split('/');
    for (let index = 1; index < parts.length; index++) {
      const directory = join(root, ...parts.slice(0, index));
      nodes.set(directory, {kind: 'directory'});
    }
    nodes.set(join(root, relative), {kind: 'file'});
  }

  const calls = {
    lstat: [],
    realpath: [],
    open: [],
    handleStat: [],
    read: [],
    close: [],
    events: [],
    trace: []
  };
  const counts = new Map();
  const nextCount = key => {
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count;
  };
  const statFor = (path, phase) => {
    const node = nodes.get(path);
    if (!node) throw new Error('unexpected fake stat path');
    const count = nextCount(`${phase}:${path}`);
    const stat = makeProbeStat({
      kind: node.kind,
      size: node.kind === 'file' ? files.get(path)?.length ?? 0 : 1,
      uid: PROBE_TEST_UID,
      ino: node.kind === 'file' ? 20n : 10n
    });
    const hook = phase === 'lstat' ? hooks.lstatStat : hooks.handleStat;
    return hook?.(path, count, stat, calls) ?? stat;
  };

  const fs = {
    async lstat(path, ...args) {
      calls.trace.push(`lstat:${path}`);
      calls.lstat.push({path, args});
      if (hooks.beforeLstat) await hooks.beforeLstat(path, calls);
      return statFor(path, 'lstat');
    },
    async realpath(path, ...args) {
      calls.trace.push(`realpath:${path}`);
      calls.realpath.push({path, args});
      if (hooks.beforeRealpath) await hooks.beforeRealpath(path, calls);
      const result = hooks.realpath?.(path, calls);
      return result === undefined ? path : result;
    },
    async open(path, ...args) {
      calls.trace.push(`open:${path}`);
      calls.open.push({path, args});
      const handle = {
        async stat(...statArgs) {
          calls.trace.push(`stat:${path}`);
          calls.handleStat.push({path, args: statArgs});
          return statFor(path, 'handle');
        },
        async read(buffer, offset, length, position) {
          calls.trace.push(`read:${path}:${position}:${length}`);
          const record = {path, offset, length, position};
          calls.read.push(record);
          const defaultRead = () => {
            const contents = files.get(path);
            if (!contents) throw new Error('missing fake bytes');
            const available = Math.max(0, contents.length - position);
            const bytesRead = Math.min(length, available);
            if (bytesRead > 0) {
              buffer.set(contents.subarray(position, position + bytesRead), offset);
            }
            return {bytesRead};
          };
          return hooks.read
            ? hooks.read(record, defaultRead, calls)
            : defaultRead();
        },
        async close() {
          calls.trace.push(`close:${path}`);
          calls.close.push(path);
          if (hooks.close) await hooks.close(path, calls);
        }
      };
      if (hooks.open) {
        const replacement = await hooks.open(path, args, handle, calls);
        if (replacement !== undefined) return replacement;
      }
      return handle;
    }
  };

  return {calls, ports: {fs, uid: PROBE_TEST_UID}};
}

function probeVerifierPrefix(root, path) {
  return [
    `lstat:${root}`,
    `realpath:${root}`,
    `lstat:${join(root, 'captures')}`,
    `lstat:${path}`,
    `realpath:${path}`
  ];
}

// Direct verifyArtifacts has only its opened and post-read handle stats.
function probeVerifierSuccessTrace(root, path, payloadBytes) {
  return [
    `lstat:${root}`,
    `realpath:${root}`,
    `lstat:${join(root, 'captures')}`,
    `lstat:${path}`,
    `realpath:${path}`,
    `open:${path}`,
    `stat:${path}`,
    `read:${path}:0:${payloadBytes}`,
    `read:${path}:${payloadBytes}:1`,
    `stat:${path}`,
    `lstat:${path}`,
    `lstat:${root}`,
    `lstat:${join(root, 'captures')}`,
    `close:${path}`
  ];
}

// The readiness adapter validates the acquired handle before returning it to
// verifyArtifacts, so wrapped success has one additional real handle stat.
function probeAdapterWrappedSuccessTrace(root, path, payloadBytes) {
  return [
    `lstat:${root}`,
    `realpath:${root}`,
    `lstat:${join(root, 'captures')}`,
    `lstat:${path}`,
    `realpath:${path}`,
    `open:${path}`,
    `stat:${path}`,
    `stat:${path}`,
    `read:${path}:0:${payloadBytes}`,
    `read:${path}:${payloadBytes}:1`,
    `stat:${path}`,
    `lstat:${path}`,
    `lstat:${root}`,
    `lstat:${join(root, 'captures')}`,
    `close:${path}`
  ];
}

test('pure capture binds copied documents, definitions, route and full descriptor while retaining NOT_QUALIFIED', () => {
  const fixture = makeFixture();
  const capture = captureDesktopReadinessData(fixture.input);
  assert.equal(Object.isFrozen(capture), true);
  assert.equal(capture.validation_scope, 'PURE_DATA_ONLY');
  assert.equal(capture.native_app_status, 'NOT_QUALIFIED');
  assert.equal(capture.config.desktop_runtime_identity.status, 'NOT_QUALIFIED');
  assert.equal(capture.requirements_sha256, readinessDomainHash(
    'squire.desktop-readiness.requirements.v2', fixture.context.requirements
  ));
  assert.equal(capture.route_sha256, readinessDomainHash(
    'squire.desktop-readiness.route.v2', fixture.route
  ));
  assert.equal(assertDesktopReadinessCurrent(capture, 1200, 1199), capture);

  const saved = copyCapturedDesktopReadinessBytes(capture, 'config');
  assert.deepEqual(saved, fixture.configBytes);
  saved[0] ^= 1;
  fixture.configBytes[0] ^= 1;
  assert.deepEqual(
    copyCapturedDesktopReadinessBytes(capture, 'config'),
    encoder.encode(JSON.stringify(fixture.config))
  );
});

test('public capture deeply freezes copied data beneath already-frozen ancestors without freezing caller inputs', async () => {
  const fixture = makeFixture();
  const callerObjects = [
    ['config', fixture.config],
    ['context', fixture.context],
    ['route', fixture.route],
    ['proof', fixture.proof],
    ['terminal', fixture.terminal]
  ];
  const callerJson = callerObjects.map(([name, value]) => [
    name, JSON.stringify(value)
  ]);
  const callerByteHashes = Object.entries(fixture.input).map(([name, bytes]) => [
    name, hash(bytes)
  ]);

  const captured = captureDesktopReadinessData(fixture.input);
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(Object.isFrozen(captured.config), true);

  const assertFrozenGraph = root => {
    const seen = new WeakSet();
    const visit = value => {
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      assert.equal(Object.isFrozen(value), true);
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && Object.hasOwn(descriptor, 'value')) {
          visit(descriptor.value);
        }
      }
    };
    visit(root);
  };
  assertFrozenGraph(captured);

  const sourcePinPath = Object.keys(captured.config.source_pins)[0];
  const witnessEntry = captured.context.probe_artifacts.witness[
    'captures/window.png'
  ];
  const capabilityDetail = captured.proof.capabilities[0].detail;
  const frozenMutations = [
    {
      label: 'descriptor executable',
      read: () => captured.config.desktop_runtime_identity.executable.sha256,
      write: () => {
        captured.config.desktop_runtime_identity.executable.sha256 = '0'.repeat(64);
      }
    },
    {
      label: 'descriptor typelib',
      read: () => captured.config.desktop_runtime_identity.typelibs[0].version,
      write: () => {
        captured.config.desktop_runtime_identity.typelibs[0].version = '3.0';
      }
    },
    {
      label: 'descriptor library',
      read: () => captured.config.desktop_runtime_identity.libraries[0].name,
      write: () => {
        captured.config.desktop_runtime_identity.libraries[0].name = 'changed';
      }
    },
    {
      label: 'config source pin',
      read: () => captured.config.source_pins[sourcePinPath].sha256,
      write: () => {
        captured.config.source_pins[sourcePinPath].sha256 = '0'.repeat(64);
      }
    },
    {
      label: 'config prompt',
      read: () => captured.config.prompt.sha256,
      write: () => { captured.config.prompt.sha256 = '0'.repeat(64); }
    },
    {
      label: 'config policy',
      read: () => captured.config.environment_policy.deleted_keys[0],
      write: () => {
        captured.config.environment_policy.deleted_keys[0] = 'CHANGED';
      }
    },
    {
      label: 'context route',
      read: () => captured.context.requirements.route.session.probe_run_id,
      write: () => {
        captured.context.requirements.route.session.probe_run_id = 'changed';
      }
    },
    {
      label: 'context pin',
      read: () => captured.context.proof_pin.sha256,
      write: () => { captured.context.proof_pin.sha256 = '0'.repeat(64); }
    },
    {
      label: 'probe witness',
      read: () => witnessEntry.byte_count,
      write: () => { witnessEntry.byte_count = 9; }
    },
    {
      label: 'selected route',
      read: () => captured.selected_route.environment.BROADWAY_DISPLAY,
      write: () => {
        captured.selected_route.environment.BROADWAY_DISPLAY = ':42';
      }
    },
    {
      label: 'proof capability detail',
      read: () => capabilityDetail.display_name,
      write: () => { capabilityDetail.display_name = 'Changed'; }
    },
    {
      label: 'terminal process',
      read: () => captured.observer_terminal.terminal.process.pid,
      write: () => { captured.observer_terminal.terminal.process.pid = 999; }
    },
    {
      label: 'terminal array',
      read: () => captured.observer_terminal.terminal.stop_codes.length,
      write: () => {
        captured.observer_terminal.terminal.stop_codes.push('TERM_ATTEMPTED');
      }
    }
  ];
  for (const item of frozenMutations) {
    const before = item.read();
    assert.throws(item.write, TypeError, item.label);
    assert.equal(item.read(), before, item.label);
  }

  const capturedJson = JSON.stringify(captured);
  const capturedRequirementsHash = readinessDomainHash(
    'squire.desktop-readiness.requirements.v2',
    captured.context.requirements
  );
  const capturedRouteHash = readinessDomainHash(
    'squire.desktop-readiness.route.v2', captured.selected_route
  );
  const capturedWitnessHash = readinessDomainHash(
    'squire.desktop-readiness.artifact-witness.v2',
    captured.context.probe_artifacts.witness
  );
  const capturedDocumentNames = [
    'config', 'context', 'selected_route', 'proof', 'observer_terminal',
    'fixture_definition', 'observer_definition'
  ];
  const capturedBytes = new Map(capturedDocumentNames.map(name => [
    name, copyCapturedDesktopReadinessBytes(captured, name)
  ]));

  assert.equal(JSON.stringify(captured), capturedJson);
  assert.equal(capturedRequirementsHash, captured.requirements_sha256);
  assert.equal(capturedRouteHash, captured.route_sha256);
  assert.equal(capturedWitnessHash, captured.artifact_witness_sha256);
  for (const [name, bytes] of capturedBytes) {
    assert.deepEqual(copyCapturedDesktopReadinessBytes(captured, name), bytes);
  }

  assert.deepEqual(callerObjects.map(([name, value]) => [
    name, JSON.stringify(value)
  ]), callerJson);
  assert.deepEqual(Object.entries(fixture.input).map(([name, bytes]) => [
    name, hash(bytes)
  ]), callerByteHashes);
  assert.equal(Object.isFrozen(fixture.config), false);
  assert.equal(Object.isFrozen(fixture.config.desktop_runtime_identity), false);
  for (const bytes of Object.values(fixture.input)) {
    assert.equal(Object.isFrozen(bytes), false);
  }

  const physical = makeJointPhysicallyPinnedProbeCapture();
  const jointCapture = physical.captured;
  const root = jointCapture.context.probe_artifacts.root;
  const relative = 'captures/window.png';
  const artifactPath = join(root, relative);
  const artifactBytes = encoder.encode('PNGbytes');
  const witness = jointCapture.context.probe_artifacts.witness[relative];

  assertFrozenGraph(jointCapture);
  assert.equal(Object.isFrozen(jointCapture), true);
  assert.equal(Object.isFrozen(jointCapture.config), true);
  assert.equal(Object.isFrozen(jointCapture.config.desktop_runtime_identity), true);
  assert.equal(witness.byte_count, artifactBytes.length);
  assert.equal(witness.sha256, hash(artifactBytes));
  assert.equal(physical.files.get(artifactPath).length, witness.byte_count);
  assert.equal(hash(physical.files.get(artifactPath)), witness.sha256);

  const evidenceDocuments = [
    ['proof_pin', 'proof'],
    ['observer_terminal_pin', 'observer_terminal'],
    ['fixture_definition_pin', 'fixture_definition'],
    ['observer_definition_pin', 'observer_definition']
  ];
  const jointDocumentBytes = new Map(capturedDocumentNames.map(name => [
    name, copyCapturedDesktopReadinessBytes(jointCapture, name)
  ]));
  for (const [pinName, documentName] of evidenceDocuments) {
    const pin = jointCapture.context[pinName];
    const backingBytes = physical.files.get(pin.path);
    const capturedBytesForDocument =
      copyCapturedDesktopReadinessBytes(jointCapture, documentName);
    assert.ok(backingBytes instanceof Uint8Array, pinName);
    assert.equal(backingBytes.length, pin.bytes, pinName);
    assert.equal(hash(backingBytes), pin.sha256, pinName);
    assert.deepEqual(backingBytes, capturedBytesForDocument, pinName);
  }

  const descriptor = jointCapture.config.desktop_runtime_identity;
  const runtimePins = [
    descriptor.executable,
    ...descriptor.typelibs.map(entry => ({
      path: entry.typelib, bytes: entry.bytes, sha256: entry.sha256
    })),
    ...descriptor.libraries.map(entry => ({
      path: entry.path, bytes: entry.bytes, sha256: entry.sha256
    }))
  ];
  for (const pin of runtimePins) {
    const backingBytes = physical.files.get(pin.path);
    assert.ok(backingBytes instanceof Uint8Array, pin.path);
    assert.equal(backingBytes.length, pin.bytes, pin.path);
    assert.equal(hash(backingBytes), pin.sha256, pin.path);
  }

  const jointHashes = {
    requirements: readinessDomainHash(
      'squire.desktop-readiness.requirements.v2',
      jointCapture.context.requirements
    ),
    route: readinessDomainHash(
      'squire.desktop-readiness.route.v2', jointCapture.selected_route
    ),
    witness: readinessDomainHash(
      'squire.desktop-readiness.artifact-witness.v2',
      jointCapture.context.probe_artifacts.witness
    )
  };
  assert.equal(jointHashes.requirements, jointCapture.requirements_sha256);
  assert.equal(jointHashes.route, jointCapture.route_sha256);
  assert.equal(jointHashes.witness, jointCapture.artifact_witness_sha256);

  const serializedJointCapture = JSON.stringify(jointCapture);
  const serializedJointWitness =
    JSON.stringify(jointCapture.context.probe_artifacts.witness);
  const jointFileHashes = [...physical.files].map(([filePath, contents]) => [
    filePath, hash(contents)
  ]);
  const jointCallerObjects = [
    ['config', physical.fixture.config],
    ['context', physical.fixture.context],
    ['route', physical.fixture.route],
    ['proof', physical.fixture.proof],
    ['terminal', physical.fixture.terminal]
  ];
  const jointCallerJson = jointCallerObjects.map(([name, value]) => [
    name, JSON.stringify(value)
  ]);
  const jointCallerByteHashes = Object.entries(physical.fixture.input).map(
    ([name, bytes]) => [name, hash(bytes)]
  );
  assert.equal(Object.isFrozen(physical.fixture.config), false);
  assert.equal(
    Object.isFrozen(physical.fixture.config.desktop_runtime_identity), false
  );
  for (const bytes of Object.values(physical.fixture.input)) {
    assert.equal(Object.isFrozen(bytes), false);
  }

  const expectedPinPaths = [
    jointCapture.context.proof_pin.path,
    jointCapture.context.observer_terminal_pin.path,
    jointCapture.context.fixture_definition_pin.path,
    jointCapture.context.observer_definition_pin.path,
    ...runtimePins.map(pin => pin.path)
  ];
  let previousPinCalls = null;
  let previousProbeCalls = null;
  for (let invocation = 0; invocation < 2; invocation++) {
    const pinHarness = makeReadinessPreflightPorts(
      jointCapture, physical.files
    );
    assert.notStrictEqual(pinHarness.calls, previousPinCalls);
    const pinResult =
      await verifyDesktopReadinessPinnedFilesAndScopeWithPorts(
        jointCapture, undefined, pinHarness.ports
      );
    assert.deepEqual(pinResult, {
      captured: jointCapture,
      verification_scope: 'PINNED_FILES_AND_CANONICAL_SCOPE_ONLY',
      probe_artifact_status: 'NOT_EVALUATED',
      native_app_status: 'NOT_QUALIFIED'
    });
    assert.deepEqual(
      pinHarness.calls.verify.map(identity => identity.path),
      expectedPinPaths
    );
    assert.deepEqual(
      pinHarness.calls.chunkNext,
      expectedPinPaths.flatMap(path => [path, path])
    );

    const probeHarness = makeProbeArtifactPorts(jointCapture, physical.files);
    assert.notStrictEqual(probeHarness.calls, previousProbeCalls);
    const probeResult =
      await verifyDesktopReadinessProbeArtifactsWithPorts(
        jointCapture, undefined, probeHarness.ports
      );
    assert.deepEqual(probeResult, {
      captured: jointCapture,
      verification_scope: 'PROBE_ARTIFACT_BYTES_ONLY',
      artifact_content_verification: 'VERIFIED',
      readiness_status: 'NOT_EVALUATED',
      native_app_status: 'NOT_QUALIFIED'
    });
    assert.deepEqual(probeHarness.calls.trace,
      probeAdapterWrappedSuccessTrace(root, artifactPath, witness.byte_count));
    assert.equal(probeHarness.calls.open.length, 1);
    assert.equal(probeHarness.calls.handleStat.length, 3);
    assert.deepEqual(
      probeHarness.calls.handleStat.map(call => call.args.length),
      [1, 1, 1]
    );
    assert.deepEqual(
      probeHarness.calls.read.map(({length, position}) => ({length, position})),
      [
        {length: witness.byte_count, position: 0},
        {length: 1, position: witness.byte_count}
      ]
    );
    assert.deepEqual(probeHarness.calls.close, [artifactPath]);
    previousPinCalls = pinHarness.calls;
    previousProbeCalls = probeHarness.calls;
  }

  assert.equal(JSON.stringify(jointCapture), serializedJointCapture);
  assert.equal(
    JSON.stringify(jointCapture.context.probe_artifacts.witness),
    serializedJointWitness
  );
  assert.deepEqual([...physical.files].map(([filePath, contents]) => [
    filePath, hash(contents)
  ]), jointFileHashes);
  for (const name of capturedDocumentNames) {
    assert.deepEqual(
      copyCapturedDesktopReadinessBytes(jointCapture, name),
      jointDocumentBytes.get(name)
    );
  }
  assert.equal(readinessDomainHash(
    'squire.desktop-readiness.requirements.v2',
    jointCapture.context.requirements
  ), jointHashes.requirements);
  assert.equal(readinessDomainHash(
    'squire.desktop-readiness.route.v2', jointCapture.selected_route
  ), jointHashes.route);
  assert.equal(readinessDomainHash(
    'squire.desktop-readiness.artifact-witness.v2',
    jointCapture.context.probe_artifacts.witness
  ), jointHashes.witness);
  assert.deepEqual(jointCallerObjects.map(([name, value]) => [
    name, JSON.stringify(value)
  ]), jointCallerJson);
  assert.deepEqual(Object.entries(physical.fixture.input).map(([name, bytes]) => [
    name, hash(bytes)
  ]), jointCallerByteHashes);
});

test('all operation-table fields reject a validly shaped A context against config B', () => {
  const fixture = makeFixture();
  const configB = makeConfig({
    jobId: '10000000-0000-4000-8000-000000000002',
    scope: '/synthetic/task-b'
  });
  const configBBytes = encoder.encode(JSON.stringify(configB));
  expectCode('READINESS_EVIDENCE_BLOCKED', () => captureDesktopReadinessData({
    ...fixture.input, configBytes: configBBytes
  }));

  const cases = [
    context => { context.requirements.operation_config_sha256 = '5'.repeat(64); },
    context => { context.requirements.job_id = '10000000-0000-4000-8000-000000000002'; },
    context => { context.requirements.scope = '/synthetic/task-b'; },
    context => { context.requirements.source_commit = '6'.repeat(40); },
    context => { context.requirements.prompt_sha256 = '7'.repeat(64); },
    context => { context.requirements.desktop_descriptor_sha256 = '8'.repeat(64); },
    context => { context.requirements.fixture_definition_sha256 = '9'.repeat(64); },
    context => { context.requirements.observer_definition_sha256 = 'a'.repeat(64); },
    context => { context.requirements.observer_policy_sha256 = 'b'.repeat(64); }
  ];
  for (const mutate of cases) {
    const changed = makeFixture();
    mutate(changed.context);
    const input = refreshFixtureEvidence(changed);
    const requirementsHash = readinessDomainHash(
      'squire.desktop-readiness.requirements.v2',
      changed.context.requirements
    );
    assert.equal(changed.proof.requirements_sha256, requirementsHash);
    assert.equal(changed.terminal.requirements_sha256, requirementsHash);
    expectCode('READINESS_EVIDENCE_BLOCKED', () => captureDesktopReadinessData({
      ...input
    }));
  }

  const configMismatches = [
    config => { config.job_id = '10000000-0000-4000-8000-000000000002'; },
    config => { config.scope = '/synthetic/task-config-b'; },
    config => { config.source_commit = 'f'.repeat(40); },
    config => { config.prompt.sha256 = '9'.repeat(64); },
    config => {
      config.desktop_runtime_identity.libraries[0].sha256 = 'd'.repeat(64);
    }
  ];
  for (const mutate of configMismatches) {
    const changed = makeFixture();
    mutate(changed.config);
    changed.configBytes = encoder.encode(JSON.stringify(changed.config));
    changed.context.requirements.operation_config_sha256 = hash(changed.configBytes);
    const input = refreshFixtureEvidence(changed);
    assert.equal(
      changed.context.requirements.operation_config_sha256, hash(changed.configBytes)
    );
    const requirementsHash = readinessDomainHash(
      'squire.desktop-readiness.requirements.v2',
      changed.context.requirements
    );
    assert.equal(changed.proof.requirements_sha256, requirementsHash);
    assert.equal(changed.terminal.requirements_sha256, requirementsHash);
    expectCode('READINESS_EVIDENCE_BLOCKED', () =>
      captureDesktopReadinessData(input)
    );
  }
});

test('proof, terminal, pin and domain bindings are checked independently', () => {
  const mutations = [
    fixture => { fixture.proof.requirements_sha256 = '5'.repeat(64); },
    fixture => { fixture.proof.observer_policy_sha256 = '5'.repeat(64); },
    fixture => { fixture.proof.terminal_receipt_sha256 = '5'.repeat(64); },
    fixture => { fixture.proof.artifact_witness_sha256 = '5'.repeat(64); },
    fixture => { fixture.terminal.requirements_sha256 = '5'.repeat(64); },
    fixture => { fixture.terminal.route_sha256 = '5'.repeat(64); },
    fixture => { fixture.terminal.probe_run_id = 'probe-other'; },
    fixture => { fixture.terminal.fixture_definition_sha256 = '5'.repeat(64); },
    fixture => { fixture.terminal.observer_definition_sha256 = '5'.repeat(64); }
  ];
  for (const mutate of mutations) {
    const fixture = makeFixture();
    mutate(fixture);
    const proofBytes = encoder.encode(JSON.stringify(fixture.proof));
    const terminalBytes = encoder.encode(JSON.stringify(fixture.terminal));
    const context = structuredClone(fixture.context);
    context.proof_pin.bytes = proofBytes.length;
    context.proof_pin.sha256 = hash(proofBytes);
    context.observer_terminal_pin.bytes = terminalBytes.length;
    context.observer_terminal_pin.sha256 = hash(terminalBytes);
    const contextBytes = encoder.encode(JSON.stringify(context));
    expectCode('READINESS_EVIDENCE_BLOCKED', () => captureDesktopReadinessData({
      ...fixture.input, proofBytes, observerTerminalBytes: terminalBytes,
      readinessContextBytes: contextBytes
    }));
  }
});

test('terminal probe ID mismatch remains isolated after all enclosing bindings are refreshed', () => {
  const fixture = makeFixture();
  const expectedProbeId = fixture.context.requirements.route.session.probe_run_id;
  fixture.terminal.probe_run_id = 'probe-other';
  const input = refreshFixtureEvidence(fixture);

  const requirementsHash = readinessDomainHash(
    'squire.desktop-readiness.requirements.v2',
    fixture.context.requirements
  );
  const routeHash = readinessDomainHash(
    'squire.desktop-readiness.route.v2', fixture.route
  );
  const terminalHash = hash(fixture.terminalBytes);
  const proofHash = hash(fixture.proofBytes);

  assert.equal(fixture.terminal.probe_run_id, 'probe-other');
  assert.notEqual(fixture.terminal.probe_run_id, expectedProbeId);
  assert.equal(fixture.context.requirements.route.session.probe_run_id, expectedProbeId);
  assert.equal(fixture.proof.route.session.probe_run_id, expectedProbeId);
  assert.equal(fixture.context.requirements.operation_config_sha256, hash(fixture.configBytes));
  assert.equal(fixture.proof.requirements_sha256, requirementsHash);
  assert.equal(fixture.terminal.requirements_sha256, requirementsHash);
  assert.equal(readinessDomainHash(
    'squire.desktop-readiness.route.v2', fixture.context.requirements.route
  ), routeHash);
  assert.equal(readinessDomainHash(
    'squire.desktop-readiness.route.v2', fixture.proof.route
  ), routeHash);
  assert.equal(fixture.terminal.route_sha256, routeHash);
  assert.deepEqual(fixture.selectedRouteBytes, encoder.encode(JSON.stringify(fixture.route)));
  assert.deepEqual(fixture.terminalBytes, encoder.encode(JSON.stringify(fixture.terminal)));
  assert.deepEqual(fixture.proofBytes, encoder.encode(JSON.stringify(fixture.proof)));
  assert.equal(fixture.context.observer_terminal_pin.bytes, fixture.terminalBytes.length);
  assert.equal(fixture.context.observer_terminal_pin.sha256, terminalHash);
  assert.equal(fixture.proof.terminal_receipt_sha256, terminalHash);
  assert.equal(fixture.proof.capabilities.find(
    item => item.name === 'direct_owned_cleanup'
  ).detail.terminal_sha256, terminalHash);
  assert.equal(fixture.context.proof_pin.bytes, fixture.proofBytes.length);
  assert.equal(fixture.context.proof_pin.sha256, proofHash);
  assert.deepEqual(
    fixture.readinessContextBytes,
    encoder.encode(JSON.stringify(fixture.context))
  );
  assert.deepEqual(input.observerTerminalBytes, fixture.terminalBytes);
  assert.deepEqual(input.proofBytes, fixture.proofBytes);
  assert.deepEqual(input.readinessContextBytes, fixture.readinessContextBytes);
  expectCode('READINESS_EVIDENCE_BLOCKED', () =>
    captureDesktopReadinessData(input)
  );

  fixture.terminal.probe_run_id = expectedProbeId;
  const positiveInput = refreshFixtureEvidence(fixture);
  assert.doesNotThrow(() => captureDesktopReadinessData(positiveInput));
});

test('selected route session or environment B cannot be paired with proof A', () => {
  const fixture = makeFixture();
  const sessionB = structuredClone(fixture.route);
  sessionB.session.probe_run_id = 'probe-b';
  const environmentB = structuredClone(fixture.route);
  environmentB.environment.XDG_RUNTIME_DIR = '/synthetic/runtime-b';
  environmentB.session.socket_path = '/synthetic/runtime-b/broadway42.socket';
  for (const routeB of [sessionB, environmentB]) {
    assert.doesNotThrow(() => validateDesktopReadinessRoute(routeB));
    const selectedRouteBytes = encoder.encode(JSON.stringify(routeB));
    expectCode('READINESS_EVIDENCE_BLOCKED', () => captureDesktopReadinessData({
      ...fixture.input, selectedRouteBytes
    }));
  }

  const cases = [
    route => { route.session.socket_path = '/synthetic/runtime/other.socket'; },
    route => { route.session.socket_ino = '0'; },
    route => { route.environment.BROADWAY_DISPLAY = ':42'; },
    route => { route.backend_gtype = 'OtherDisplay'; }
  ];
  for (const mutate of cases) {
    const route = makeRoute();
    mutate(route);
    expectCode('INVALID_READINESS_CONTEXT', () =>
      validateDesktopReadinessRoute(route)
    );
  }

  const qualified = makeRoute();
  qualified.runtime_identity.status = 'QUALIFIED';
  expectCode('INVALID_READINESS_CONTEXT', () =>
    validateDesktopReadinessRoute(qualified)
  );
  const afterMalformedQualified = makeFixture();
  assert.doesNotThrow(() => captureDesktopReadinessData(afterMalformedQualified.input));
});

test('valid desktop descriptor mismatches reach the descriptor bindings', () => {
  const descriptorB = makeDescriptor();
  descriptorB.libraries[0].sha256 = 'd'.repeat(64);
  const descriptorHashB = readinessDomainHash(
    'squire.desktop-runtime-descriptor.v2', descriptorB
  );
  assert.notEqual(descriptorHashB, readinessDomainHash(
    'squire.desktop-runtime-descriptor.v2', makeDescriptor()
  ));
  assert.doesNotThrow(() => captureDesktopReadinessData(makeFixture().input));

  const cases = [
    fixture => {
      fixture.context.requirements.desktop_descriptor_sha256 = descriptorHashB;
    },
    fixture => {
      fixture.context.requirements.route.runtime_identity = copy(descriptorB);
    },
    fixture => {
      fixture.route.runtime_identity = copy(descriptorB);
    },
    fixture => {
      fixture.config.desktop_runtime_identity = copy(descriptorB);
      fixture.configBytes = encoder.encode(JSON.stringify(fixture.config));
      fixture.context.requirements.operation_config_sha256 = hash(fixture.configBytes);
    }
  ];
  for (const mutate of cases) {
    const fixture = makeFixture();
    mutate(fixture);
    const input = refreshFixtureEvidence(fixture);
    const requirementsHash = readinessDomainHash(
      'squire.desktop-readiness.requirements.v2',
      fixture.context.requirements
    );
    assert.equal(fixture.proof.requirements_sha256, requirementsHash);
    assert.equal(fixture.terminal.requirements_sha256, requirementsHash);
    expectCode('READINESS_EVIDENCE_BLOCKED', () =>
      captureDesktopReadinessData(input)
    );
  }
});

test('matching route descriptor B is rejected against config descriptor A', () => {
  const fixture = makeFixture();
  const descriptorB = makeDescriptor();
  descriptorB.libraries[0].sha256 = 'd'.repeat(64);
  const descriptorHashA = readinessDomainHash(
    'squire.desktop-runtime-descriptor.v2',
    fixture.config.desktop_runtime_identity
  );
  const descriptorHashB = readinessDomainHash(
    'squire.desktop-runtime-descriptor.v2', descriptorB
  );
  assert.notEqual(descriptorHashA, descriptorHashB);

  fixture.route.runtime_identity = copy(descriptorB);
  fixture.context.requirements.route.runtime_identity = copy(descriptorB);
  fixture.proof.route.runtime_identity = copy(descriptorB);
  assert.notStrictEqual(
    fixture.route.runtime_identity,
    fixture.context.requirements.route.runtime_identity
  );
  assert.notStrictEqual(
    fixture.route.runtime_identity, fixture.proof.route.runtime_identity
  );
  assert.notStrictEqual(
    fixture.context.requirements.route.runtime_identity,
    fixture.proof.route.runtime_identity
  );
  for (const route of [
    fixture.route, fixture.context.requirements.route, fixture.proof.route
  ]) {
    assert.doesNotThrow(() => validateDesktopReadinessRoute(route));
    assert.equal(readinessDomainHash(
      'squire.desktop-runtime-descriptor.v2', route.runtime_identity
    ), descriptorHashB);
  }
  assert.equal(readinessDomainHash(
    'squire.desktop-runtime-descriptor.v2',
    fixture.config.desktop_runtime_identity
  ), descriptorHashA);
  assert.equal(fixture.context.requirements.desktop_descriptor_sha256, descriptorHashA);

  const input = refreshFixtureEvidence(fixture);
  const routeHashB = readinessDomainHash(
    'squire.desktop-readiness.route.v2', fixture.route
  );
  const requirementsHash = readinessDomainHash(
    'squire.desktop-readiness.requirements.v2',
    fixture.context.requirements
  );
  const terminalHash = hash(fixture.terminalBytes);
  const proofHash = hash(fixture.proofBytes);

  assert.equal(fixture.context.requirements.operation_config_sha256, hash(fixture.configBytes));
  assert.equal(fixture.context.requirements.desktop_descriptor_sha256, descriptorHashA);
  assert.equal(readinessDomainHash(
    'squire.desktop-readiness.route.v2', fixture.context.requirements.route
  ), routeHashB);
  assert.equal(readinessDomainHash(
    'squire.desktop-readiness.route.v2', fixture.proof.route
  ), routeHashB);
  assert.equal(fixture.terminal.route_sha256, routeHashB);
  assert.deepEqual(fixture.selectedRouteBytes, encoder.encode(JSON.stringify(fixture.route)));
  assert.equal(fixture.proof.requirements_sha256, requirementsHash);
  assert.equal(fixture.terminal.requirements_sha256, requirementsHash);
  assert.deepEqual(fixture.terminalBytes, encoder.encode(JSON.stringify(fixture.terminal)));
  assert.deepEqual(fixture.proofBytes, encoder.encode(JSON.stringify(fixture.proof)));
  assert.equal(fixture.context.observer_terminal_pin.bytes, fixture.terminalBytes.length);
  assert.equal(fixture.context.observer_terminal_pin.sha256, terminalHash);
  assert.equal(fixture.proof.terminal_receipt_sha256, terminalHash);
  assert.equal(fixture.proof.capabilities.find(
    item => item.name === 'direct_owned_cleanup'
  ).detail.terminal_sha256, terminalHash);
  assert.equal(fixture.context.proof_pin.bytes, fixture.proofBytes.length);
  assert.equal(fixture.context.proof_pin.sha256, proofHash);
  assert.deepEqual(
    fixture.readinessContextBytes,
    encoder.encode(JSON.stringify(fixture.context))
  );
  assert.deepEqual(input.configBytes, fixture.configBytes);
  assert.deepEqual(input.selectedRouteBytes, fixture.selectedRouteBytes);
  assert.deepEqual(input.observerTerminalBytes, fixture.terminalBytes);
  assert.deepEqual(input.proofBytes, fixture.proofBytes);
  assert.deepEqual(input.readinessContextBytes, fixture.readinessContextBytes);
  expectCode('READINESS_EVIDENCE_BLOCKED', () =>
    captureDesktopReadinessData(input)
  );

  fixture.config.desktop_runtime_identity = copy(descriptorB);
  fixture.configBytes = encoder.encode(JSON.stringify(fixture.config));
  fixture.context.requirements.operation_config_sha256 = hash(fixture.configBytes);
  fixture.context.requirements.desktop_descriptor_sha256 = descriptorHashB;
  const positiveInput = refreshFixtureEvidence(fixture);
  assert.doesNotThrow(() => captureDesktopReadinessData(positiveInput));
});

test('definition byte pins require exact positive-length supplied bytes', () => {
  for (const pinName of ['fixture_definition_pin', 'observer_definition_pin']) {
    const fixture = makeFixture();
    const originalBytes = pinName === 'fixture_definition_pin'
      ? fixture.fixtureDefinitionBytes
      : fixture.observerDefinitionBytes;
    const originalHash = hash(originalBytes);
    fixture.context[pinName].bytes++;
    assert.equal(fixture.context[pinName].sha256, originalHash);
    const input = refreshFixtureEvidence(fixture);
    expectCode('READINESS_EVIDENCE_BLOCKED', () =>
      captureDesktopReadinessData(input)
    );
  }

  for (const definitionName of [
    'fixtureDefinitionBytes', 'observerDefinitionBytes'
  ]) {
    const fixture = makeFixture();
    const pinName = definitionName === 'fixtureDefinitionBytes'
      ? 'fixture_definition_pin'
      : 'observer_definition_pin';
    fixture[definitionName] = new Uint8Array();
    const input = refreshFixtureEvidence(fixture, {definitionBindings: true});
    assert.equal(fixture.context[pinName].bytes > 0, true);
    assert.equal(fixture.context[pinName].sha256, hash(new Uint8Array()));
    expectCode('READINESS_EVIDENCE_BLOCKED', () =>
      captureDesktopReadinessData(input)
    );
  }
});

test('API activity property kind accepts only the literal boolean discriminator', () => {
  const positive = makeFixture();
  assert.equal(
    positive.proof.capabilities.find(item => item.name === 'api_shape')
      .detail.activity_property_kind,
    'boolean'
  );
  assert.doesNotThrow(() => captureDesktopReadinessData(positive.input));

  for (const value of [
    true, false, 'function', 'callable', null, 1, {}
  ]) {
    const fixture = makeFixture();
    fixture.proof.capabilities.find(item => item.name === 'api_shape')
      .detail.activity_property_kind = value;
    const input = refreshFixtureEvidence(fixture);
    expectCode('READINESS_EVIDENCE_BLOCKED', () =>
      captureDesktopReadinessData(input)
    );
  }
  const callable = makeFixture();
  callable.proof.capabilities.find(item => item.name === 'api_shape')
    .detail.activity_property_kind = () => true;
  expectCode('READINESS_EVIDENCE_BLOCKED', () =>
    captureDesktopReadinessData(refreshFixtureEvidence(callable))
  );
});

test('relative artifact paths combine artifactPath rules with readiness bounds', () => {
  const positive = makeFixture();
  const positiveWitness = positive.context.probe_artifacts.witness;
  const positiveEntry = positiveWitness['captures/window.png'];
  delete positiveWitness['captures/window.png'];
  positiveWitness['nested/window.png'] = positiveEntry;
  positive.proof.capabilities.find(
    item => item.name === 'own_widget_render_readback'
  ).detail.png_relative = 'nested/window.png';
  const positiveInput = refreshFixtureEvidence(positive);
  assert.equal(
    captureDesktopReadinessData(positiveInput).proof.capabilities.find(
      item => item.name === 'own_widget_render_readback'
    ).detail.png_relative,
    'nested/window.png'
  );

  const invalidNames = [
    'C:window.png',
    '../window.png',
    'nested\\window.png',
    'nested/\u0001window.png',
    'é'.repeat(129),
    `${'segment/'.repeat(16)}window.png`
  ];
  for (const relative of invalidNames) {
    const fixture = makeFixture();
    const witness = fixture.context.probe_artifacts.witness;
    const entry = witness['captures/window.png'];
    delete witness['captures/window.png'];
    witness[relative] = entry;
    fixture.proof.capabilities.find(
      item => item.name === 'own_widget_render_readback'
    ).detail.png_relative = relative;

    // Construct the caller's digest for the exact supplied witness bytes. The
    // validator must reject the path before treating that claim as evidence.
    const suppliedWitnessDigest = rawDomainHash(
      'squire.desktop-readiness.artifact-witness.v2', witness
    );
    const input = refreshFixtureEvidence(fixture, {
      witnessDigest: suppliedWitnessDigest
    });
    expectCode('INVALID_READINESS_CONTEXT', () =>
      captureDesktopReadinessData(input)
    );
  }
});

test('fixture factories isolate nested identities and imported policy data', () => {
  const first = makeFixture();
  const second = makeFixture();
  const firstActive = first.proof.capabilities.find(
    item => item.name === 'own_window_active'
  );
  const secondActive = second.proof.capabilities.find(
    item => item.name === 'own_window_active'
  );

  assert.notStrictEqual(
    first.config.desktop_runtime_identity, second.config.desktop_runtime_identity
  );
  assert.notStrictEqual(
    first.config.desktop_runtime_identity.executable,
    second.config.desktop_runtime_identity.executable
  );
  assert.notStrictEqual(
    first.config.desktop_runtime_identity.typelibs[0],
    second.config.desktop_runtime_identity.typelibs[0]
  );
  assert.notStrictEqual(
    first.config.desktop_runtime_identity.libraries[0],
    second.config.desktop_runtime_identity.libraries[0]
  );
  assert.notStrictEqual(first.route.runtime_identity, second.route.runtime_identity);
  assert.notStrictEqual(
    first.config.desktop_runtime_identity, first.route.runtime_identity
  );
  assert.deepEqual(
    first.config.desktop_runtime_identity, first.route.runtime_identity
  );

  assert.notStrictEqual(
    first.route.session.controller, second.route.session.controller
  );
  assert.notStrictEqual(first.route.session.server, second.route.session.server);
  assert.notStrictEqual(
    first.terminal.terminal.process, second.terminal.terminal.process
  );
  assert.notStrictEqual(
    firstActive.detail.process, secondActive.detail.process
  );
  assert.notStrictEqual(
    first.route.session.controller, first.proof.route.session.controller
  );
  assert.notStrictEqual(
    first.terminal.terminal.process, firstActive.detail.process
  );
  assert.deepEqual(
    first.terminal.terminal.process, firstActive.detail.process
  );

  assert.notStrictEqual(first.config.node, second.config.node);
  assert.notStrictEqual(
    first.config.generation_shutdown, second.config.generation_shutdown
  );
  assert.notStrictEqual(
    first.config.environment_policy, second.config.environment_policy
  );
  assert.notStrictEqual(
    first.config.environment_policy.deleted_keys,
    second.config.environment_policy.deleted_keys
  );
  assert.notStrictEqual(
    first.config.prefix_identity, second.config.prefix_identity
  );
  assert.notStrictEqual(
    first.config.execution_profile, second.config.execution_profile
  );
  assert.notStrictEqual(first.config.output_profile, second.config.output_profile);
  assert.notStrictEqual(
    first.config.diagnostic_retention, second.config.diagnostic_retention
  );

  first.config.desktop_runtime_identity.executable.sha256 = '0'.repeat(64);
  first.route.runtime_identity.status = 'QUALIFIED';
  first.route.session.controller.pid = 201;
  first.terminal.terminal.process.start_ticks = '99';
  firstActive.detail.process.boot_id = '00000000-0000-0000-0000-000000000002';
  first.config.node.path = '/synthetic/mutated-node';
  first.config.generation_shutdown.term_grace_ms = 9;
  first.config.environment_policy.deleted_keys[0] = 'MUTATED_POLICY_KEY';
  first.config.prefix_identity.bytes = 0;
  first.config.execution_profile.id = 'MUTATED_PROFILE';
  first.config.output_profile.max_all_files = 999;
  first.config.diagnostic_retention.max_bytes_per_file = 1;

  assert.equal(
    second.config.desktop_runtime_identity.executable.sha256, 'a'.repeat(64)
  );
  assert.equal(second.route.runtime_identity.status, 'NOT_QUALIFIED');
  assert.equal(second.route.session.controller.pid, 101);
  assert.equal(second.terminal.terminal.process.start_ticks, '13');
  assert.equal(
    secondActive.detail.process.boot_id, '00000000-0000-0000-0000-000000000001'
  );
  assert.equal(second.config.node.path, NODE_RUNTIME.path);
  assert.equal(
    second.config.generation_shutdown.term_grace_ms,
    GENERATION_SHUTDOWN.term_grace_ms
  );
  assert.equal(
    second.config.environment_policy.deleted_keys[0],
    PROJECT_ENVIRONMENT_POLICY.deleted_keys[0]
  );
  assert.equal(second.config.prefix_identity.bytes, DESKTOP_PREFIX_IDENTITY.bytes);
  assert.equal(
    second.config.execution_profile.id, PROJECT_CODING_OBSERVATION_PROFILE.id
  );
  assert.equal(second.config.output_profile.max_all_files, PROJECT_OUTPUT_LARGE_PROFILE.max_all_files);
  assert.equal(
    second.config.diagnostic_retention.max_bytes_per_file,
    RETENTION_POLICY.max_bytes_per_file
  );
  assert.equal(first.proof.route.session.controller.pid, 101);

  assert.doesNotThrow(() => captureDesktopReadinessData(second.input));
  const fresh = makeFixture();
  assert.doesNotThrow(() => captureDesktopReadinessData(fresh.input));
});

test('input-required route demands active-window evidence and exact process identity', () => {
  const fixture = makeFixture();
  const valid = captureDesktopReadinessData(fixture.input);
  const active = valid.proof.capabilities.find(
    item => item.name === 'own_window_active'
  );
  assert.deepEqual(active.detail.process, valid.observer_terminal.terminal.process);

  for (const [field, value] of [
    ['pid', 104],
    ['start_ticks', '14'],
    ['boot_id', '00000000-0000-0000-0000-000000000002']
  ]) {
    const changed = makeFixture();
    const changedActive = changed.proof.capabilities.find(
      item => item.name === 'own_window_active'
    );
    changedActive.detail.process = {
      ...changedActive.detail.process, [field]: value
    };
    expectCode('READINESS_EVIDENCE_BLOCKED', () =>
      captureDesktopReadinessData(refreshFixtureEvidence(changed))
    );
  }

  fixture.proof.capabilities.find(item => item.name === 'own_window_active')
    .detail.active = false;
  expectCode('READINESS_EVIDENCE_BLOCKED', () =>
    captureDesktopReadinessData(refreshFixtureEvidence(fixture))
  );

  const noInput = makeFixture({needsInput: false});
  assert.equal(captureDesktopReadinessData(noInput.input).proof.capabilities.length, 4);
});

test('fixture process cannot reuse the selected route controller or server identity', () => {
  for (const routeProcess of [makeController(), makeServer()]) {
    const fixture = makeFixture();
    fixture.terminal.terminal.process = {...routeProcess};
    fixture.proof.capabilities.find(item => item.name === 'own_window_active')
      .detail.process = {...routeProcess};
    expectCode('READINESS_EVIDENCE_BLOCKED', () =>
      captureDesktopReadinessData(refreshFixtureEvidence(fixture))
    );
  }
});

test('terminal data preserves signal exits faithfully and readiness rejects non-clean or partial terminals', () => {
  const signaled = {
    process: makeFixtureProcess(),
    started_at_ms: 10, ended_at_ms: 20,
    direct_child_exit_observed: true,
    exit_kind: 'signal', exit_code: null, signal: 'SIGTERM',
    stdout_eof: true, stderr_eof: true,
    stop_codes: ['TERM_ATTEMPTED'], cleanup_codes: [],
    descendant_guarantee: 'NOT_ESTABLISHED'
  };
  const captured = validateDesktopReadinessExecutedTerminal(signaled);
  assert.equal(captured.exit_code, null);
  assert.equal(captured.signal, 'SIGTERM');
  const mutations = [
    terminal => { terminal.exit_code = -15; },
    terminal => { terminal.direct_child_exit_observed = false; },
    terminal => { terminal.stdout_eof = false; },
    terminal => { terminal.cleanup_codes = ['CLOSE_FAILED']; },
    terminal => { terminal.exit_kind = 'unknown'; },
    terminal => {
      terminal.exit_kind = 'natural';
      terminal.exit_code = 1;
      terminal.signal = null;
    },
    terminal => {
      terminal.exit_kind = 'signal';
      terminal.exit_code = null;
      terminal.signal = 'SIGTERM';
      terminal.stop_codes = ['TERM_ATTEMPTED'];
    },
    terminal => { terminal.stop_codes = ['STOP_REQUESTED']; }
  ];
  for (const mutate of mutations) {
    const fixture = makeFixture();
    mutate(fixture.terminal.terminal);
    const input = refreshFixtureEvidence(fixture);
    if (fixture.terminal.terminal.exit_kind === 'natural' &&
        fixture.terminal.terminal.exit_code === 1 ||
        fixture.terminal.terminal.exit_kind === 'signal') {
      assert.doesNotThrow(() =>
        validateDesktopReadinessExecutedTerminal(fixture.terminal.terminal)
      );
    }
    expectCode('READINESS_EVIDENCE_BLOCKED', () => captureDesktopReadinessData({
      ...input
    }));
  }
});

test('freshness rejects future, stale and regressing times', () => {
  const capture = captureDesktopReadinessData(makeFixture().input);
  expectCode('READINESS_EVIDENCE_BLOCKED', () =>
    assertDesktopReadinessCurrent(capture, 999, null)
  );
  expectCode('READINESS_EVIDENCE_BLOCKED', () =>
    assertDesktopReadinessCurrent(capture, 301001, null)
  );
  expectCode('READINESS_EVIDENCE_BLOCKED', () =>
    assertDesktopReadinessCurrent(capture, 1200, 1201)
  );
  expectCode('READINESS_EVIDENCE_BLOCKED', () =>
    assertDesktopReadinessCurrent(capture, Number.MAX_SAFE_INTEGER + 1, null)
  );
});

test('scope separation uses path segments so siblings are allowed and descendants are rejected', () => {
  const sibling = makeFixture({scope: '/synthetic/task-extra'});
  assert.doesNotThrow(() => captureDesktopReadinessData(sibling.input));

  const descendant = makeFixture({scope: '/synthetic'});
  expectCode('READINESS_EVIDENCE_BLOCKED', () =>
    captureDesktopReadinessData(descendant.input)
  );

  const sourceOverlap = makeFixture({scope: PROJECT_SOURCE_ROOT});
  expectCode('READINESS_EVIDENCE_BLOCKED', () =>
    captureDesktopReadinessData(sourceOverlap.input)
  );
});

test('context and byte capture reject unknown fields, unsafe numbers, proxies, getters and sparse arrays', () => {
  const base = makeFixture();
  const unknown = structuredClone(base.context);
  unknown.extra = true;
  expectCode('INVALID_READINESS_CONTEXT', () =>
    validateDesktopReadinessContext(unknown)
  );

  const unsafe = structuredClone(base.context);
  unsafe.requirements.max_age_ms = Number.MAX_SAFE_INTEGER + 1;
  expectCode('INVALID_READINESS_CONTEXT', () =>
    validateDesktopReadinessContext(unsafe)
  );

  let touched = 0;
  const getter = structuredClone(base.context);
  Object.defineProperty(getter.requirements, 'needs_input', {
    enumerable: true,
    get() { touched++; return true; }
  });
  expectCode('INVALID_READINESS_CONTEXT', () =>
    validateDesktopReadinessContext(getter)
  );
  const proxy = new Proxy(structuredClone(base.context), {
    ownKeys() { touched++; throw new Error('private'); }
  });
  expectCode('INVALID_READINESS_CONTEXT', () =>
    validateDesktopReadinessContext(proxy)
  );
  const sparse = [];
  sparse.length = 2;
  sparse[1] = 'api_shape';
  const badRequirements = structuredClone(base.context.requirements);
  badRequirements.required_capabilities = sparse;
  expectCode('INVALID_READINESS_CONTEXT', () =>
    validateDesktopReadinessContext({...base.context, requirements: badRequirements})
  );
  assert.equal(touched, 0);

  const badBytes = new Proxy(base.input.configBytes, {});
  expectCode('INVALID_READINESS_CONTEXT', () =>
    captureDesktopReadinessData({...base.input, configBytes: badBytes})
  );
  expectCode('INVALID_READINESS_CONTEXT', () =>
    captureDesktopReadinessData({
      ...base.input,
      selectedRouteBytes: new Uint8Array(SELECTED_ROUTE_BYTE_LIMIT + 1)
    })
  );
});

test('the four-pin closure map is exact, bounded and resolved only from the fixed source root', () => {
  const pins = Object.fromEntries(DESKTOP_READINESS_COMPANION_PATHS.map(path => [
    path, {bytes: 10, sha256: 'a'.repeat(64)}
  ]));
  assert.deepEqual(
    Object.keys(validateDesktopReadinessCompanionSourcePins(pins)),
    DESKTOP_READINESS_COMPANION_PATHS
  );
  const resolved = resolveDesktopReadinessCompanionSourcePins(pins);
  assert.deepEqual(
    Object.keys(resolved).sort(),
    DESKTOP_READINESS_COMPANION_PATHS.map(path => join(PROJECT_SOURCE_ROOT, path)).sort()
  );
  for (const invalid of [
    {...pins, 'src/extra.mjs': {bytes: 1, sha256: 'b'.repeat(64)}},
    Object.fromEntries(DESKTOP_READINESS_COMPANION_PATHS.slice(1).map(path => [path, pins[path]])),
    {...pins, [DESKTOP_READINESS_COMPANION_PATHS[0]]: {bytes: 0, sha256: 'a'.repeat(64)}},
    {...pins, [DESKTOP_READINESS_COMPANION_PATHS[0]]: {bytes: 1, sha256: 'A'.repeat(64)}}
  ]) {
    expectCode('INVALID_READINESS_CONTEXT', () =>
      validateDesktopReadinessCompanionSourcePins(invalid)
    );
  }
});

test('domain helper rejects unknown tags and validates before hashing', () => {
  const fixture = makeFixture();
  assert.match(readinessDomainHash(
    'squire.desktop-readiness.route.v2', fixture.route
  ), /^[a-f0-9]{64}$/);
  expectCode('INVALID_READINESS_CONTEXT', () =>
    readinessDomainHash('squire.unapproved-domain.v1', {})
  );
  const invalid = structuredClone(fixture.route);
  invalid.session.port = Number.MAX_SAFE_INTEGER + 1;
  expectCode('INVALID_READINESS_CONTEXT', () =>
    readinessDomainHash('squire.desktop-readiness.route.v2', invalid)
  );
});

test('pinned-file and canonical-scope preflight verifies exact pins and returns only partial status', async () => {
  const {captured, files} = makePhysicallyPinnedCapture();
  const {ports, calls} = makeReadinessPreflightPorts(captured, files);
  const result = await verifyDesktopReadinessPinnedFilesAndScopeWithPorts(
    captured, undefined, ports
  );

  assert.deepEqual(result, {
    captured,
    verification_scope: 'PINNED_FILES_AND_CANONICAL_SCOPE_ONLY',
    probe_artifact_status: 'NOT_EVALUATED',
    native_app_status: 'NOT_QUALIFIED'
  });
  assert.deepEqual(Object.keys(result), [
    'captured', 'verification_scope', 'probe_artifact_status', 'native_app_status'
  ]);
  const expectedPins = [
    captured.context.proof_pin.path,
    captured.context.observer_terminal_pin.path,
    captured.context.fixture_definition_pin.path,
    captured.context.observer_definition_pin.path,
    captured.config.desktop_runtime_identity.executable.path,
    ...captured.config.desktop_runtime_identity.typelibs.map(entry => entry.typelib),
    ...captured.config.desktop_runtime_identity.libraries.map(entry => entry.path)
  ];
  assert.deepEqual(calls.verify.map(identity => identity.path), expectedPins);
  assert.deepEqual(calls.pinLstat, expectedPins);
  assert.equal(calls.fsLstat.length, 1);
  assert.equal(calls.fsLstat[0], captured.config.scope);
  assert.deepEqual(calls.realpath, [
    dirname(captured.config.scope),
    captured.context.proof_pin.path,
    captured.context.observer_terminal_pin.path,
    captured.context.fixture_definition_pin.path,
    captured.context.observer_definition_pin.path,
    captured.context.probe_artifacts.root,
    join(captured.context.probe_artifacts.root, 'captures/window.png')
  ]);
  assert.deepEqual(calls.chunkNext,
    expectedPins.flatMap(path => [path, path]));
  assert.deepEqual(calls.iteratorReturn, []);
  assert.deepEqual(calls.mutations, []);
});

test('natural EOF without a value is accepted by the real exact-file verifier', async () => {
  const {captured, files} = makePhysicallyPinnedCapture();
  const {ports, calls} = makeReadinessPreflightPorts(captured, files);
  await verifyDesktopReadinessPinnedFilesAndScopeWithPorts(
    captured, undefined, ports
  );

  const expectedPins = [
    captured.context.proof_pin.path,
    captured.context.observer_terminal_pin.path,
    captured.context.fixture_definition_pin.path,
    captured.context.observer_definition_pin.path,
    captured.config.desktop_runtime_identity.executable.path,
    ...captured.config.desktop_runtime_identity.typelibs.map(entry => entry.typelib),
    ...captured.config.desktop_runtime_identity.libraries.map(entry => entry.path)
  ];
  assert.deepEqual(calls.chunkNext,
    expectedPins.flatMap(path => [path, path]));
  assert.deepEqual(calls.iteratorReturn, []);
  assert.deepEqual(calls.verify.map(identity => identity.path), expectedPins);
});

test('physical pin hash, size, missing-file and symlink faults reduce to the fixed blocked code', async () => {
  const cases = [
    {
      name: 'proof hash mismatch',
      prepare(captured, files) {
        files.get(captured.context.proof_pin.path)[0] ^= 1;
      }
    },
    {
      name: 'terminal size mismatch',
      hooks(captured) {
        return {statFault: path =>
          path === captured.context.observer_terminal_pin.path ? 'size' : null};
      }
    },
    {
      name: 'missing definition file',
      prepare(captured, files) {
        files.delete(captured.context.fixture_definition_pin.path);
      }
    },
    {
      name: 'runtime typelib hash mismatch',
      prepare(captured, files) {
        const path = captured.config.desktop_runtime_identity.typelibs[0].typelib;
        files.get(path)[0] ^= 1;
      }
    },
    {
      name: 'missing runtime library',
      prepare(captured, files) {
        files.delete(captured.config.desktop_runtime_identity.libraries[0].path);
      }
    },
    {
      name: 'runtime typelib symlink',
      hooks(captured) {
        const path = captured.config.desktop_runtime_identity.typelibs[0].typelib;
        return {statFault: candidate => candidate === path ? 'symlink' : null};
      }
    }
  ];

  for (const item of cases) {
    const {captured, files} = makePhysicallyPinnedCapture();
    item.prepare?.(captured, files);
    const {ports, calls} = makeReadinessPreflightPorts(
      captured, files, item.hooks?.(captured)
    );
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      verifyDesktopReadinessPinnedFilesAndScopeWithPorts(captured, undefined, ports)
    );
    assert.deepEqual(calls.mutations, [], item.name);
  }
});

test('forged captures, malformed ports and malformed signals reject before effects', async () => {
  const {captured, files} = makePhysicallyPinnedCapture();
  const baseline = makeReadinessPreflightPorts(captured, files);
  const forged = structuredClone(captured);
  await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
    verifyDesktopReadinessPinnedFilesAndScopeWithPorts(
      forged, undefined, baseline.ports
    )
  );
  assert.equal(baseline.calls.verify.length, 0);
  assert.equal(baseline.calls.realpath.length, 0);

  let touched = 0;
  const getterPorts = {
    get fs() { touched++; return baseline.ports.fs; },
    verifyFile: baseline.ports.verifyFile,
    reads: baseline.ports.reads
  };
  const unknownPorts = {...baseline.ports, extra: true};
  const proxyPorts = new Proxy(baseline.ports, {});
  const malformedSignal = Object.create(AbortSignal.prototype);
  const proxySignal = new Proxy(new AbortController().signal, {});
  for (const [ports, signal] of [
    [getterPorts, undefined],
    [unknownPorts, undefined],
    [proxyPorts, undefined],
    [baseline.ports, malformedSignal],
    [baseline.ports, proxySignal]
  ]) {
    await expectCodeAsync('INVALID_READINESS_CONTEXT', () =>
      verifyDesktopReadinessPinnedFilesAndScopeWithPorts(captured, signal, ports)
    );
  }
  assert.equal(touched, 0);
  assert.equal(baseline.calls.verify.length, 0);
  assert.equal(baseline.calls.realpath.length, 0);
  assert.equal(baseline.calls.pinLstat.length, 0);
});

test('canonical scope requires a sibling-safe absent scope and a canonical parent', async () => {
  const sibling = makePhysicallyPinnedCapture({scope: '/synthetic/task-extra'});
  const siblingPorts = makeReadinessPreflightPorts(sibling.captured, sibling.files);
  const siblingResult = await verifyDesktopReadinessPinnedFilesAndScopeWithPorts(
    sibling.captured, undefined, siblingPorts.ports
  );
  assert.equal(siblingResult.probe_artifact_status, 'NOT_EVALUATED');

  for (const scopeLstat of [
    () => ({}),
    () => { throw Object.assign(new Error('unknown'), {code: 'EACCES'}); }
  ]) {
    const {captured, files} = makePhysicallyPinnedCapture();
    const {ports, calls} = makeReadinessPreflightPorts(captured, files, {scopeLstat});
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      verifyDesktopReadinessPinnedFilesAndScopeWithPorts(captured, undefined, ports)
    );
    assert.equal(calls.fsLstat.length, 1);
    assert.deepEqual(calls.mutations, []);
  }

  const {captured, files} = makePhysicallyPinnedCapture();
  const {ports, calls} = makeReadinessPreflightPorts(captured, files, {
    realpath(path) {
      return path === dirname(captured.config.scope) ? '/canonical/synthetic' : path;
    }
  });
  await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
    verifyDesktopReadinessPinnedFilesAndScopeWithPorts(captured, undefined, ports)
  );
  assert.deepEqual(calls.realpath, [dirname(captured.config.scope)]);
  assert.equal(calls.fsLstat.length, 0);
  assert.deepEqual(calls.mutations, []);
});

test('canonical evidence, probe-root and witness aliases into scope are blocked', async () => {
  const base = makePhysicallyPinnedCapture();
  const paths = [
    base.captured.context.proof_pin.path,
    base.captured.context.observer_terminal_pin.path,
    base.captured.context.fixture_definition_pin.path,
    base.captured.context.observer_definition_pin.path,
    base.captured.context.probe_artifacts.root,
    join(base.captured.context.probe_artifacts.root, 'captures/window.png')
  ];
  for (const aliasPath of paths) {
    const {captured, files} = makePhysicallyPinnedCapture();
    const alias = `${captured.config.scope}/canonical-alias`;
    const {ports, calls} = makeReadinessPreflightPorts(captured, files, {
      realpath(path) {
        return path === aliasPath ? alias : path;
      }
    });
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      verifyDesktopReadinessPinnedFilesAndScopeWithPorts(captured, undefined, ports)
    );
    assert.equal(calls.realpath.includes(aliasPath), true);
    assert.deepEqual(calls.mutations, []);
  }
});

test('abort before start, during pins, after next, before a later next and during cleanup stops work', async () => {
  {
    const {captured, files} = makePhysicallyPinnedCapture();
    const {ports, calls} = makeReadinessPreflightPorts(captured, files);
    const controller = new AbortController();
    controller.abort();
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      verifyDesktopReadinessPinnedFilesAndScopeWithPorts(
        captured, controller.signal, ports
      )
    );
    assert.equal(calls.verify.length, 0);
    assert.equal(calls.realpath.length, 0);
  }

  {
    const {captured, files} = makePhysicallyPinnedCapture();
    const controller = new AbortController();
    const {ports, calls} = makeReadinessPreflightPorts(captured, files, {
      async pinLstat() { controller.abort(); }
    });
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      verifyDesktopReadinessPinnedFilesAndScopeWithPorts(
        captured, controller.signal, ports
      )
    );
    assert.equal(calls.verify.length, 1);
    assert.equal(calls.chunkNext.length, 0);
    assert.equal(calls.realpath.length, 0);
  }

  {
    const {captured, files} = makePhysicallyPinnedCapture();
    const controller = new AbortController();
    const {ports, calls} = makeReadinessPreflightPorts(captured, files, {
      async chunkNext() { controller.abort(); }
    });
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      verifyDesktopReadinessPinnedFilesAndScopeWithPorts(
        captured, controller.signal, ports
      )
    );
    assert.equal(calls.chunkNext.length, 1);
    assert.equal(calls.iteratorReturn.length, 1);
    assert.equal(calls.verify.length, 1);
  }

  {
    const {captured, files} = makePhysicallyPinnedCapture();
    const controller = new AbortController();
    const {ports, calls} = makeReadinessPreflightPorts(captured, files, {
      iteratorForPath(path, observed, contents) {
        const iterator = {
          async next() {
            observed.chunkNext.push(path);
            return {done: false, value: contents};
          },
          async return(value) {
            observed.iteratorReturn.push(path);
            return {done: true, value};
          }
        };
        return {
          [Symbol.asyncIterator]() {
            controller.abort();
            return iterator;
          }
        };
      }
    });
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      verifyDesktopReadinessPinnedFilesAndScopeWithPorts(
        captured, controller.signal, ports
      )
    );
    assert.equal(calls.chunkNext.length, 0);
    assert.deepEqual(calls.iteratorReturn, [captured.context.proof_pin.path]);
    assert.equal(calls.verify.length, 1);
  }

  for (const abortAt of ['scope-lstat', 'evidence-realpath']) {
    const {captured, files} = makePhysicallyPinnedCapture();
    const controller = new AbortController();
    const {ports, calls} = makeReadinessPreflightPorts(captured, files, {
      async scopeLstat() {
        if (abortAt === 'scope-lstat') controller.abort();
        throw Object.assign(new Error('missing'), {code: 'ENOENT'});
      },
      realpath(path) {
        if (abortAt === 'evidence-realpath' &&
            path === captured.context.proof_pin.path) controller.abort();
        return path;
      }
    });
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      verifyDesktopReadinessPinnedFilesAndScopeWithPorts(
        captured, controller.signal, ports
      )
    );
    if (abortAt === 'scope-lstat') {
      assert.equal(calls.realpath.length, 1);
      assert.equal(calls.fsLstat.length, 1);
    } else {
      assert.equal(calls.realpath.includes(captured.context.proof_pin.path), true);
      assert.equal(calls.realpath.includes(captured.context.observer_terminal_pin.path), false);
    }
  }

  {
    const {captured, files} = makePhysicallyPinnedCapture();
    const controller = new AbortController();
    const {ports, calls} = makeReadinessPreflightPorts(captured, files, {
      async chunkNext(path, observed) {
        observed.events.push(`primary:${path}`);
        throw new Error('primary read failure');
      },
      async iteratorReturn(path, observed) {
        observed.events.push(`cleanup:${path}`);
        controller.abort();
      }
    });
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      verifyDesktopReadinessPinnedFilesAndScopeWithPorts(
        captured, controller.signal, ports
      )
    );
    assert.deepEqual(calls.events, [
      `primary:${captured.context.proof_pin.path}`,
      `cleanup:${captured.context.proof_pin.path}`
    ]);
    assert.deepEqual(calls.iteratorReturn, [captured.context.proof_pin.path]);
    assert.equal(calls.verify.length, 1);
  }
});

test('abort between yielded data and the next call closes without another underlying next', async () => {
  const {captured, files} = makePhysicallyPinnedCapture();
  const proofPath = captured.context.proof_pin.path;
  const controller = new AbortController();
  const typedLength = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype), 'length'
  ).get;
  const {ports, calls} = makeReadinessPreflightPorts(captured, files, {
    chunkBytes(path, contents) {
      if (path !== proofPath) return contents;
      const chunk = new Uint8Array(contents);
      const length = typedLength.call(chunk);
      Object.defineProperty(chunk, 'length', {
        configurable: true,
        get() {
          controller.abort();
          return length;
        }
      });
      return chunk;
    }
  });

  await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
    verifyDesktopReadinessPinnedFilesAndScopeWithPorts(
      captured, controller.signal, ports
    )
  );
  assert.deepEqual(calls.chunkNext, [proofPath]);
  assert.deepEqual(calls.iteratorReturn, [proofPath]);
  assert.equal(calls.verify.length, 1);
  assert.equal(calls.realpath.length, 0);
});

test('malformed iterator results reject without running accessors and close acquired iterators', async () => {
  for (const mode of ['bad-done', 'non-byte-value', 'proxy-value', 'accessor-result', 'proxy-result']) {
    const {captured, files} = makePhysicallyPinnedCapture();
    let touched = 0;
    const {ports, calls} = makeReadinessPreflightPorts(captured, files, {
      iteratorForPath(path, observed, contents) {
        let result;
        if (mode === 'bad-done') {
          result = {done: 'true', value: contents};
        } else if (mode === 'non-byte-value') {
          result = {done: false, value: 'not bytes'};
        } else if (mode === 'proxy-value') {
          result = {done: false, value: new Proxy(contents, {})};
        } else if (mode === 'accessor-result') {
          result = {};
          Object.defineProperty(result, 'done', {
            get() {
              touched++;
              return false;
            }
          });
          Object.defineProperty(result, 'value', {value: contents});
        } else {
          result = new Proxy({done: false, value: contents}, {
            ownKeys() {
              touched++;
              throw new Error('iterator result proxy trap');
            }
          });
        }
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                observed.chunkNext.push(path);
                return result;
              },
              async return(value) {
                observed.iteratorReturn.push(path);
                return {done: true, value};
              }
            };
          }
        };
      }
    });
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      verifyDesktopReadinessPinnedFilesAndScopeWithPorts(captured, undefined, ports)
    );
    assert.equal(touched, 0, mode);
    assert.deepEqual(calls.chunkNext, [captured.context.proof_pin.path], mode);
    assert.deepEqual(calls.iteratorReturn, [captured.context.proof_pin.path], mode);
    assert.equal(calls.verify.length, 1, mode);
  }
});

test('next rejection attempts iterator cleanup and retains primary-before-cleanup observations', async () => {
  const {captured, files} = makePhysicallyPinnedCapture();
  const {ports, calls} = makeReadinessPreflightPorts(captured, files, {
    async chunkNext(path, observed) {
      observed.events.push(`primary:${path}`);
      throw new Error('primary read failure');
    },
    async iteratorReturn(path, observed) {
      observed.events.push(`cleanup:${path}`);
      throw new Error('iterator cleanup failure');
    }
  });
  await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
    verifyDesktopReadinessPinnedFilesAndScopeWithPorts(captured, undefined, ports)
  );
  assert.deepEqual(calls.events, [
    `primary:${captured.context.proof_pin.path}`,
    `cleanup:${captured.context.proof_pin.path}`
  ]);
  assert.deepEqual(calls.iteratorReturn, [captured.context.proof_pin.path]);
  assert.equal(calls.verify.length, 1);
  assert.deepEqual(calls.mutations, []);
});

test('iterator setup failures close acquired iterators when possible and do not invent pre-acquisition cleanup', async () => {
  for (const mode of ['available', 'missing', 'throwing', 'invalid', 'factory-failure']) {
    const {captured, files} = makePhysicallyPinnedCapture();
    let accessorTouched = 0;
    const {ports, calls} = makeReadinessPreflightPorts(captured, files, {
      iteratorForPath(path, observed) {
        if (mode === 'factory-failure') {
          return {
            [Symbol.asyncIterator]() {
              throw new Error('iterator factory failure');
            }
          };
        }
        const iterator = {};
        Object.defineProperty(iterator, 'next', {
          configurable: true,
          get() {
            accessorTouched++;
            throw new Error('next accessor must not run');
          }
        });
        if (mode === 'available' || mode === 'throwing') {
          Object.defineProperty(iterator, 'return', {
            value: async value => {
              observed.iteratorReturn.push(path);
              if (mode === 'throwing') throw new Error('cleanup failure');
              return {done: true, value};
            }
          });
        } else if (mode === 'invalid') {
          Object.defineProperty(iterator, 'return', {
            get() {
              accessorTouched++;
              throw new Error('return accessor must not run');
            }
          });
        }
        return {[Symbol.asyncIterator]: () => iterator};
      }
    });
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      verifyDesktopReadinessPinnedFilesAndScopeWithPorts(captured, undefined, ports)
    );
    assert.equal(calls.verify.length, 1, mode);
    assert.equal(accessorTouched, 0, mode);
    if (mode === 'available' || mode === 'throwing') {
      assert.deepEqual(calls.iteratorReturn, [captured.context.proof_pin.path], mode);
    } else {
      assert.deepEqual(calls.iteratorReturn, [], mode);
    }
  }
});

test('consumer failure and repeated wrapper return close the real iterator only once', async () => {
  {
    const {captured, files} = makePhysicallyPinnedCapture();
    const {ports, calls} = makeReadinessPreflightPorts(captured, files, {
      chunkBytes(path, contents) {
        return path === captured.context.proof_pin.path
          ? Uint8Array.from([...contents, 0])
          : contents;
      }
    });
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      verifyDesktopReadinessPinnedFilesAndScopeWithPorts(captured, undefined, ports)
    );
    assert.deepEqual(calls.iteratorReturn, [captured.context.proof_pin.path]);
    assert.equal(calls.verify.length, 1);
  }

  {
    const {captured, files} = makePhysicallyPinnedCapture();
    const {ports: basePorts, calls} = makeReadinessPreflightPorts(captured, files);
    const proofPath = captured.context.proof_pin.path;
    const ports = {
      ...basePorts,
      verifyFile(identity, reads) {
        calls.verify.push(identity);
        if (identity.path !== proofPath) return verifyExactFile(identity, reads);
        const iterator = reads.readChunks(identity.path)[Symbol.asyncIterator]();
        return (async () => {
          await iterator.next();
          await iterator.return();
          await iterator.return();
          throw new Error('consumer failure after explicit returns');
        })();
      }
    };
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      verifyDesktopReadinessPinnedFilesAndScopeWithPorts(captured, undefined, ports)
    );
    assert.deepEqual(calls.iteratorReturn, [proofPath]);
    assert.equal(calls.verify.length, 1);
  }
});

test('falsy proof lstat rejections block immediately while the same fixture succeeds without rejection', async () => {
  const {captured, files} = makePhysicallyPinnedCapture();
  const proofPath = captured.context.proof_pin.path;
  const positive = makeReadinessPreflightPorts(captured, files);
  const result = await verifyDesktopReadinessPinnedFilesAndScopeWithPorts(
    captured, undefined, positive.ports
  );
  assert.equal(result.verification_scope, 'PINNED_FILES_AND_CANONICAL_SCOPE_ONLY');
  assert.equal(result.probe_artifact_status, 'NOT_EVALUATED');
  assert.equal(result.native_app_status, 'NOT_QUALIFIED');

  for (const thrown of [null, undefined, false, 0, '']) {
    const {ports, calls} = makeReadinessPreflightPorts(captured, files, {
      pinLstat(path) {
        if (path === proofPath) throw thrown;
      }
    });
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      verifyDesktopReadinessPinnedFilesAndScopeWithPorts(
        captured, undefined, ports
      )
    );
    assert.deepEqual(calls.verify.map(identity => identity.path), [proofPath]);
    assert.deepEqual(calls.pinLstat, [proofPath]);
    assert.deepEqual(calls.readChunks, []);
    assert.deepEqual(calls.chunkNext, []);
    assert.deepEqual(calls.iteratorReturn, []);
    assert.deepEqual(calls.realpath, []);
    assert.deepEqual(calls.fsLstat, []);
  }
});

test('falsy next failures retain primary and cleanup occurrence and stop all later pins', async () => {
  const cases = [
    [null, new Error('cleanup failure')],
    [undefined, false],
    [false, new Error('cleanup failure')],
    [0, null],
    ['', undefined]
  ];
  for (const [primary, cleanup] of cases) {
    const {captured, files} = makePhysicallyPinnedCapture();
    const proofPath = captured.context.proof_pin.path;
    const {ports, calls} = makeReadinessPreflightPorts(captured, files, {
      async chunkNext(path, observed) {
        observed.events.push(`primary:${path}`);
        throw primary;
      },
      async iteratorReturn(path, observed) {
        observed.events.push(`cleanup:${path}`);
        throw cleanup;
      }
    });
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      verifyDesktopReadinessPinnedFilesAndScopeWithPorts(
        captured, undefined, ports
      )
    );
    assert.deepEqual(calls.events, [
      `primary:${proofPath}`, `cleanup:${proofPath}`
    ]);
    assert.deepEqual(calls.verify.map(identity => identity.path), [proofPath]);
    assert.deepEqual(calls.pinLstat, [proofPath]);
    assert.deepEqual(calls.iteratorReturn, [proofPath]);
    assert.deepEqual(calls.realpath, []);
    assert.deepEqual(calls.fsLstat, []);
  }
});

test('falsy cleanup rejection remains blocking when a consumer catches repeated returns', async () => {
  for (const cleanup of [null, undefined, false, 0, '']) {
    const {captured, files} = makePhysicallyPinnedCapture();
    const proofPath = captured.context.proof_pin.path;
    const {ports: basePorts, calls} = makeReadinessPreflightPorts(
      captured, files, {
        async iteratorReturn(path, observed) {
          observed.events.push(`cleanup:${path}`);
          throw cleanup;
        }
      }
    );
    const caught = [];
    const ports = {
      ...basePorts,
      verifyFile(identity, reads) {
        calls.verify.push(identity);
        if (identity.path !== proofPath) return verifyExactFile(identity, reads);
        const iterator = reads.readChunks(identity.path)[Symbol.asyncIterator]();
        return (async () => {
          await iterator.next();
          for (let count = 0; count < 2; count++) {
            try {
              await iterator.return();
            } catch (error) {
              caught.push(error);
            }
          }
          try {
            await iterator.next();
          } catch (error) {
            caught.push(error);
          }
          return identity;
        })();
      }
    };
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      verifyDesktopReadinessPinnedFilesAndScopeWithPorts(
        captured, undefined, ports
      )
    );
    assert.deepEqual(caught, [cleanup, cleanup, cleanup]);
    assert.deepEqual(calls.events, [`cleanup:${proofPath}`]);
    assert.deepEqual(calls.verify.map(identity => identity.path), [proofPath]);
    assert.deepEqual(calls.chunkNext, [proofPath]);
    assert.deepEqual(calls.iteratorReturn, [proofPath]);
    assert.deepEqual(calls.realpath, []);
    assert.deepEqual(calls.fsLstat, []);
  }
});

test('falsy readChunks and iterator-factory failures record failure before later work', async () => {
  for (const thrown of [null, undefined, false, 0, '']) {
    for (const mode of ['readChunks', 'iterator-factory']) {
      const {captured, files} = makePhysicallyPinnedCapture();
      const proofPath = captured.context.proof_pin.path;
      const hooks = mode === 'readChunks'
        ? {readChunks() { throw thrown; }}
        : {
            iteratorForPath() {
              return {
                [Symbol.asyncIterator]() {
                  throw thrown;
                }
              };
            }
          };
      const {ports, calls} = makeReadinessPreflightPorts(
        captured, files, hooks
      );
      await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
        verifyDesktopReadinessPinnedFilesAndScopeWithPorts(
          captured, undefined, ports
        )
      );
      assert.deepEqual(calls.verify.map(identity => identity.path), [proofPath]);
      assert.deepEqual(calls.pinLstat, [proofPath]);
      assert.deepEqual(calls.readChunks, [proofPath]);
      assert.deepEqual(calls.chunkNext, []);
      assert.deepEqual(calls.iteratorReturn, []);
      assert.deepEqual(calls.realpath, []);
      assert.deepEqual(calls.fsLstat, []);
    }
  }
});

test('probe bytes use the unchanged verifier, preserve the byte-only result, and isolate invocation state', async () => {
  const {captured, files} = makeProbeArtifactCapture();
  const root = captured.context.probe_artifacts.root;
  const path = join(root, 'captures/window.png');
  const relative = 'captures/window.png';
  const serializedCapture = JSON.stringify(captured);
  const serializedWitness = JSON.stringify(captured.context.probe_artifacts.witness);
  const capturedDocumentNames = [
    'config', 'context', 'selected_route', 'proof', 'observer_terminal',
    'fixture_definition', 'observer_definition'
  ];
  const documentBytes = new Map(capturedDocumentNames.map(name => [
    name, copyCapturedDesktopReadinessBytes(captured, name)
  ]));
  const fileHashes = [...files].map(([filePath, contents]) => [
    filePath, hash(contents)
  ]);

  assert.equal(Object.isFrozen(captured), true);
  assert.equal(Object.isFrozen(captured.config.desktop_runtime_identity), true);
  assert.equal(Object.isFrozen(captured.context.probe_artifacts.witness), true);
  assert.equal(Object.isFrozen(captured.context.proof_pin), true);

  const directHarness = makeProbeArtifactPorts(captured, files);
  const direct = await verifyArtifacts({
    job_id: captured.config.job_id,
    task_scope: root,
    provider_id: captured.config.provider_id,
    requested_model: captured.config.requested_model,
    max_wall_clock_sec: 1,
    max_steps: 1,
    required_artifacts: [relative]
  }, {
    fs: directHarness.ports.fs,
    expected_capture: {
      job_id: captured.config.job_id,
      artifact_witness: captured.context.probe_artifacts.witness
    }
  });
  assert.equal(direct.verified, true);
  assert.equal(direct.failure, null);
  assert.deepEqual({...direct.artifact_witness[relative]}, {
    byte_count: 8,
    sha256: hash(files.get(path))
  });
  assert.deepEqual(directHarness.calls.trace,
    probeVerifierSuccessTrace(root, path, 8));
  assert.equal(directHarness.calls.handleStat.length, 2);
  assert.deepEqual(directHarness.calls.read.map(({length, position}) => ({
    length, position
  })), [
    {length: 8, position: 0},
    {length: 1, position: 8}
  ]);
  assert.deepEqual(directHarness.calls.close, [path]);

  for (let invocation = 0; invocation < 2; invocation++) {
    const {ports, calls} = makeProbeArtifactPorts(captured, files);
    const result = await verifyDesktopReadinessProbeArtifactsWithPorts(
      captured, undefined, ports
    );
    assert.deepEqual(result, {
      captured,
      verification_scope: 'PROBE_ARTIFACT_BYTES_ONLY',
      artifact_content_verification: 'VERIFIED',
      readiness_status: 'NOT_EVALUATED',
      native_app_status: 'NOT_QUALIFIED'
    });
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(Object.keys(result), [
      'captured', 'verification_scope', 'artifact_content_verification',
      'readiness_status', 'native_app_status'
    ]);
    assert.deepEqual(calls.trace,
      probeAdapterWrappedSuccessTrace(root, path, 8));
    assert.deepEqual(calls.read.map(({length, position}) => ({length, position})), [
      {length: 8, position: 0},
      {length: 1, position: 8}
    ]);
    assert.deepEqual(calls.close, [path]);
    assert.equal(calls.handleStat.length, 3);
    assert.deepEqual(calls.handleStat.map(call => call.args.length), [1, 1, 1]);
    assert.deepEqual(calls.open.map(call => call.path), [path]);
  }

  assert.equal(JSON.stringify(captured), serializedCapture);
  assert.equal(
    JSON.stringify(captured.context.probe_artifacts.witness), serializedWitness
  );
  assert.deepEqual([...files].map(([filePath, contents]) => [
    filePath, hash(contents)
  ]), fileHashes);
  for (const name of capturedDocumentNames) {
    assert.deepEqual(copyCapturedDesktopReadinessBytes(captured, name),
      documentBytes.get(name));
  }
});

test('probe forged captures, malformed ports and malformed signals reject before filesystem effects', async () => {
  const {captured, files} = makeProbeArtifactCapture();
  const baseline = makeProbeArtifactPorts(captured, files);
  const forged = structuredClone(captured);

  await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
    verifyDesktopReadinessProbeArtifactsWithPorts(
      forged, undefined, baseline.ports
    )
  );

  let touched = 0;
  const getterPorts = {
    get fs() { touched++; return baseline.ports.fs; },
    uid: baseline.ports.uid
  };
  const getterFs = {
    lstat: baseline.ports.fs.lstat,
    realpath: baseline.ports.fs.realpath,
    get open() { touched++; return baseline.ports.fs.open; }
  };
  const proxyPorts = new Proxy(baseline.ports, {
    ownKeys() { touched++; throw new Error('ports proxy trap'); }
  });
  const proxyFs = new Proxy(baseline.ports.fs, {
    ownKeys() { touched++; throw new Error('fs proxy trap'); }
  });
  const malformedSignal = Object.create(AbortSignal.prototype);
  const proxySignal = new Proxy(new AbortController().signal, {
    get() { touched++; throw new Error('signal proxy trap'); }
  });
  const invalidPorts = [
    {...baseline.ports, extra: true},
    getterPorts,
    {fs: getterFs, uid: baseline.ports.uid},
    proxyPorts,
    {fs: proxyFs, uid: baseline.ports.uid},
    {fs: baseline.ports.fs, uid: -1},
    {fs: baseline.ports.fs, uid: true},
    {fs: baseline.ports.fs, uid: 1.5},
    {fs: baseline.ports.fs, uid: Number.MAX_SAFE_INTEGER + 1}
  ];

  for (const ports of invalidPorts) {
    await expectCodeAsync('INVALID_READINESS_CONTEXT', () =>
      verifyDesktopReadinessProbeArtifactsWithPorts(
        captured, undefined, ports
      )
    );
  }
  for (const signal of [malformedSignal, proxySignal]) {
    await expectCodeAsync('INVALID_READINESS_CONTEXT', () =>
      verifyDesktopReadinessProbeArtifactsWithPorts(
        captured, signal, baseline.ports
      )
    );
  }

  assert.equal(touched, 0);
  assert.deepEqual(baseline.calls.trace, []);
  assert.deepEqual(baseline.calls.lstat, []);
  assert.deepEqual(baseline.calls.realpath, []);
  assert.deepEqual(baseline.calls.open, []);
});

test('probe hash, size, missing-file, symlink, hardlink and owner faults block with phase-correct traces', async () => {
  {
    const {captured, files} = makeProbeArtifactCapture();
    const {ports} = makeProbeArtifactPorts(captured, files);
    const result = await verifyDesktopReadinessProbeArtifactsWithPorts(
      captured, undefined, ports
    );
    assert.equal(result.artifact_content_verification, 'VERIFIED');
  }

  for (const mode of [
    'wrong-hash', 'wrong-size', 'missing', 'symlink', 'hardlink', 'wrong-owner'
  ]) {
    const {captured, files} = makeProbeArtifactCapture();
    const root = captured.context.probe_artifacts.root;
    const path = join(root, 'captures/window.png');
    const expectedSize = captured.context.probe_artifacts.witness[
      'captures/window.png'
    ].byte_count;
    if (mode === 'wrong-hash') files.get(path)[0] ^= 1;
    const hooks = {};

    if (mode === 'missing') {
      hooks.beforeLstat = candidate => {
        if (candidate === path) {
          throw Object.assign(new Error('missing'), {code: 'ENOENT'});
        }
      };
    } else if (mode !== 'wrong-hash') {
      hooks.lstatStat = (candidate, count, stat) => {
        if (candidate !== path) return stat;
        if (mode === 'wrong-size') {
          return {...stat, size: BigInt(expectedSize + 1)};
        }
        if (mode === 'symlink') {
          return makeProbeStat({
            kind: 'file', size: expectedSize, symbolicLink: true
          });
        }
        if (mode === 'hardlink') return {...stat, nlink: 2n};
        if (mode === 'wrong-owner') {
          return {...stat, uid: PROBE_TEST_UID + 1};
        }
        return stat;
      };
    }

    const {ports, calls} = makeProbeArtifactPorts(captured, files, hooks);
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      verifyDesktopReadinessProbeArtifactsWithPorts(
        captured, undefined, ports
      )
    );
    if (mode === 'wrong-hash') {
      assert.deepEqual(calls.trace,
        probeAdapterWrappedSuccessTrace(root, path, 8));
      assert.deepEqual(calls.read.map(({length, position}) => ({
        length, position
      })), [
        {length: 8, position: 0},
        {length: 1, position: 8}
      ]);
      assert.deepEqual(calls.open.map(call => call.path), [path]);
      assert.deepEqual(calls.close, [path]);
    } else {
      assert.deepEqual(calls.trace, [
        `lstat:${root}`,
        `realpath:${root}`,
        `lstat:${join(root, 'captures')}`,
        `lstat:${path}`
      ], mode);
      assert.deepEqual(calls.realpath.map(call => call.path), [root], mode);
      assert.deepEqual(calls.open, [], mode);
      assert.deepEqual(calls.close, [], mode);
    }
  }
});

test('probe file and directory inode changes fail at the targeted verifier phase and close acquired handles', async () => {
  const cases = [
    {
      name: 'initial file lstat differs from adapter opened stat',
      makeHooks(_root, path) {
        return {
          lstatStat(candidate, count, stat) {
            return candidate === path && count === 1
              ? {...stat, ino: stat.ino + 1n}
              : stat;
          }
        };
      },
      expectedTrace(root, path) {
        return [
          ...probeVerifierPrefix(root, path),
          `open:${path}`, `stat:${path}`, `close:${path}`
        ];
      },
      expectedHandleStats: 1,
      expectedReads: 0
    },
    {
      name: 'adapter opened stat differs from initial file lstat',
      makeHooks(_root, _path) {
        return {
          handleStat(_candidate, count, stat) {
            return count === 1 ? {...stat, ino: stat.ino + 1n} : stat;
          }
        };
      },
      expectedTrace(root, path) {
        return [
          ...probeVerifierPrefix(root, path),
          `open:${path}`, `stat:${path}`, `close:${path}`
        ];
      },
      expectedHandleStats: 1,
      expectedReads: 0
    },
    {
      name: 'verifier opened baseline differs after adapter pre-return validation',
      makeHooks(_root, _path) {
        return {
          handleStat(_candidate, count, stat) {
            return count === 2 ? {...stat, ino: stat.ino + 1n} : stat;
          }
        };
      },
      expectedTrace(root, path) {
        return [
          ...probeVerifierPrefix(root, path),
          `open:${path}`, `stat:${path}`, `stat:${path}`, `close:${path}`
        ];
      },
      expectedHandleStats: 2,
      expectedReads: 0
    },
    {
      name: 'verifier post-read stat changes after payload and EOF',
      makeHooks(_root, _path) {
        return {
          handleStat(_candidate, count, stat) {
            return count === 3 ? {...stat, ino: stat.ino + 1n} : stat;
          }
        };
      },
      expectedTrace(root, path) {
        return [
          ...probeVerifierPrefix(root, path),
          `open:${path}`, `stat:${path}`, `stat:${path}`,
          `read:${path}:0:8`, `read:${path}:8:1`,
          `stat:${path}`, `close:${path}`
        ];
      },
      expectedHandleStats: 3,
      expectedReads: 2
    },
    {
      name: 'file lstat changes after reading',
      makeHooks(_root, path) {
        return {
          lstatStat(candidate, count, stat) {
            return candidate === path && count === 2
              ? {...stat, ino: stat.ino + 1n}
              : stat;
          }
        };
      },
      expectedTrace(root, path) {
        return [
          ...probeVerifierPrefix(root, path),
          `open:${path}`, `stat:${path}`, `stat:${path}`,
          `read:${path}:0:8`, `read:${path}:8:1`,
          `stat:${path}`, `lstat:${path}`, `close:${path}`
        ];
      },
      expectedHandleStats: 3,
      expectedReads: 2
    },
    {
      name: 'ancestor directory changes after reading',
      makeHooks(root) {
        const ancestor = join(root, 'captures');
        return {
          lstatStat(candidate, count, stat) {
            return candidate === ancestor && count === 2
              ? {...stat, ino: stat.ino + 1n}
              : stat;
          }
        };
      },
      expectedTrace(root, path) {
        return [
          ...probeVerifierPrefix(root, path),
          `open:${path}`, `stat:${path}`, `stat:${path}`,
          `read:${path}:0:8`, `read:${path}:8:1`,
          `stat:${path}`, `lstat:${path}`,
          `lstat:${root}`, `lstat:${join(root, 'captures')}`,
          `close:${path}`
        ];
      },
      expectedHandleStats: 3,
      expectedReads: 2
    },
    {
      name: 'root directory changes after reading',
      makeHooks(root) {
        return {
          lstatStat(candidate, count, stat) {
            return candidate === root && count === 2
              ? {...stat, ino: stat.ino + 1n}
              : stat;
          }
        };
      },
      expectedTrace(root, path) {
        return [
          ...probeVerifierPrefix(root, path),
          `open:${path}`, `stat:${path}`, `stat:${path}`,
          `read:${path}:0:8`, `read:${path}:8:1`,
          `stat:${path}`, `lstat:${path}`,
          `lstat:${root}`, `close:${path}`
        ];
      },
      expectedHandleStats: 3,
      expectedReads: 2
    }
  ];

  for (const item of cases) {
    const {captured, files} = makeProbeArtifactCapture();
    const root = captured.context.probe_artifacts.root;
    const path = join(root, 'captures/window.png');
    const {ports, calls} = makeProbeArtifactPorts(
      captured, files, item.makeHooks(root, path)
    );
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      verifyDesktopReadinessProbeArtifactsWithPorts(
        captured, undefined, ports
      )
    );
    assert.deepEqual(calls.trace, item.expectedTrace(root, path), item.name);
    assert.equal(calls.open.length, 1, item.name);
    assert.equal(calls.handleStat.length, item.expectedHandleStats, item.name);
    assert.deepEqual(
      calls.handleStat.map(call => call.args.length),
      Array(item.expectedHandleStats).fill(1),
      item.name
    );
    assert.equal(calls.read.length, item.expectedReads, item.name);
    assert.deepEqual(calls.close, [path], item.name);
  }
});

test('probe reads reject truncation, growth, oversized results and invalid read results', async () => {
  for (const mode of ['truncated', 'grown', 'oversized-result', 'invalid-result']) {
    const {captured, files} = makeProbeArtifactCapture();
    const root = captured.context.probe_artifacts.root;
    const path = join(root, 'captures/window.png');
    const expectedSize = captured.context.probe_artifacts.witness[
      'captures/window.png'
    ].byte_count;
    if (mode === 'truncated') files.set(path, encoder.encode('short'));
    if (mode === 'grown') {
      files.set(path, Uint8Array.from([...files.get(path), 65]));
    }

    const hooks = {};
    if (mode === 'truncated' || mode === 'grown') {
      // Keep both real-shaped stat reports at the captured size so the
      // verifier reaches the intended read or EOF mismatch.
      hooks.lstatStat = (candidate, _count, stat) =>
        candidate === path ? {...stat, size: BigInt(expectedSize)} : stat;
      hooks.handleStat = (candidate, _count, stat) =>
        candidate === path ? {...stat, size: BigInt(expectedSize)} : stat;
    }
    if (mode === 'oversized-result') {
      hooks.read = (record, defaultRead) => {
        defaultRead();
        return {bytesRead: record.length + 1};
      };
    }
    if (mode === 'invalid-result') {
      hooks.read = () => ({bytesRead: '8'});
    }

    const {ports, calls} = makeProbeArtifactPorts(captured, files, hooks);
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      verifyDesktopReadinessProbeArtifactsWithPorts(
        captured, undefined, ports
      )
    );
    assert.deepEqual(calls.open.map(call => call.path), [path], mode);
    assert.deepEqual(calls.close, [path], mode);
    assert.equal(calls.handleStat.length, 2, mode);
    if (mode === 'truncated') {
      assert.deepEqual(calls.read.map(({length, position}) => ({
        length, position
      })), [
        {length: 8, position: 0},
        {length: 3, position: 5}
      ]);
      assert.deepEqual(calls.trace, [
        ...probeVerifierPrefix(root, path),
        `open:${path}`, `stat:${path}`, `stat:${path}`,
        `read:${path}:0:8`, `read:${path}:5:3`, `close:${path}`
      ]);
    } else if (mode === 'grown') {
      assert.deepEqual(calls.read.map(({length, position}) => ({
        length, position
      })), [
        {length: 8, position: 0},
        {length: 1, position: 8}
      ]);
      assert.deepEqual(calls.trace, [
        ...probeVerifierPrefix(root, path),
        `open:${path}`, `stat:${path}`, `stat:${path}`,
        `read:${path}:0:8`, `read:${path}:8:1`, `close:${path}`
      ]);
    } else {
      assert.deepEqual(calls.read.map(({length, position}) => ({
        length, position
      })), [{length: 8, position: 0}], mode);
      assert.deepEqual(calls.trace, [
        ...probeVerifierPrefix(root, path),
        `open:${path}`, `stat:${path}`, `stat:${path}`,
        `read:${path}:0:8`, `close:${path}`
      ], mode);
    }
  }
});

test('probe aborts before start and during each verifier phase with exact traces and owned close', async () => {
  {
    const {captured, files} = makeProbeArtifactCapture();
    const {ports, calls} = makeProbeArtifactPorts(captured, files);
    const controller = new AbortController();
    controller.abort();
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      verifyDesktopReadinessProbeArtifactsWithPorts(
        captured, controller.signal, ports
      )
    );
    assert.deepEqual(calls.trace, []);
  }

  for (const mode of [
    'lstat', 'realpath', 'open', 'opened-stat', 'payload', 'eof', 'close'
  ]) {
    const {captured, files} = makeProbeArtifactCapture();
    const root = captured.context.probe_artifacts.root;
    const path = join(root, 'captures/window.png');
    const controller = new AbortController();
    const hooks = {};
    if (mode === 'lstat') {
      hooks.beforeLstat = () => controller.abort();
    } else if (mode === 'realpath') {
      hooks.beforeRealpath = () => controller.abort();
    } else if (mode === 'open') {
      hooks.open = async (_path, _args, handle) => {
        controller.abort();
        return handle;
      };
    } else if (mode === 'opened-stat') {
      hooks.handleStat = (_path, count, stat) => {
        if (count === 1) controller.abort();
        return stat;
      };
    } else if (mode === 'payload') {
      hooks.read = (record, defaultRead) => {
        const result = defaultRead();
        if (record.position === 0) controller.abort();
        return result;
      };
    } else if (mode === 'eof') {
      hooks.read = (record, defaultRead) => {
        const result = defaultRead();
        if (record.position === 8) controller.abort();
        return result;
      };
    } else {
      hooks.close = () => controller.abort();
    }

    const {ports, calls} = makeProbeArtifactPorts(captured, files, hooks);
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      verifyDesktopReadinessProbeArtifactsWithPorts(
        captured, controller.signal, ports
      )
    );

    let expectedTrace;
    if (mode === 'lstat') {
      expectedTrace = [`lstat:${root}`];
    } else if (mode === 'realpath') {
      expectedTrace = [`lstat:${root}`, `realpath:${root}`];
    } else if (mode === 'open') {
      expectedTrace = [
        ...probeVerifierPrefix(root, path),
        `open:${path}`, `close:${path}`
      ];
    } else if (mode === 'opened-stat') {
      expectedTrace = [
        ...probeVerifierPrefix(root, path),
        `open:${path}`, `stat:${path}`, `close:${path}`
      ];
    } else if (mode === 'payload') {
      expectedTrace = [
        ...probeVerifierPrefix(root, path),
        `open:${path}`, `stat:${path}`, `stat:${path}`,
        `read:${path}:0:8`, `close:${path}`
      ];
    } else if (mode === 'eof') {
      expectedTrace = [
        ...probeVerifierPrefix(root, path),
        `open:${path}`, `stat:${path}`, `stat:${path}`,
        `read:${path}:0:8`, `read:${path}:8:1`, `close:${path}`
      ];
    } else {
      expectedTrace = probeAdapterWrappedSuccessTrace(root, path, 8);
    }
    assert.deepEqual(calls.trace, expectedTrace, mode);
    assert.equal(calls.open.length,
      ['lstat', 'realpath'].includes(mode) ? 0 : 1, mode);
    assert.equal(calls.close.length,
      ['lstat', 'realpath'].includes(mode) ? 0 : 1, mode);
    const expectedRealpaths = mode === 'lstat'
      ? []
      : mode === 'realpath'
        ? [root]
        : [root, path];
    assert.deepEqual(calls.realpath.map(call => call.path),
      expectedRealpaths, mode);
  }
});

test('falsy lstat, open, stat, read and close failures block with phase-correct traces', async () => {
  for (const thrown of [null, undefined, false, 0, '']) {
    for (const mode of ['lstat', 'open', 'stat', 'read', 'close']) {
      const {captured, files} = makeProbeArtifactCapture();
      const root = captured.context.probe_artifacts.root;
      const path = join(root, 'captures/window.png');
      const hooks = {};
      if (mode === 'lstat') {
        hooks.beforeLstat = candidate => {
          if (candidate === path) throw thrown;
        };
      } else if (mode === 'open') {
        hooks.open = () => { throw thrown; };
      } else if (mode === 'stat') {
        hooks.handleStat = (_path, count) => {
          if (count === 1) throw thrown;
        };
      } else if (mode === 'read') {
        hooks.read = () => { throw thrown; };
      } else {
        hooks.close = () => { throw thrown; };
      }

      const {ports, calls} = makeProbeArtifactPorts(captured, files, hooks);
      await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
        verifyDesktopReadinessProbeArtifactsWithPorts(
          captured, undefined, ports
        )
      );

      let expectedTrace;
      if (mode === 'lstat') {
        expectedTrace = [
          `lstat:${root}`,
          `realpath:${root}`,
          `lstat:${join(root, 'captures')}`,
          `lstat:${path}`
        ];
      } else if (mode === 'open') {
        expectedTrace = [...probeVerifierPrefix(root, path), `open:${path}`];
      } else if (mode === 'stat') {
        expectedTrace = [
          ...probeVerifierPrefix(root, path),
          `open:${path}`, `stat:${path}`, `close:${path}`
        ];
      } else if (mode === 'read') {
        expectedTrace = [
          ...probeVerifierPrefix(root, path),
          `open:${path}`, `stat:${path}`, `stat:${path}`,
          `read:${path}:0:8`, `close:${path}`
        ];
      } else {
        expectedTrace = probeAdapterWrappedSuccessTrace(root, path, 8);
      }
      assert.deepEqual(calls.trace, expectedTrace, `${mode}:${String(thrown)}`);
      assert.equal(calls.open.length, mode === 'lstat' ? 0 : 1, mode);
      assert.equal(calls.close.length,
        ['stat', 'read', 'close'].includes(mode) ? 1 : 0, mode);
      assert.equal(calls.handleStat.length,
        ['stat'].includes(mode) ? 1 :
          ['read'].includes(mode) ? 2 :
            ['close'].includes(mode) ? 3 : 0,
        mode);
      const expectedRealpaths = mode === 'lstat'
        ? [root]
        : mode === 'open' || mode === 'stat' ||
            mode === 'read' || mode === 'close'
          ? [root, path]
          : [root, path];
      assert.deepEqual(calls.realpath.map(call => call.path),
        expectedRealpaths, mode);
    }
  }
});

test('probe primary failure, abort and falsy close failure remain latched with one close', async () => {
  const {captured, files} = makeProbeArtifactCapture();
  const root = captured.context.probe_artifacts.root;
  const path = join(root, 'captures/window.png');
  const controller = new AbortController();
  const {ports, calls} = makeProbeArtifactPorts(captured, files, {
    read() {
      calls.events.push('primary');
      throw null;
    },
    close() {
      calls.events.push('cleanup');
      controller.abort();
      throw false;
    }
  });

  await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
    verifyDesktopReadinessProbeArtifactsWithPorts(
      captured, controller.signal, ports
    )
  );
  assert.deepEqual(calls.events, ['primary', 'cleanup']);
  assert.deepEqual(calls.trace, [
    ...probeVerifierPrefix(root, path),
    `open:${path}`, `stat:${path}`, `stat:${path}`,
    `read:${path}:0:8`, `close:${path}`
  ]);
  assert.deepEqual(calls.realpath.map(call => call.path), [root, path]);
  assert.deepEqual(calls.open.map(call => call.path), [path]);
  assert.equal(calls.handleStat.length, 2);
  assert.equal(calls.read.length, 1);
  assert.deepEqual(calls.close, [path]);
});

test('probe consumes sixteen real EOF reads and capture enforces sixteen-file and four-MiB bounds', async () => {
  const contents = Object.fromEntries(
    Array.from({length: 16}, (_, index) => [
      index === 0 ? 'captures/window.png' : `captures/extra-${index}.bin`,
      Uint8Array.of(index)
    ])
  );
  const {captured, files} = makeProbeArtifactCapture(contents);
  const {ports, calls} = makeProbeArtifactPorts(captured, files);
  const result = await verifyDesktopReadinessProbeArtifactsWithPorts(
    captured, undefined, ports
  );
  assert.equal(result.artifact_content_verification, 'VERIFIED');
  assert.equal(calls.open.length, 16);
  assert.equal(calls.close.length, 16);
  assert.equal(calls.handleStat.length, 48);
  assert.equal(calls.read.length, 32);
  assert.equal(calls.read.filter(call =>
    call.length === 1 && call.position === 1
  ).length, 16);
  assert.equal(new Set(calls.open.map(call => call.path)).size, 16);
  assert.equal(calls.close.every(path => calls.open.some(
    opened => opened.path === path
  )), true);

  const atLimit = makeFixture();
  atLimit.context.probe_artifacts.witness = {
    'captures/window.png': {
      byte_count: 4_194_304,
      sha256: 'a'.repeat(64)
    }
  };
  const atLimitDigest = rawDomainHash(
    'squire.desktop-readiness.artifact-witness.v2',
    atLimit.context.probe_artifacts.witness
  );
  const atLimitInput = refreshFixtureEvidence(atLimit, {
    witnessDigest: atLimitDigest
  });
  assert.doesNotThrow(() => captureDesktopReadinessData(atLimitInput));

  for (const mode of ['too-many', 'over-total']) {
    const fixture = makeFixture();
    const entries = mode === 'too-many'
      ? Array.from({length: 17}, (_, index) => [
          index === 0 ? 'captures/window.png' : `captures/extra-${index}.bin`,
          {byte_count: 1, sha256: 'a'.repeat(64)}
        ])
      : Array.from({length: 5}, (_, index) => [
          index === 0 ? 'captures/window.png' : `captures/extra-${index}.bin`,
          {byte_count: 1_048_576, sha256: 'b'.repeat(64)}
        ]);
    fixture.context.probe_artifacts.witness = Object.fromEntries(entries);
    const witnessDigest = rawDomainHash(
      'squire.desktop-readiness.artifact-witness.v2',
      fixture.context.probe_artifacts.witness
    );
    const input = refreshFixtureEvidence(fixture, {witnessDigest});
    expectCode('INVALID_READINESS_CONTEXT', () =>
      captureDesktopReadinessData(input)
    );
  }
});

test('pure descriptor validation rejects an over-budget runtime aggregate before any preflight', () => {
  const descriptor = makeDescriptor();
  const perPin = 67_108_864;
  descriptor.executable.bytes = perPin;
  descriptor.typelibs[0].bytes = perPin;
  descriptor.libraries[0].bytes = perPin;
  for (let index = 1; index <= 3; index++) {
    descriptor.libraries.push({
      name: `gtk-extra-${index}`,
      path: `/synthetic/libgtk-extra-${index}.so`,
      bytes: perPin,
      sha256: String(index).repeat(64)
    });
  }
  assert.ok(descriptor.executable.bytes <= 67_108_864);
  assert.ok(descriptor.typelibs[0].bytes <= 67_108_864);
  assert.ok(descriptor.libraries.every(entry => entry.bytes <= 67_108_864));
  expectCode('INVALID_READINESS_CONTEXT', () =>
    validateDesktopReadinessRoute(makeRoute(descriptor))
  );
});

function makeReadinessEvidenceAcquisitionPorts(fixture, hooks = {}) {
  const files = new Map([
    [fixture.context.proof_pin.path, new Uint8Array(fixture.proofBytes)],
    [fixture.context.observer_terminal_pin.path, new Uint8Array(fixture.terminalBytes)],
    [fixture.context.fixture_definition_pin.path,
      new Uint8Array(fixture.fixtureDefinitionBytes)],
    [fixture.context.observer_definition_pin.path,
      new Uint8Array(fixture.observerDefinitionBytes)]
  ]);
  const calls = {
    readBytes: [],
    lstat: [],
    readChunks: [],
    iteratorFactory: [],
    next: [],
    returns: [],
    trace: []
  };
  const enoent = () => Object.assign(new Error('missing'), {code: 'ENOENT'});

  const defaultIterable = (path, contents) => {
    const transformed = hooks.streamBytes?.(path, contents, calls);
    const streamed = transformed === undefined ? contents : transformed;
    let offset = 0;
    let nextCount = 0;
    return {
      [Symbol.asyncIterator]() {
        calls.iteratorFactory.push(path);
        if (hooks.iteratorFactory) {
          return hooks.iteratorFactory(path, calls, streamed);
        }
        return {
          async next() {
            nextCount++;
            calls.next.push(path);
            calls.trace.push(`next:${path}:${nextCount}`);
            const defaultNext = () => {
              if (offset >= streamed.length) return {done: true};
              const size = hooks.chunkSize?.(path) ?? 65_536;
              const end = Math.min(streamed.length, offset + size);
              const value = streamed.subarray(offset, end);
              offset = end;
              return {done: false, value};
            };
            return hooks.next
              ? hooks.next(path, calls, nextCount, defaultNext)
              : defaultNext();
          },
          async return(value) {
            calls.returns.push(path);
            calls.trace.push(`return:${path}`);
            if (hooks.return) return hooks.return(path, calls, value);
            return {done: true, value};
          }
        };
      }
    };
  };

  const reads = {
    async lstat(path) {
      calls.lstat.push(path);
      calls.trace.push(`lstat:${path}`);
      if (hooks.lstat) {
        const result = await hooks.lstat(path, calls, files.get(path));
        if (result !== undefined) return result;
      }
      const contents = files.get(path);
      if (!contents) throw enoent();
      return {
        size: contents.length,
        isFile: () => true,
        isSymbolicLink: () => false
      };
    },
    readChunks(path) {
      calls.readChunks.push(path);
      calls.trace.push(`readChunks:${path}`);
      const contents = files.get(path);
      if (!contents) throw enoent();
      if (hooks.readChunks) {
        return hooks.readChunks(path, calls, contents, defaultIterable);
      }
      return defaultIterable(path, contents);
    }
  };
  const ports = {
    async readBytes(path, maxBytes) {
      calls.readBytes.push({path, maxBytes});
      calls.trace.push(`readBytes:${path}:${maxBytes}`);
      const contents = files.get(path);
      if (!contents) throw enoent();
      if (hooks.readBytes) {
        return hooks.readBytes(path, maxBytes, contents, calls);
      }
      return contents;
    },
    reads
  };
  return {files, calls, ports};
}

function refreshReadinessDefinitionBytes(fixture, name, value) {
  const bytes = new Uint8Array(value);
  fixture[name] = bytes;
  const pinName = name === 'fixtureDefinitionBytes'
    ? 'fixture_definition_pin'
    : 'observer_definition_pin';
  fixture.context[pinName].bytes = bytes.length;
  refreshFixtureEvidence(fixture, {definitionBindings: true});
  return fixture;
}

function deferredReadinessEvidence() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return {promise, resolve, reject};
}

test('file capture reads exactly four pins and returns the branded pure capture', async () => {
  const fixture = makeFixture();
  const inputJson = JSON.stringify(fixture.input);
  const inputHashes = Object.fromEntries(Object.entries(fixture.input).map(
    ([name, bytes]) => [name, hash(bytes)]
  ));
  const direct = captureDesktopReadinessData(fixture.input);
  const harness = makeReadinessEvidenceAcquisitionPorts(fixture);
  const captured = await captureDesktopReadinessFromFilesWithPorts(
    fixture.input.configBytes,
    fixture.input.readinessContextBytes,
    fixture.input.selectedRouteBytes,
    undefined,
    harness.ports
  );

  assert.deepEqual(captured, direct);
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(captured.validation_scope, 'PURE_DATA_ONLY');
  assert.equal(captured.native_app_status, 'NOT_QUALIFIED');
  assert.equal(assertDesktopReadinessCurrent(captured, 1200, 1199), captured);
  assert.deepEqual(harness.calls.readBytes.map(call => call.path), [
    captured.context.proof_pin.path,
    captured.context.observer_terminal_pin.path
  ]);
  assert.deepEqual(harness.calls.readBytes.map(call => call.maxBytes), [
    captured.context.proof_pin.bytes,
    captured.context.observer_terminal_pin.bytes
  ]);
  assert.equal(harness.calls.readBytes.every(call => call.maxBytes <= 65_536), true);
  assert.deepEqual(harness.calls.lstat, [
    captured.context.fixture_definition_pin.path,
    captured.context.observer_definition_pin.path
  ]);
  assert.deepEqual(harness.calls.readChunks, harness.calls.lstat);
  assert.deepEqual(harness.calls.iteratorFactory, harness.calls.lstat);
  assert.deepEqual(harness.calls.returns, []);

  for (const [name, document] of [
    ['config', fixture.input.configBytes],
    ['context', fixture.input.readinessContextBytes],
    ['selected_route', fixture.input.selectedRouteBytes],
    ['proof', fixture.proofBytes],
    ['observer_terminal', fixture.terminalBytes],
    ['fixture_definition', fixture.fixtureDefinitionBytes],
    ['observer_definition', fixture.observerDefinitionBytes]
  ]) {
    assert.deepEqual(copyCapturedDesktopReadinessBytes(captured, name), document);
  }
  assert.equal(JSON.stringify(fixture.input), inputJson);
  assert.deepEqual(Object.fromEntries(Object.entries(fixture.input).map(
    ([name, bytes]) => [name, hash(bytes)]
  )), inputHashes);
});

test('definitions above the receipt limit and at the exact one-MiB cap stream with real EOF', async () => {
  const fixture = refreshReadinessDefinitionBytes(
    makeFixture(), 'fixtureDefinitionBytes', new Uint8Array(70_000).fill(0x41)
  );
  refreshReadinessDefinitionBytes(
    fixture, 'observerDefinitionBytes',
    new Uint8Array(1_048_576).fill(0x42)
  );
  const harness = makeReadinessEvidenceAcquisitionPorts(fixture);
  const captured = await captureDesktopReadinessFromFilesWithPorts(
    fixture.input.configBytes, fixture.input.readinessContextBytes,
    fixture.input.selectedRouteBytes, undefined, harness.ports
  );

  assert.deepEqual(
    copyCapturedDesktopReadinessBytes(captured, 'fixture_definition'),
    fixture.fixtureDefinitionBytes
  );
  assert.deepEqual(
    copyCapturedDesktopReadinessBytes(captured, 'observer_definition'),
    fixture.observerDefinitionBytes
  );
  assert.deepEqual(harness.calls.readBytes.map(call => call.path), [
    captured.context.proof_pin.path,
    captured.context.observer_terminal_pin.path
  ]);
  assert.equal(harness.calls.readBytes.every(call => call.maxBytes <= 65_536), true);
  for (const [path, size] of [
    [captured.context.fixture_definition_pin.path, 70_000],
    [captured.context.observer_definition_pin.path, 1_048_576]
  ]) {
    assert.equal(
      harness.calls.next.filter(candidate => candidate === path).length,
      Math.ceil(size / 65_536) + 1
    );
    assert.equal(harness.calls.returns.includes(path), false);
  }
});

test('small evidence and streamed definitions reject each length or hash mismatch at its pin', async () => {
  for (const item of [
    {
      name: 'proof short',
      hooks(fixture) {
        return {readBytes(path, _max, contents) {
          return path === fixture.context.proof_pin.path
            ? contents.subarray(0, contents.length - 1)
            : contents;
        }};
      },
      expectedReads: 1
    },
    {
      name: 'proof wrong hash',
      hooks(fixture) {
        return {readBytes(path, _max, contents) {
          if (path !== fixture.context.proof_pin.path) return contents;
          const changed = new Uint8Array(contents);
          changed[0] ^= 1;
          return changed;
        }};
      },
      expectedReads: 1
    },
    {
      name: 'terminal short',
      hooks(fixture) {
        return {readBytes(path, _max, contents) {
          return path === fixture.context.observer_terminal_pin.path
            ? contents.subarray(0, contents.length - 1)
            : contents;
        }};
      },
      expectedReads: 2
    },
    {
      name: 'terminal wrong hash',
      hooks(fixture) {
        return {readBytes(path, _max, contents) {
          if (path !== fixture.context.observer_terminal_pin.path) return contents;
          const changed = new Uint8Array(contents);
          changed[0] ^= 1;
          return changed;
        }};
      },
      expectedReads: 2
    }
  ]) {
    const fixture = makeFixture();
    const harness = makeReadinessEvidenceAcquisitionPorts(
      fixture, item.hooks(fixture)
    );
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      captureDesktopReadinessFromFilesWithPorts(
        fixture.input.configBytes, fixture.input.readinessContextBytes,
        fixture.input.selectedRouteBytes, undefined, harness.ports
      )
    );
    assert.equal(harness.calls.readBytes.length, item.expectedReads, item.name);
    assert.deepEqual(harness.calls.readChunks, [], item.name);
  }

  for (const name of ['fixtureDefinitionBytes', 'observerDefinitionBytes']) {
    const fixture = makeFixture();
    const pin = name === 'fixtureDefinitionBytes'
      ? fixture.context.fixture_definition_pin
      : fixture.context.observer_definition_pin;
    const otherPath = name === 'fixtureDefinitionBytes'
      ? fixture.context.observer_definition_pin.path
      : fixture.context.fixture_definition_pin.path;
    for (const mode of ['short', 'wrong-hash']) {
      const hooks = {
        streamBytes(candidate, contents) {
          if (candidate !== pin.path) return contents;
          if (mode === 'short') {
            return contents.subarray(0, contents.length - 1);
          }
          const changed = new Uint8Array(contents);
          changed[0] ^= 1;
          return changed;
        }
      };
      const harness = makeReadinessEvidenceAcquisitionPorts(fixture, hooks);
      await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
        captureDesktopReadinessFromFilesWithPorts(
          fixture.input.configBytes, fixture.input.readinessContextBytes,
          fixture.input.selectedRouteBytes, undefined, harness.ports
        )
      );
      assert.deepEqual(harness.calls.readBytes.map(call => call.path), [
        fixture.context.proof_pin.path,
        fixture.context.observer_terminal_pin.path
      ], `${name}:${mode}`);
      assert.equal(harness.calls.readChunks.includes(pin.path), true);
      assert.equal(
        harness.calls.readChunks.includes(otherPath),
        name === 'observerDefinitionBytes',
        `${name}:${mode}`
      );
    }
  }

  for (const mode of [
    'short', 'extra-after-payload', 'oversized-first',
    'metadata-size', 'wrong-hash'
  ]) {
    const fixture = makeFixture();
    const path = fixture.context.fixture_definition_pin.path;
    const hooks = {};
    if (mode === 'short') {
      hooks.streamBytes = (candidate, contents) => candidate === path
        ? contents.subarray(0, contents.length - 1)
        : contents;
    } else if (mode === 'oversized-first') {
      hooks.streamBytes = (candidate, contents) => candidate === path
        ? Uint8Array.from([...contents, 0])
        : contents;
      hooks.chunkSize = candidate => candidate === path
        ? fixture.context.fixture_definition_pin.bytes + 1
        : 65_536;
    } else if (mode === 'extra-after-payload') {
      hooks.readChunks = (candidate, calls, contents, defaultIterable) => {
        if (candidate !== path) return defaultIterable(candidate, contents);
        let nextCount = 0;
        return {
          [Symbol.asyncIterator]() {
            calls.iteratorFactory.push(candidate);
            return {
              next() {
                nextCount++;
                calls.next.push(candidate);
                if (nextCount === 1) return {done: false, value: contents};
                if (nextCount === 2) return {done: false, value: Uint8Array.of(0)};
                return {done: true};
              },
              async return(value) {
                calls.returns.push(candidate);
                return {done: true, value};
              }
            };
          }
        };
      };
    } else if (mode === 'metadata-size') {
      hooks.lstat = candidate => candidate === path
        ? {
            size: fixture.context.fixture_definition_pin.bytes + 1,
            isFile: () => true,
            isSymbolicLink: () => false
          }
        : undefined;
    } else {
      hooks.streamBytes = (candidate, contents) => {
        if (candidate !== path) return contents;
        const changed = new Uint8Array(contents);
        changed[0] ^= 1;
        return changed;
      };
    }

    const harness = makeReadinessEvidenceAcquisitionPorts(fixture, hooks);
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      captureDesktopReadinessFromFilesWithPorts(
        fixture.input.configBytes, fixture.input.readinessContextBytes,
        fixture.input.selectedRouteBytes, undefined, harness.ports
      )
    );
    assert.deepEqual(harness.calls.readBytes.map(call => call.path), [
      fixture.context.proof_pin.path,
      fixture.context.observer_terminal_pin.path
    ], mode);
    if (mode === 'metadata-size') {
      assert.deepEqual(harness.calls.lstat, [path], mode);
      assert.deepEqual(harness.calls.readChunks, [], mode);
      assert.deepEqual(harness.calls.iteratorFactory, [], mode);
      assert.deepEqual(harness.calls.next, [], mode);
      assert.deepEqual(harness.calls.returns, [], mode);
    } else {
      assert.equal(harness.calls.readChunks[0], path, mode);
      assert.equal(
        harness.calls.readChunks.includes(
          fixture.context.observer_definition_pin.path
        ),
        false,
        mode
      );
    }
    if (mode === 'oversized-first') {
      assert.deepEqual(harness.calls.next, [path], mode);
      assert.deepEqual(harness.calls.returns, [path], mode);
    }
    if (mode === 'extra-after-payload') {
      assert.deepEqual(harness.calls.next, [path, path], mode);
      assert.deepEqual(harness.calls.returns, [path], mode);
    }
  }
});

test('definition readers accept data followed by valueless natural EOF and multi-chunk input', async () => {
  {
    const fixture = makeFixture();
    const harness = makeReadinessEvidenceAcquisitionPorts(fixture);
    await captureDesktopReadinessFromFilesWithPorts(
      fixture.input.configBytes, fixture.input.readinessContextBytes,
      fixture.input.selectedRouteBytes, undefined, harness.ports
    );
    for (const path of [
      fixture.context.fixture_definition_pin.path,
      fixture.context.observer_definition_pin.path
    ]) {
      assert.equal(
        harness.calls.next.filter(candidate => candidate === path).length,
        2
      );
      assert.equal(harness.calls.returns.includes(path), false);
    }
  }

  const fixture = refreshReadinessDefinitionBytes(
    makeFixture(), 'fixtureDefinitionBytes', new Uint8Array(150_000).fill(0x31)
  );
  const harness = makeReadinessEvidenceAcquisitionPorts(fixture, {
    chunkSize: path => path === fixture.context.fixture_definition_pin.path
      ? 32_768
      : 65_536
  });
  const captured = await captureDesktopReadinessFromFilesWithPorts(
    fixture.input.configBytes, fixture.input.readinessContextBytes,
    fixture.input.selectedRouteBytes, undefined, harness.ports
  );
  assert.deepEqual(
    copyCapturedDesktopReadinessBytes(captured, 'fixture_definition'),
    fixture.fixtureDefinitionBytes
  );
  assert.equal(
    harness.calls.next.filter(path =>
      path === fixture.context.fixture_definition_pin.path
    ).length,
    Math.ceil(150_000 / 32_768) + 1
  );
  assert.equal(
    harness.calls.returns.includes(fixture.context.fixture_definition_pin.path),
    false
  );
});

test('definition iterator setup failures clean owned work once and never invent pre-acquisition cleanup', async () => {
  for (const mode of [
    'factory-throws', 'next-accessor', 'missing-return', 'return-accessor'
  ]) {
    const fixture = makeFixture();
    const path = fixture.context.fixture_definition_pin.path;
    const harness = makeReadinessEvidenceAcquisitionPorts(fixture, {
      readChunks(candidate, calls, contents, defaultIterable) {
        if (candidate !== path) return defaultIterable(candidate, contents);
        if (mode === 'factory-throws') {
          return {
            [Symbol.asyncIterator]() {
              calls.iteratorFactory.push(candidate);
              throw new Error('private');
            }
          };
        }
        const iterator = {};
        Object.defineProperty(iterator, 'next', {
          get() { throw new Error('next accessor'); }
        });
        if (mode === 'next-accessor') {
          Object.defineProperty(iterator, 'return', {
            value: async value => {
              calls.returns.push(candidate);
              return {done: true, value};
            }
          });
        } else if (mode === 'return-accessor') {
          Object.defineProperty(iterator, 'return', {
            get() { throw new Error('return accessor'); }
          });
        }
        return {
          [Symbol.asyncIterator]() {
            calls.iteratorFactory.push(candidate);
            return iterator;
          }
        };
      }
    });
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      captureDesktopReadinessFromFilesWithPorts(
        fixture.input.configBytes, fixture.input.readinessContextBytes,
        fixture.input.selectedRouteBytes, undefined, harness.ports
      )
    );
    assert.equal(harness.calls.readChunks[0], path, mode);
    if (mode === 'next-accessor') {
      assert.deepEqual(harness.calls.returns, [path], mode);
    } else {
      assert.deepEqual(harness.calls.returns, [], mode);
    }
    assert.equal(harness.calls.readChunks.includes(
      fixture.context.observer_definition_pin.path
    ), false, mode);
  }
});

test('falsy reader, stat, iterator factory, next and cleanup failures remain blocking', async () => {
  const falsy = [null, undefined, false, 0, ''];
  for (const thrown of falsy) {
    {
      const fixture = makeFixture();
      const path = fixture.context.proof_pin.path;
      const harness = makeReadinessEvidenceAcquisitionPorts(fixture, {
        readBytes(candidate) {
          if (candidate === path) throw thrown;
          return undefined;
        }
      });
      await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
        captureDesktopReadinessFromFilesWithPorts(
          fixture.input.configBytes, fixture.input.readinessContextBytes,
          fixture.input.selectedRouteBytes, undefined, harness.ports
        )
      );
      assert.deepEqual(harness.calls.readBytes.map(call => call.path), [path]);
      assert.deepEqual(harness.calls.readChunks, []);
    }
    {
      const fixture = makeFixture();
      const path = fixture.context.fixture_definition_pin.path;
      const harness = makeReadinessEvidenceAcquisitionPorts(fixture, {
        lstat(candidate) {
          if (candidate === path) throw thrown;
          return undefined;
        }
      });
      await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
        captureDesktopReadinessFromFilesWithPorts(
          fixture.input.configBytes, fixture.input.readinessContextBytes,
          fixture.input.selectedRouteBytes, undefined, harness.ports
        )
      );
      assert.deepEqual(harness.calls.lstat, [path]);
      assert.deepEqual(harness.calls.iteratorFactory, []);
    }
    for (const mode of ['readChunks', 'iterator-factory']) {
      const fixture = makeFixture();
      const path = fixture.context.fixture_definition_pin.path;
      const harness = makeReadinessEvidenceAcquisitionPorts(fixture, {
        readChunks(candidate, calls, contents, defaultIterable) {
          if (candidate !== path) return defaultIterable(candidate, contents);
          if (mode === 'readChunks') throw thrown;
          return {
            [Symbol.asyncIterator]() {
              calls.iteratorFactory.push(candidate);
              throw thrown;
            }
          };
        }
      });
      await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
        captureDesktopReadinessFromFilesWithPorts(
          fixture.input.configBytes, fixture.input.readinessContextBytes,
          fixture.input.selectedRouteBytes, undefined, harness.ports
        )
      );
      assert.deepEqual(harness.calls.readChunks, [path], mode);
      assert.deepEqual(harness.calls.next, [], mode);
      assert.deepEqual(harness.calls.returns, [], mode);
    }
  }

  for (const [primary, cleanup] of [
    [null, new Error('cleanup')],
    [undefined, false],
    [false, new Error('cleanup')],
    [0, null],
    ['', undefined],
    ...falsy.map(value => [new Error('primary'), value])
  ]) {
    const fixture = makeFixture();
    const path = fixture.context.fixture_definition_pin.path;
    const harness = makeReadinessEvidenceAcquisitionPorts(fixture, {
      readChunks(candidate, calls, contents, defaultIterable) {
        if (candidate !== path) return defaultIterable(candidate, contents);
        return {
          [Symbol.asyncIterator]() {
            calls.iteratorFactory.push(candidate);
            return {
              async next() {
                calls.next.push(candidate);
                throw primary;
              },
              async return() {
                calls.returns.push(candidate);
                throw cleanup;
              }
            };
          }
        };
      }
    });
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      captureDesktopReadinessFromFilesWithPorts(
        fixture.input.configBytes, fixture.input.readinessContextBytes,
        fixture.input.selectedRouteBytes, undefined, harness.ports
      )
    );
    assert.deepEqual(harness.calls.next, [path]);
    assert.deepEqual(harness.calls.returns, [path]);
    assert.equal(harness.calls.readChunks.includes(
      fixture.context.observer_definition_pin.path
    ), false);
  }
});

test('abort waits for settled byte reads and closes streamed work without later IO', async () => {
  {
    const fixture = makeFixture();
    const controller = new AbortController();
    controller.abort();
    const harness = makeReadinessEvidenceAcquisitionPorts(fixture);
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      captureDesktopReadinessFromFilesWithPorts(
        fixture.input.configBytes, fixture.input.readinessContextBytes,
        fixture.input.selectedRouteBytes, controller.signal, harness.ports
      )
    );
    assert.deepEqual(harness.calls.trace, []);
  }

  for (const target of ['proof', 'terminal']) {
    const fixture = makeFixture();
    const controller = new AbortController();
    const path = target === 'proof'
      ? fixture.context.proof_pin.path
      : fixture.context.observer_terminal_pin.path;
    const harness = makeReadinessEvidenceAcquisitionPorts(fixture, {
      readBytes(candidate, _max, contents) {
        if (candidate === path) controller.abort();
        return contents;
      }
    });
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      captureDesktopReadinessFromFilesWithPorts(
        fixture.input.configBytes, fixture.input.readinessContextBytes,
        fixture.input.selectedRouteBytes, controller.signal, harness.ports
      )
    );
    assert.deepEqual(harness.calls.readBytes.map(call => call.path),
      target === 'proof' ? [path] : [
        fixture.context.proof_pin.path,
        fixture.context.observer_terminal_pin.path
      ]);
    assert.deepEqual(harness.calls.readChunks, []);
  }

  {
    const fixture = makeFixture();
    const controller = new AbortController();
    const started = deferredReadinessEvidence();
    const settled = deferredReadinessEvidence();
    const path = fixture.context.proof_pin.path;
    const harness = makeReadinessEvidenceAcquisitionPorts(fixture, {
      readBytes(candidate) {
        if (candidate !== path) return undefined;
        started.resolve();
        return settled.promise;
      }
    });
    const pending = captureDesktopReadinessFromFilesWithPorts(
      fixture.input.configBytes, fixture.input.readinessContextBytes,
      fixture.input.selectedRouteBytes, controller.signal, harness.ports
    );
    await started.promise;
    controller.abort();
    settled.resolve(harness.files.get(path));
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () => pending);
    assert.deepEqual(harness.calls.readBytes.map(call => call.path), [path]);
    assert.deepEqual(harness.calls.readChunks, []);
  }

  {
    const fixture = makeFixture();
    const controller = new AbortController();
    const path = fixture.context.fixture_definition_pin.path;
    const harness = makeReadinessEvidenceAcquisitionPorts(fixture, {
      readChunks(candidate, calls, contents, defaultIterable) {
        if (candidate !== path) return defaultIterable(candidate, contents);
        controller.abort();
        return defaultIterable(candidate, contents);
      }
    });
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      captureDesktopReadinessFromFilesWithPorts(
        fixture.input.configBytes, fixture.input.readinessContextBytes,
        fixture.input.selectedRouteBytes, controller.signal, harness.ports
      )
    );
    assert.deepEqual(harness.calls.iteratorFactory, []);
    assert.deepEqual(harness.calls.next, []);
    assert.deepEqual(harness.calls.returns, []);
  }

  {
    const fixture = makeFixture();
    const controller = new AbortController();
    const path = fixture.context.fixture_definition_pin.path;
    const started = deferredReadinessEvidence();
    const release = deferredReadinessEvidence();
    const harness = makeReadinessEvidenceAcquisitionPorts(fixture, {
      next(candidate, _calls, count, defaultNext) {
        if (candidate !== path || count !== 1) return defaultNext();
        const result = defaultNext();
        started.resolve();
        return release.promise.then(() => result);
      }
    });
    const pending = captureDesktopReadinessFromFilesWithPorts(
      fixture.input.configBytes, fixture.input.readinessContextBytes,
      fixture.input.selectedRouteBytes, controller.signal, harness.ports
    );
    await started.promise;
    controller.abort();
    release.resolve();
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () => pending);
    assert.deepEqual(harness.calls.next, [path]);
    assert.deepEqual(harness.calls.returns, [path]);
    assert.equal(harness.calls.readChunks.includes(
      fixture.context.observer_definition_pin.path
    ), false);
  }

  {
    const fixture = makeFixture();
    const controller = new AbortController();
    const path = fixture.context.fixture_definition_pin.path;
    const harness = makeReadinessEvidenceAcquisitionPorts(fixture, {
      next(candidate, _calls, count, defaultNext) {
        const result = defaultNext();
        if (candidate === path && count === 2) controller.abort();
        return result;
      }
    });
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      captureDesktopReadinessFromFilesWithPorts(
        fixture.input.configBytes, fixture.input.readinessContextBytes,
        fixture.input.selectedRouteBytes, controller.signal, harness.ports
      )
    );
    assert.deepEqual(harness.calls.next, [path, path]);
    assert.deepEqual(harness.calls.returns, [path]);
    assert.equal(harness.calls.readChunks.includes(
      fixture.context.observer_definition_pin.path
    ), false);
  }
});

test('caller buffers and borrowed read buffers cannot alter an in-progress private capture', async () => {
  const fixture = makeFixture();
  const saved = Object.fromEntries(Object.entries(fixture.input).map(
    ([name, bytes]) => [name, new Uint8Array(bytes)]
  ));
  const proofPath = fixture.context.proof_pin.path;
  const terminalPath = fixture.context.observer_terminal_pin.path;
  const fixtureDefinitionPath = fixture.context.fixture_definition_pin.path;
  const borrowedProof = new Uint8Array(fixture.proofBytes);
  const started = deferredReadinessEvidence();
  const release = deferredReadinessEvidence();
  let borrowedChunk = null;
  const harness = makeReadinessEvidenceAcquisitionPorts(fixture, {
    readBytes(path, _max, contents) {
      if (path === proofPath) {
        started.resolve();
        return release.promise;
      }
      if (path === terminalPath) borrowedProof.fill(0);
      return contents;
    },
    next(path, _calls, count, defaultNext) {
      const result = defaultNext();
      if (path === fixtureDefinitionPath && count === 1 && !result.done) {
        borrowedChunk = result.value;
      } else if (
        path === fixtureDefinitionPath && count === 2 && borrowedChunk
      ) {
        borrowedChunk.fill(0);
      }
      return result;
    }
  });
  const pending = captureDesktopReadinessFromFilesWithPorts(
    fixture.input.configBytes, fixture.input.readinessContextBytes,
    fixture.input.selectedRouteBytes, undefined, harness.ports
  );
  await started.promise;
  fixture.input.configBytes.fill(0);
  fixture.input.readinessContextBytes.fill(0);
  fixture.input.selectedRouteBytes.fill(0);
  release.resolve(borrowedProof);
  const captured = await pending;

  assert.deepEqual(
    copyCapturedDesktopReadinessBytes(captured, 'config'), saved.configBytes
  );
  assert.deepEqual(
    copyCapturedDesktopReadinessBytes(captured, 'context'),
    saved.readinessContextBytes
  );
  assert.deepEqual(
    copyCapturedDesktopReadinessBytes(captured, 'selected_route'),
    saved.selectedRouteBytes
  );
  assert.deepEqual(
    copyCapturedDesktopReadinessBytes(captured, 'proof'), saved.proofBytes
  );
  assert.deepEqual(
    copyCapturedDesktopReadinessBytes(captured, 'fixture_definition'),
    saved.fixtureDefinitionBytes
  );
  assert.deepEqual(harness.calls.readBytes.map(call => call.path), [
    proofPath, terminalPath
  ]);
});

test('malformed input and pre-readable binding or scope mismatches reject before evidence IO', async () => {
  for (const item of [
    {
      name: 'invalid config bytes',
      input(fixture) {
        return {...fixture.input, configBytes: encoder.encode('{broken')};
      },
      code: 'INVALID_READINESS_CONTEXT'
    },
    {
      name: 'unsafe context integer',
      input(fixture) {
        const context = structuredClone(fixture.context);
        context.requirements.max_age_ms = Number.MAX_SAFE_INTEGER + 1;
        return {
          ...fixture.input,
          readinessContextBytes: encoder.encode(JSON.stringify(context))
        };
      },
      code: 'INVALID_READINESS_CONTEXT'
    },
    {
      name: 'invalid selected route',
      input(fixture) {
        const route = structuredClone(fixture.route);
        route.environment.BROADWAY_DISPLAY = ':42';
        return {
          ...fixture.input,
          selectedRouteBytes: encoder.encode(JSON.stringify(route))
        };
      },
      code: 'INVALID_READINESS_CONTEXT'
    },
    {
      name: 'evidence path under generation scope',
      input() {
        return makeFixture({scope: '/synthetic/evidence'}).input;
      },
      code: 'READINESS_EVIDENCE_BLOCKED'
    },
    {
      name: 'config job does not match context',
      input(fixture) {
        const config = makeConfig({
          jobId: '10000000-0000-4000-8000-000000000002',
          scope: '/synthetic/task-b'
        });
        const configBytes = encoder.encode(JSON.stringify(config));
        const context = structuredClone(fixture.context);
        context.requirements.operation_config_sha256 = hash(configBytes);
        return {
          ...fixture.input,
          configBytes,
          readinessContextBytes: encoder.encode(JSON.stringify(context))
        };
      },
      code: 'READINESS_EVIDENCE_BLOCKED'
    },
    {
      name: 'selected route session does not match context',
      input(fixture) {
        const route = structuredClone(fixture.route);
        route.session.probe_run_id = 'probe-b';
        return {
          ...fixture.input,
          selectedRouteBytes: encoder.encode(JSON.stringify(route))
        };
      },
      code: 'READINESS_EVIDENCE_BLOCKED'
    },
    {
      name: 'selected route descriptor does not match config',
      input(fixture) {
        const route = structuredClone(fixture.route);
        route.runtime_identity.libraries[0].sha256 = 'd'.repeat(64);
        return {
          ...fixture.input,
          selectedRouteBytes: encoder.encode(JSON.stringify(route))
        };
      },
      code: 'READINESS_EVIDENCE_BLOCKED'
    }
  ]) {
    const fixture = makeFixture();
    const input = item.input(fixture);
    const harness = makeReadinessEvidenceAcquisitionPorts(fixture);
    await expectCodeAsync(item.code, () =>
      captureDesktopReadinessFromFilesWithPorts(
        input.configBytes, input.readinessContextBytes,
        input.selectedRouteBytes, undefined, harness.ports
      )
    );
    assert.deepEqual(harness.calls.trace, [], item.name);
  }
});

test('reader ports reject accessors, proxies, unknown keys and malformed abort signals before IO', async () => {
  const fixture = makeFixture();
  const baseline = makeReadinessEvidenceAcquisitionPorts(fixture);
  let touched = 0;
  const getterPorts = {
    readBytes: baseline.ports.readBytes,
    get reads() { touched++; return baseline.ports.reads; }
  };
  const getterReads = {
    lstat: baseline.ports.reads.lstat,
    get readChunks() {
      touched++;
      return baseline.ports.reads.readChunks;
    }
  };
  const proxyPorts = new Proxy(baseline.ports, {
    ownKeys() { touched++; throw new Error('private'); }
  });
  const proxyReads = new Proxy(baseline.ports.reads, {});
  const proxyFunction = new Proxy(baseline.ports.readBytes, {});
  const invalidPorts = [
    getterPorts,
    {...baseline.ports, extra: true},
    {readBytes: baseline.ports.readBytes, reads: getterReads},
    proxyPorts,
    {readBytes: baseline.ports.readBytes, reads: proxyReads},
    {readBytes: proxyFunction, reads: baseline.ports.reads}
  ];
  for (const ports of invalidPorts) {
    await expectCodeAsync('INVALID_READINESS_CONTEXT', () =>
      captureDesktopReadinessFromFilesWithPorts(
        fixture.input.configBytes, fixture.input.readinessContextBytes,
        fixture.input.selectedRouteBytes, undefined, ports
      )
    );
  }
  for (const signal of [
    Object.create(AbortSignal.prototype),
    new Proxy(new AbortController().signal, {})
  ]) {
    await expectCodeAsync('INVALID_READINESS_CONTEXT', () =>
      captureDesktopReadinessFromFilesWithPorts(
        fixture.input.configBytes, fixture.input.readinessContextBytes,
        fixture.input.selectedRouteBytes, signal, baseline.ports
      )
    );
  }
  assert.equal(touched, 0);
  assert.deepEqual(baseline.calls.trace, []);
});

test('Buffer definition chunks stream through intrinsic copies while proxy and non-byte chunks fail closed', async () => {
  const fixture = refreshReadinessDefinitionBytes(
    makeFixture(), 'fixtureDefinitionBytes',
    new Uint8Array(80_000).map((_, index) => index & 0xff)
  );
  const definitionPath = fixture.context.fixture_definition_pin.path;
  let streamedBuffer;
  const harness = makeReadinessEvidenceAcquisitionPorts(fixture, {
    streamBytes(path, contents) {
      if (path !== definitionPath) return undefined;
      streamedBuffer = Buffer.from(contents);
      return streamedBuffer;
    },
    chunkSize: () => 4096
  });
  const captured = await captureDesktopReadinessFromFilesWithPorts(
    fixture.input.configBytes, fixture.input.readinessContextBytes,
    fixture.input.selectedRouteBytes, undefined, harness.ports
  );
  assert.deepEqual(
    copyCapturedDesktopReadinessBytes(captured, 'fixture_definition'),
    fixture.fixtureDefinitionBytes
  );
  assert.deepEqual(streamedBuffer, Buffer.from(fixture.fixtureDefinitionBytes));
  assert.equal(
    harness.calls.next.filter(path => path === definitionPath).length,
    Math.ceil(80_000 / 4096) + 1
  );
  assert.equal(harness.calls.returns.includes(definitionPath), false);

  for (const kind of ['proxy', 'non-byte-view']) {
    const changed = makeFixture();
    const path = changed.context.fixture_definition_pin.path;
    let traps = 0;
    const badChunk = kind === 'proxy'
      ? new Proxy(Buffer.from(changed.fixtureDefinitionBytes), {
          getPrototypeOf() { traps++; throw new Error('private'); },
          get() { traps++; throw new Error('private'); },
          ownKeys() { traps++; throw new Error('private'); },
          getOwnPropertyDescriptor() { traps++; throw new Error('private'); }
        })
      : new Uint16Array([1, 2, 3]);
    const badHarness = makeReadinessEvidenceAcquisitionPorts(changed, {
      readChunks(candidate, calls, contents, defaultIterable) {
        if (candidate !== path) return defaultIterable(candidate, contents);
        let sent = false;
        return {
          [Symbol.asyncIterator]() {
            calls.iteratorFactory.push(candidate);
            return {
              async next() {
                calls.next.push(candidate);
                if (sent) return {done: true};
                sent = true;
                return {done: false, value: badChunk};
              },
              async return(value) {
                calls.returns.push(candidate);
                return {done: true, value};
              }
            };
          }
        };
      }
    });
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
      captureDesktopReadinessFromFilesWithPorts(
        changed.input.configBytes, changed.input.readinessContextBytes,
        changed.input.selectedRouteBytes, undefined, badHarness.ports
      )
    );
    assert.equal(traps, 0, kind);
    assert.deepEqual(badHarness.calls.next, [path], kind);
    assert.deepEqual(badHarness.calls.returns, [path], kind);
    assert.equal(badHarness.calls.readChunks.includes(
      changed.context.observer_definition_pin.path
    ), false);
  }
});

test('abort in the async iterator factory awaits its single owned cleanup before rejecting', async () => {
  for (const cleanupMode of ['resolve', 'reject-null', 'reject-false']) {
    const fixture = makeFixture();
    const controller = new AbortController();
    const path = fixture.context.fixture_definition_pin.path;
    const returnStarted = deferredReadinessEvidence();
    const returnGate = deferredReadinessEvidence();
    let settled = false;
    const harness = makeReadinessEvidenceAcquisitionPorts(fixture, {
      readChunks(candidate, calls, contents, defaultIterable) {
        if (candidate !== path) return defaultIterable(candidate, contents);
        return {
          [Symbol.asyncIterator]() {
            calls.iteratorFactory.push(candidate);
            controller.abort();
            return {
              next() {
                calls.next.push(candidate);
                return {done: false, value: contents};
              },
              return() {
                calls.returns.push(candidate);
                returnStarted.resolve();
                return returnGate.promise;
              }
            };
          }
        };
      }
    });
    const pending = captureDesktopReadinessFromFilesWithPorts(
      fixture.input.configBytes, fixture.input.readinessContextBytes,
      fixture.input.selectedRouteBytes, controller.signal, harness.ports
    );
    pending.then(() => { settled = true; }, () => { settled = true; });
    await returnStarted.promise;
    assert.equal(settled, false, cleanupMode);
    assert.deepEqual(harness.calls.next, []);
    assert.deepEqual(harness.calls.returns, [path]);
    assert.deepEqual(harness.calls.readBytes.map(call => call.path), [
      fixture.context.proof_pin.path,
      fixture.context.observer_terminal_pin.path
    ]);
    assert.equal(harness.calls.readChunks.includes(
      fixture.context.observer_definition_pin.path
    ), false);
    if (cleanupMode === 'resolve') {
      returnGate.resolve({done: true});
    } else {
      returnGate.reject(cleanupMode === 'reject-null' ? null : false);
    }
    await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () => pending);
    assert.equal(settled, true, cleanupMode);
    assert.deepEqual(harness.calls.returns, [path]);
    assert.deepEqual(harness.calls.next, []);
  }
});

test('abort after the final EOF guard but before public capture completion is rejected', async () => {
  const fixture = makeFixture();
  const controller = new AbortController();
  const path = fixture.context.observer_definition_pin.path;
  const harness = makeReadinessEvidenceAcquisitionPorts(fixture, {
    readChunks(candidate, calls, contents, defaultIterable) {
      if (candidate !== path) return defaultIterable(candidate, contents);
      let count = 0;
      return {
        [Symbol.asyncIterator]() {
          calls.iteratorFactory.push(candidate);
          return {
            next() {
              count++;
              calls.next.push(candidate);
              if (count === 1) {
                return Promise.resolve({done: false, value: contents});
              }
              return {
                then(resolve) {
                  resolve({done: true});
                  queueMicrotask(() => queueMicrotask(() => controller.abort()));
                }
              };
            },
            async return(value) {
              calls.returns.push(candidate);
              return {done: true, value};
            }
          };
        }
      };
    }
  });

  await expectCodeAsync('READINESS_EVIDENCE_BLOCKED', () =>
    captureDesktopReadinessFromFilesWithPorts(
      fixture.input.configBytes, fixture.input.readinessContextBytes,
      fixture.input.selectedRouteBytes, controller.signal, harness.ports
    )
  );
  assert.deepEqual(harness.calls.readBytes.map(call => call.path), [
    fixture.context.proof_pin.path,
    fixture.context.observer_terminal_pin.path
  ]);
  assert.deepEqual(harness.calls.readChunks, [
    fixture.context.fixture_definition_pin.path,
    path
  ]);
  assert.equal(harness.calls.next.filter(candidate => candidate === path).length, 2);
  assert.equal(harness.calls.returns.includes(path), false);
});
