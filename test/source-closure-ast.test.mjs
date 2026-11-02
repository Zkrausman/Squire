import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {
  DESKTOP_CODEGEN_SOURCE_FILES,PROJECT_SOURCE_ROOT
} from '../src/project-configuration.mjs';
import {
  COMPANION_SOURCE_PATHS,SOURCE_CLOSURE_LIMITS,analyzeModuleSource,
  assertEntrypointLoaderSites,buildSourceClosure,classifyModuleSpecifier,
  validateCompanionDeclarations
} from './helpers/source-closure-ast.mjs';

const sourceRoot=PROJECT_SOURCE_ROOT;
const entryPath=join(sourceRoot,'acceptance/project-entrypoint.mjs');
const preparePath=join(sourceRoot,'acceptance/prepare-project-task.mjs');
const failurePath=join(sourceRoot,'src/project-failure-diagnostics.mjs');
const phasePath=join(sourceRoot,'src/project-phase-diagnostics.mjs');
const companionPaths=COMPANION_SOURCE_PATHS.map(name=>join(sourceRoot,name));
const [readinessPath,artifactPath,verifierPath,jobRecordPath]=companionPaths;
const fixtureRoot='/synthetic/squire';
const fixtureEntry=join(fixtureRoot,'acceptance/project-entrypoint.mjs');
const fixturePrepare=join(fixtureRoot,'acceptance/prepare-project-task.mjs');
const fixtureFailure=join(fixtureRoot,'src/project-failure-diagnostics.mjs');
const fixturePhase=join(fixtureRoot,'src/project-phase-diagnostics.mjs');
const fixtureCompanions=COMPANION_SOURCE_PATHS.map(name=>join(fixtureRoot,name));
const [fixtureReadiness,fixtureArtifact,fixtureVerifier,fixtureJobRecord]=
  fixtureCompanions;

const expectedCompanionEdges=new Map([
  [readinessPath,new Set([
    'src/offline-run-summary.mjs','src/bounded-codegen-plan.mjs',
    'src/job-spec.mjs','src/artifact-verifier.mjs',
    'src/project-configuration.mjs','src/desktop-profile.mjs'
  ].map(name=>join(sourceRoot,name)))],
  [artifactPath,new Set([
    'src/offline-run-summary.mjs','src/job-spec.mjs',
    'src/bounded-codegen-plan.mjs','src/artifact-verifier.mjs',
    'src/project-configuration.mjs','src/multifile-staging.mjs',
    'src/desktop-readiness-evidence.mjs'
  ].map(name=>join(sourceRoot,name)))],
  [verifierPath,new Set([
    jobRecordPath,join(sourceRoot,'src/job-spec.mjs')
  ])],
  [jobRecordPath,new Set([join(sourceRoot,'src/job-spec.mjs')])]
]);

function arraysAt(root){
  const values=COMPANION_SOURCE_PATHS.map(name=>`'${name}'`).join(',');
  return [
    `const READINESS_COMPANION_PATHS=Object.freeze([${values}]);`,
    `const ARTIFACT_COMPANION_PATHS=Object.freeze([${values}]);`
  ].join('\n');
}

function syntheticEntry(){
  return `${arraysAt(fixtureRoot)}
async function loadProjectFailureDiagnostics(){return import('../src/project-failure-diagnostics.mjs');}
async function loadProjectPhaseDiagnostics(){return import('../src/project-phase-diagnostics.mjs');}
async function awaitArtifactBootstrap(operation,signal){return operation();}
export async function runProjectDesktopCodegenWithFailureDiagnosticsWithPorts(){
  const {createProjectFailureObserver,createProjectFailureBinding,createProjectFailureEvidence}=await loadProjectFailureDiagnostics();
}
export async function runProjectDesktopCodegenWithPhaseDiagnosticsWithPorts(){
  let module=null,observer=null;
  try{
    module=await loadProjectPhaseDiagnostics();
    observer=module.createProjectPhaseObserver(null,null);
  }catch{}
}
async function runLargeObservationDiagnostics(kind,configBytes,admission,abortSignal,ports){
  let module=null,observer=null;
  try{
    module=kind==='FAILURE'
      ?await loadProjectFailureDiagnostics()
      :await loadProjectPhaseDiagnostics();
    if(kind==='FAILURE')observer=module.createProjectFailureObserver();
    else observer=module.createProjectPhaseObserver(ports.clock,null);
  }catch{}
}
export async function runProjectDesktopCodingLargeObservationWithReadinessWithPorts(){
  try{
    const awaitPreflight=async operation=>{return operation();};
    const readinessModule=await awaitPreflight(()=>import('../src/desktop-readiness-evidence.mjs'));
  }catch{}
}
export async function verifyProjectArtifactChecksWithPorts(abortSignal){
  const module=await awaitArtifactBootstrap(()=>import('../src/project-artifact-check-evidence.mjs'),abortSignal);
}`;
}
function fixture(){
  const sources=new Map([
    [fixtureEntry,syntheticEntry()+`\nimport '../src/legacy.mjs';`],
    [fixturePrepare,`import '../src/legacy.mjs';`],
    [fixtureFailure,
      `import 'node:fs';\nexport async function load(){return import('./project-phase-diagnostics.mjs');}`],
    [fixturePhase,`import 'node:util';`],
    [fixtureReadiness,
      `import 'node:util';\nimport './artifact-verifier.mjs';`],
    [fixtureArtifact,`export * from './desktop-readiness-evidence.mjs';`],
    [fixtureVerifier,`import './job-record.mjs';`],
    [fixtureJobRecord,`import './job-spec.mjs';`],
    [join(fixtureRoot,'src/legacy.mjs'),`export const legacy=true;`],
    [join(fixtureRoot,'src/job-spec.mjs'),`export const spec=true;`]
  ]);
  const legacyInventory=new Set([
    fixtureEntry,fixturePrepare,fixtureFailure,fixturePhase,
    join(fixtureRoot,'src/legacy.mjs'),join(fixtureRoot,'src/job-spec.mjs')
  ]);
  const companions=new Set(fixtureCompanions);
  const companionEdges=new Map([
    [fixtureReadiness,new Set([fixtureVerifier])],
    [fixtureArtifact,new Set([fixtureReadiness])],
    [fixtureVerifier,new Set([fixtureJobRecord])],
    [fixtureJobRecord,new Set([join(fixtureRoot,'src/job-spec.mjs')])]
  ]);
  return {
    sources,legacyInventory,companions,companionEdges,
    options({
      overrides=new Map(),includeDynamic=true,limits,
      approvedBuiltinEdges
    }={}){
      return {
        entryPath:fixtureEntry,preparePath:fixturePrepare,
        sourceRoot:fixtureRoot,legacyInventory,companions,
        failurePath:fixtureFailure,phasePath:fixturePhase,
        companionEdges,readSource:async path=>{
          if(!sources.has(path))throw Error('PRIVATE_MISSING_SOURCE_SENTINEL');
          return sources.get(path);
        },
        overrides,includeDynamic,limits,approvedBuiltinEdges
      };
    }
  };
}

function assertCode(operation,code){
  assert.throws(operation,error=>
    error?.code===code&&error.message===code
  );
}

async function assertClosureCode(operation,code){
  await assert.rejects(operation(),error=>
    error?.code===code&&error.message===code
  );
}

function replaceBuiltinSnapshot(result){
  return new Map(result.approvedBuiltinEdges.map(item=>[
    item.path,item.edges
  ]));
}

function replaceUnique(source,needle,replacement){
  assert.equal(source.split(needle).length-1,1);
  return source.replace(needle,replacement);
}

test('the current entry source has the two exact arrays and four concrete AST bootstrap sites',async()=>{
  const source=await fs.readFile(entryPath,'utf8');
  const declarations=validateCompanionDeclarations(source);
  assert.deepEqual(declarations.map(item=>item.name),[
    'READINESS_COMPANION_PATHS','ARTIFACT_COMPANION_PATHS'
  ]);
  for(const declaration of declarations){
    assert.deepEqual(declaration.values,COMPANION_SOURCE_PATHS);
    assert.equal(declaration.offsetUnit,'utf16-code-units');
  }
  const sites=assertEntrypointLoaderSites(source,entryPath,sourceRoot);
  assert.deepEqual(sites.map(item=>item.site),[
    'failure','phase','readiness','artifact'
  ]);
  assert.deepEqual(sites.map(item=>item.specifier),[
    '../src/project-failure-diagnostics.mjs',
    '../src/project-phase-diagnostics.mjs',
    '../src/desktop-readiness-evidence.mjs',
    '../src/project-artifact-check-evidence.mjs'
  ]);
  assert.ok(sites.every(item=>item.kind==='dynamic'&&
    item.offsetUnit==='utf16-code-units'));
});

test('the full current eager and dynamic source closures preserve their separate inventories',async()=>{
  const legacyInventory=new Set(DESKTOP_CODEGEN_SOURCE_FILES.map(name=>
    join(sourceRoot,name)
  ));
  const companions=new Set(companionPaths);
  const base={
    entryPath,preparePath,sourceRoot,legacyInventory,companions,
    failurePath,phasePath,companionEdges:expectedCompanionEdges,
    readSource:path=>fs.readFile(path,'utf8')
  };
  const eager=await buildSourceClosure({...base,includeDynamic:false});
  const optional=await buildSourceClosure({...base,includeDynamic:true});
  assert.ok(eager.paths.includes(entryPath));
  assert.ok(eager.paths.includes(preparePath));
  assert.equal(eager.paths.includes(failurePath),false);
  assert.equal(eager.paths.includes(phasePath),false);
  for(const path of companions)assert.equal(eager.paths.includes(path),false);
  for(const path of optional.paths){
    assert.ok(legacyInventory.has(path)||companions.has(path));
  }
  for(const path of companions)assert.ok(optional.paths.includes(path));
  assert.ok(optional.edges.some(edge=>
    edge.from===failurePath&&edge.kind==='dynamic'&&edge.to===phasePath
  ));
  assert.equal(optional.offsetUnit,'utf16-code-units');
  assert.ok(optional.sourceBytes<=SOURCE_CLOSURE_LIMITS.aggregateBytes);
  assert.ok(optional.moduleCount<=SOURCE_CLOSURE_LIMITS.modules);
  assert.ok(optional.nodeCount<=SOURCE_CLOSURE_LIMITS.nodes);
});

test('phase diagnostics reject a companion edge already present in the optional closure',async()=>{
  const legacyInventory=new Set(DESKTOP_CODEGEN_SOURCE_FILES.map(name=>
    join(sourceRoot,name)
  ));
  const companions=new Set(companionPaths);
  const base={
    entryPath,preparePath,sourceRoot,legacyInventory,companions,
    failurePath,phasePath,companionEdges:expectedCompanionEdges,
    readSource:path=>fs.readFile(path,'utf8')
  };
  const baseline=await buildSourceClosure({...base,includeDynamic:true});
  assert.ok(baseline.paths.includes(readinessPath));
  const approvedBuiltinEdges=replaceBuiltinSnapshot(baseline);
  const phaseSource=await fs.readFile(phasePath,'utf8');
  const changedPhaseSource=
    `${phaseSource}\nimport './desktop-readiness-evidence.mjs';\n`;
  await assertClosureCode(()=>buildSourceClosure({
    ...base,includeDynamic:true,
    overrides:new Map([[phasePath,changedPhaseSource]]),
    approvedBuiltinEdges
  }),'CLOSURE_VIOLATION');
});

test('all static imports, re-exports and nested dynamic imports retain decoded sources and UTF-16 ranges',()=>{
  const source=`#!/usr/bin/env node
const lamp='💡';
import value from './caf\\u00e9.mjs';
export {value} from '../shared.mjs';
export * from 'node:util';
const load=()=>import('./nested.mjs');`;
  const result=analyzeModuleSource(source,{
    modulePath:fixtureEntry,sourceRoot:fixtureRoot
  });
  assert.deepEqual(result.imports.map(edge=>[
    edge.kind,edge.specifier,edge.resolution,edge.to
  ]),[
    ['static','./café.mjs','relative',join(fixtureRoot,'acceptance/café.mjs')],
    ['static','../shared.mjs','relative',join(fixtureRoot,'shared.mjs')],
    ['static','node:util','builtin',null],
    ['dynamic','./nested.mjs','relative',join(fixtureRoot,'acceptance/nested.mjs')]
  ]);
  const escaped=result.imports[0];
  assert.equal(escaped.sourceStart,source.indexOf("'./caf"));
  assert.equal(source.slice(escaped.sourceStart,escaped.sourceEnd),
    "'./caf\\u00e9.mjs'");
  assert.equal(result.sourceLength,source.length);
  assert.ok(result.sourceBytes>result.sourceLength);
  assert.equal(result.offsetUnit,'utf16-code-units');
});

test('regex, division, strings, comments and template text do not create imports while substitutions are traversed',()=>{
  const source=[
    `const text="import './string-decoy.mjs';";`,
    `const pattern=/import\\s*\\(/;`,
    `const quotient=({value:12}).value / 3;`,
    `const template=\`import './template-decoy.mjs'; \${import('./inside.mjs')}\`;`,
    `/* import './block-decoy.mjs'; */`,
    `// import './line-decoy.mjs';`
  ].join('\n');
  const result=analyzeModuleSource(source,{
    modulePath:fixtureEntry,sourceRoot:fixtureRoot
  });
  assert.deepEqual(result.imports.map(edge=>edge.specifier),['./inside.mjs']);
  assert.equal(result.imports[0].kind,'dynamic');
});

test('nonliteral dynamic sources, options, attributes and malformed grammar fail closed',()=>{
  for(const source of [
    `import(target);`,
    `import(\`./constant.mjs\`);`,
    `import('./module.mjs',{with:{type:'json'}});`,
    `import value from './module.mjs' with {type:'json'};`
  ]){
    assertCode(()=>analyzeModuleSource(source,{
      modulePath:fixtureEntry,sourceRoot:fixtureRoot
    }),'UNSUPPORTED_IMPORT_FORM');
  }
  for(const source of [
    `function broken( {`,
    `return 1;`,
    `const value=`,
    `'use strict'; with ({}) {}`
  ]){
    assertCode(()=>analyzeModuleSource(source,{
      modulePath:fixtureEntry,sourceRoot:fixtureRoot
    }),'INVALID_OR_UNSUPPORTED_SOURCE');
  }
});

test('specifier classification accepts exact builtins and root-contained relatives only',()=>{
  assert.deepEqual(
    classifyModuleSpecifier('node:fs/promises',fixtureEntry,fixtureRoot),
    {resolution:'builtin',to:null}
  );
  assert.deepEqual(
    classifyModuleSpecifier('path',fixtureEntry,fixtureRoot),
    {resolution:'builtin',to:null}
  );
  assert.deepEqual(
    classifyModuleSpecifier('../src/job-spec.mjs',fixtureEntry,fixtureRoot),
    {resolution:'relative',to:join(fixtureRoot,'src/job-spec.mjs')}
  );
  for(const value of [
    'squire/job-spec','/tmp/job-spec.mjs','file:///tmp/job-spec.mjs',
    'https://example.invalid/job-spec.mjs','#alias','@/job-spec.mjs',
    'node:unknown-squire-builtin','./outside.mjs?query','./outside.mjs#hash',
    '../..//outside.mjs'
  ]){
    assertCode(()=>classifyModuleSpecifier(value,fixtureEntry,fixtureRoot),
      'INVALID_SPECIFIER');
  }
});

test('binding extraction covers declarations, parameters, patterns, imports, methods and catch clauses',()=>{
  const source=`import {readFile as importedName} from 'node:fs';
const {key: READINESS_COMPANION_PATHS, [computed]: ARTIFACT_COMPANION_PATHS = fallback}=source;
function namedFunction({item: functionParameter}, ...restParameter) {
  const local=1;
}
const arrow=([arrowParameter]=[])=>arrowParameter;
const expression=function expressionName(defaultParameter=0) {
  return defaultParameter;
};
class DeclaredClass extends Base {
  constructor({field: constructorParameter}) {}
  method(methodParameter) {}
  get value() { const accessorLocal=1; return accessorLocal; }
  set value(setterParameter) {}
  static { const staticLocal=1; }
}
const expressionClass=class ClassExpressionName {};
try {} catch ({error: catchParameter}) {}`;
  const result=analyzeModuleSource(source,{
    modulePath:fixtureEntry,sourceRoot:fixtureRoot
  });
  const names=result.bindings.map(binding=>binding.name);
  for(const name of [
    'importedName','READINESS_COMPANION_PATHS','ARTIFACT_COMPANION_PATHS',
    'namedFunction','functionParameter','restParameter','local','arrow',
    'arrowParameter','expression','expressionName','defaultParameter',
    'DeclaredClass','constructorParameter','methodParameter','accessorLocal',
    'setterParameter','staticLocal','expressionClass','ClassExpressionName',
    'catchParameter'
  ]){
    assert.ok(names.includes(name),`missing binding ${name}`);
  }
  assert.equal(result.bindings.find(binding=>
    binding.name==='READINESS_COMPANION_PATHS'
  ).kind,'variable');
  assert.equal(result.bindings.find(binding=>
    binding.name==='catchParameter'
  ).kind,'catch');
});

test('Acorn Super nodes in the canonical source and class constructor and property syntax are traversed',async()=>{
  const canonicalPath=join(sourceRoot,'src/job-spec.mjs');
  const canonical=await fs.readFile(canonicalPath,'utf8');
  const canonicalAnalysis=analyzeModuleSource(canonical,{
    modulePath:canonicalPath,sourceRoot
  });
  assert.ok(canonicalAnalysis.nodeCount>0);
  assert.ok(canonicalAnalysis.bindings.some(binding=>
    binding.name==='ContractError'&&binding.kind==='class-name'
  ));
  assert.deepEqual(canonicalAnalysis.imports.map(edge=>edge.specifier),
    ['node:util']);

  const synthetic=`class Parent {}
class Child extends Parent {
  constructor(...args) { super(...args); }
  get value() { return super.value; }
  method(key) { return super[key]; }
}`;
  const syntheticAnalysis=analyzeModuleSource(synthetic,{
    modulePath:fixtureEntry,sourceRoot:fixtureRoot
  });
  assert.ok(syntheticAnalysis.bindings.some(binding=>
    binding.name==='Child'&&binding.kind==='class-name'
  ));
  assert.ok(syntheticAnalysis.bindings.some(binding=>
    binding.name==='args'&&binding.kind==='parameter'
  ));
  assert.ok(syntheticAnalysis.bindings.some(binding=>
    binding.name==='key'&&binding.kind==='parameter'
  ));
  assert.deepEqual(syntheticAnalysis.imports,[]);
});

test('property keys and default-expression references are not bindings but their nested AST is visited',()=>{
  const source=`function references(value=READINESS_COMPANION_PATHS) {
  const object={READINESS_COMPANION_PATHS, [ARTIFACT_COMPANION_PATHS]:1};
  const nested=\`division \${({value:8}).value / 2} \${import('./nested.mjs')}\`;
  return object;
}`;
  const result=analyzeModuleSource(source,{
    modulePath:fixtureEntry,sourceRoot:fixtureRoot
  });
  assert.deepEqual(result.bindings.map(binding=>binding.name),[
    'references','value','object','nested'
  ]);
  assert.deepEqual(result.imports.map(edge=>edge.specifier),['./nested.mjs']);
});

test('SC85-SC90 and v92 initializer, delimiter, arrow-shadow and division cases use AST bindings',()=>{
  const accepted=`${arraysAt(fixtureRoot)}
const delimiterIn=0 in {};
const delimiterOf=0;
for (const item of []) { void item; }
function defaults(value=READINESS_COMPANION_PATHS,...rest) {
  const references={key:ARTIFACT_COMPANION_PATHS};
  const pair=0,second=1;
  return references;
}
const quotient=({value:12}).value / 3;
const escaped=()=>import('../src/job-spec.mjs');`;
  assert.equal(validateCompanionDeclarations(accepted).length,2);
  const analysis=analyzeModuleSource(accepted,{
    modulePath:fixtureEntry,sourceRoot:fixtureRoot
  });
  assert.equal(analysis.bindings.filter(binding=>
    binding.name==='READINESS_COMPANION_PATHS'
  ).length,1);
  assert.ok(analysis.imports.some(edge=>
    edge.specifier==='../src/job-spec.mjs'&&edge.kind==='dynamic'
  ));
  const arrowShadow=`${arraysAt(fixtureRoot)}
const arrow=(READINESS_COMPANION_PATHS=()=>{})=>READINESS_COMPANION_PATHS;`;
  const shadowAnalysis=analyzeModuleSource(arrowShadow,{
    modulePath:fixtureEntry,sourceRoot:fixtureRoot
  });
  assert.ok(shadowAnalysis.bindings.some(binding=>
    binding.name==='READINESS_COMPANION_PATHS'&&binding.kind==='parameter'
  ));
  assertCode(()=>validateCompanionDeclarations(arrowShadow),
    'DECLARATION_MISMATCH');
});

test('protected arrays require one direct const Object.freeze declaration with exact ordered raw literals',()=>{
  const valid=arraysAt(fixtureRoot);
  assert.equal(validateCompanionDeclarations(valid).length,2);
  const missing=valid.replace(
    /const ARTIFACT_COMPANION_PATHS=.*;\n?/,''
  );
  const duplicate=valid+`\n${valid.split('\n')[0]}`;
  const reordered=valid.replace(
    `'src/desktop-readiness-evidence.mjs','src/project-artifact-check-evidence.mjs'`,
    `'src/project-artifact-check-evidence.mjs','src/desktop-readiness-evidence.mjs'`
  );
  const multi=valid.replace(
    'const READINESS_COMPANION_PATHS=',
    'const extra=0,READINESS_COMPANION_PATHS='
  );
  const spread=valid.replace(
    `'src/job-record.mjs'`,
    `...'src/job-record.mjs'`
  );
  const escaped=valid.replace(
    'desktop-readiness',
    String.raw`desktop\x2dreadiness`
  );
  for(const source of [missing,reordered,multi,spread,escaped]){
    assertCode(()=>validateCompanionDeclarations(source),
      'DECLARATION_MISMATCH');
  }
  assertCode(()=>validateCompanionDeclarations(duplicate),
    'INVALID_OR_UNSUPPORTED_SOURCE');
  assertCode(()=>validateCompanionDeclarations(
    `/* ${valid} */\nconst quoted=${JSON.stringify(valid)};`
  ),'DECLARATION_MISMATCH');
});

test('every protected name shadow form rejects, while object keys and initializer references remain positive',()=>{
  const base=arraysAt(fixtureRoot);
  const shadows=[
    `function f(READINESS_COMPANION_PATHS){}`,
    `const f=(...ARTIFACT_COMPANION_PATHS)=>0;`,
    `const f=({key:READINESS_COMPANION_PATHS}={})=>0;`,
    `function f({key:ARTIFACT_COMPANION_PATHS}={}){}`,
    `const value=class ARTIFACT_COMPANION_PATHS {};`,
    `try {} catch ({error:READINESS_COMPANION_PATHS}) {}`,
    `const holder={method(ARTIFACT_COMPANION_PATHS){}};`,
    `const holder={get value(){const READINESS_COMPANION_PATHS=1;}};`,
    `class Holder { constructor(ARTIFACT_COMPANION_PATHS) {} }`,
    `class Holder { static { const ARTIFACT_COMPANION_PATHS=1; } }`
  ];
  for(const shadow of shadows){
    assertCode(()=>validateCompanionDeclarations(`${base}\n${shadow}`),
      'DECLARATION_MISMATCH');
  }
  assertCode(()=>validateCompanionDeclarations(
    `${base}\nclass READINESS_COMPANION_PATHS {}`
  ),'INVALID_OR_UNSUPPORTED_SOURCE');
  assertCode(()=>validateCompanionDeclarations(
    `${base}\nimport {readFile as READINESS_COMPANION_PATHS} from 'node:fs';`
  ),'INVALID_OR_UNSUPPORTED_SOURCE');
  const references=`${base}
function refs(value=READINESS_COMPANION_PATHS) {
  return {READINESS_COMPANION_PATHS,
    [ARTIFACT_COMPANION_PATHS]:value};
}`;
  assert.equal(validateCompanionDeclarations(references).length,2);
});

test('entry loader checks reject moved, swapped, duplicated and wrong-target dynamic imports',()=>{
  const source=syntheticEntry();
  assert.equal(
    assertEntrypointLoaderSites(
      source,fixtureEntry,fixtureRoot
    ).length,4
  );
  const wrong=source.replace(
    `import('../src/project-artifact-check-evidence.mjs')`,
    `import('../src/desktop-readiness-evidence.mjs')`
  );
  const swapped=source
    .replace(
      `import('../src/desktop-readiness-evidence.mjs')`,
      `import('../src/swap-temporary.mjs')`
    )
    .replace(
      `import('../src/project-artifact-check-evidence.mjs')`,
      `import('../src/desktop-readiness-evidence.mjs')`
    )
    .replace(
      `import('../src/swap-temporary.mjs')`,
      `import('../src/project-artifact-check-evidence.mjs')`
    );
  const moved=source.replace(
    `${arraysAt(fixtureRoot)}`,
    `${arraysAt(fixtureRoot)}\nconst moved=import('../src/desktop-readiness-evidence.mjs');`
  );
  const decoy=source.replace(
    `${arraysAt(fixtureRoot)}`,
    `${arraysAt(fixtureRoot)}\nconst commentText="import('../src/desktop-readiness-evidence.mjs')";`
  );
  for(const changed of [wrong,swapped,moved]){
    assertCode(()=>assertEntrypointLoaderSites(
      changed,fixtureEntry,fixtureRoot
    ),'LOADER_MISMATCH');
  }
  assert.equal(assertEntrypointLoaderSites(
    decoy,fixtureEntry,fixtureRoot
  ).length,4);

  const directBinding=
    `const {createProjectFailureObserver,createProjectFailureBinding,createProjectFailureEvidence}=await loadProjectFailureDiagnostics();`;
  const badBindings=[
    `const {createProjectFailureObserver:observer,createProjectFailureBinding,createProjectFailureEvidence}=await loadProjectFailureDiagnostics();`,
    `const {[createProjectFailureObserver]:createProjectFailureObserver,createProjectFailureBinding,createProjectFailureEvidence}=await loadProjectFailureDiagnostics();`,
    `const {createProjectFailureObserver,createProjectFailureBinding,...rest}=await loadProjectFailureDiagnostics();`,
    `const {createProjectFailureObserver,createProjectFailureBinding}=await loadProjectFailureDiagnostics();`,
    `const {createProjectFailureObserver,createProjectFailureBinding:wrongBinding,createProjectFailureEvidence}=await loadProjectFailureDiagnostics();`
  ];
  for(const badBinding of badBindings){
    assertCode(()=>assertEntrypointLoaderSites(
      source.replace(directBinding,badBinding),fixtureEntry,fixtureRoot
    ),'LOADER_MISMATCH');
  }

  const extraCall=source.replace(
    directBinding,
    `${directBinding}\n  void loadProjectFailureDiagnostics();`
  );
  assertCode(()=>assertEntrypointLoaderSites(
    extraCall,fixtureEntry,fixtureRoot
  ),'LOADER_MISMATCH');

  const swappedBranches=source
    .replace(
      `?await loadProjectFailureDiagnostics()\n      :await loadProjectPhaseDiagnostics()`,
      `?await loadProjectPhaseDiagnostics()\n      :await loadProjectFailureDiagnostics()`
    );
  assertCode(()=>assertEntrypointLoaderSites(
    swappedBranches,fixtureEntry,fixtureRoot
  ),'LOADER_MISMATCH');

  const aliasedLoader=source.replace(
    directBinding,
    `const loaderAlias=loadProjectFailureDiagnostics;\n  ${directBinding}`
  );
  assertCode(()=>assertEntrypointLoaderSites(
    aliasedLoader,fixtureEntry,fixtureRoot
  ),'LOADER_MISMATCH');

  const shadowedLoader=source.replace(
    directBinding,
    `const loadProjectFailureDiagnostics=()=>null;\n  ${directBinding}`
  );
  assertCode(()=>assertEntrypointLoaderSites(
    shadowedLoader,fixtureEntry,fixtureRoot
  ),'LOADER_MISMATCH');
});

test('bootstrap calls resolve to their approved declarations and reject capturing shadows',async()=>{
  const source=await fs.readFile(entryPath,'utf8');
  assert.equal(assertEntrypointLoaderSites(source,entryPath,sourceRoot).length,4);

  const artifactSignature=`export async function verifyProjectArtifactChecksWithPorts(
  configBytes,artifactContextBytes,abortSignal,ports
){`;
  const parameterShadow=replaceUnique(
    source,artifactSignature,
    `export async function verifyProjectArtifactChecksWithPorts(
  configBytes,artifactContextBytes,abortSignal,ports,
  awaitArtifactBootstrap=operation=>operation()
){`
  );
  assertCode(()=>assertEntrypointLoaderSites(
    parameterShadow,entryPath,sourceRoot
  ),'LOADER_MISMATCH');

  const artifactCall=`    const module=await awaitArtifactBootstrap(
      ()=>import('../src/project-artifact-check-evidence.mjs'),
      abortSignal
    );`;
  const blockShadow=replaceUnique(
    source,
    artifactCall,
    `    const awaitArtifactBootstrap=operation=>operation();
${artifactCall}`
  );
  assertCode(()=>assertEntrypointLoaderSites(
    blockShadow,entryPath,sourceRoot
  ),'LOADER_MISMATCH');

  const functionShadow=replaceUnique(
    source,
    artifactCall,
    `    function awaitArtifactBootstrap(operation,signal){
      return operation();
    }
${artifactCall}`
  );
  assertCode(()=>assertEntrypointLoaderSites(
    functionShadow,entryPath,sourceRoot
  ),'LOADER_MISMATCH');

  const catchShadow=replaceUnique(
    source,
    artifactCall,
    `    try{throw null;}catch(awaitArtifactBootstrap){
${artifactCall}
    }`
  );
  assertCode(()=>assertEntrypointLoaderSites(
    catchShadow,entryPath,sourceRoot
  ),'LOADER_MISMATCH');

  const readinessSignature=`export async function runProjectDesktopCodingLargeObservationWithReadinessWithPorts(
  configBytes,admission,readinessContextBytes,selectedRouteBytes,abortSignal,ports
){`;
  const outerParameter=replaceUnique(
    source,
    readinessSignature,
    `export async function runProjectDesktopCodingLargeObservationWithReadinessWithPorts(
  configBytes,admission,readinessContextBytes,selectedRouteBytes,abortSignal,ports,
  awaitPreflight=operation=>operation()
){`
  );
  assert.equal(
    assertEntrypointLoaderSites(
      outerParameter,entryPath,sourceRoot
    ).length,
    4
  );

  const readinessDeclaration='const awaitPreflight=async operation=>{';
  const wrongDeclaration=replaceUnique(
    source,readinessDeclaration,
    'let awaitPreflight=async operation=>{'
  );
  assertCode(()=>assertEntrypointLoaderSites(
    wrongDeclaration,entryPath,sourceRoot
  ),'LOADER_MISMATCH');

  const readinessCall=`      const readinessModule=await awaitPreflight(
        ()=>import('../src/desktop-readiness-evidence.mjs')
      );`;
  const nestedBlockShadow=replaceUnique(
    source,
    readinessCall,
    `      {
        const awaitPreflight=async operation=>operation();
${readinessCall}
      }`
  );
  assertCode(()=>assertEntrypointLoaderSites(
    nestedBlockShadow,entryPath,sourceRoot
  ),'LOADER_MISMATCH');

  const catchPreflightShadow=replaceUnique(
    source,
    readinessCall,
    `      try{throw null;}catch(awaitPreflight){
${readinessCall}
      }`
  );
  assertCode(()=>assertEntrypointLoaderSites(
    catchPreflightShadow,entryPath,sourceRoot
  ),'LOADER_MISMATCH');
});

test('SC72-SC84 line terminators and same-line imports reach the eager-closure guard',async()=>{
  const base=fixture();
  const ordinary=await buildSourceClosure(base.options({includeDynamic:false}));
  for(const terminator of ['\n','\r','\u2028','\u2029']){
    const changed=`// line comment${terminator}import '../src/desktop-readiness-evidence.mjs';\n${syntheticEntry()}\nimport '../src/legacy.mjs';`;
    const overrides=new Map([[fixtureEntry,changed]]);
    await assertClosureCode(()=>buildSourceClosure(base.options({
      overrides,includeDynamic:false
    })),'CLOSURE_VIOLATION');
  }
  const sameLine=`const marker=0;import '../src/desktop-readiness-evidence.mjs';\n${syntheticEntry()}\nimport '../src/legacy.mjs';`;
  await assertClosureCode(()=>buildSourceClosure(base.options({
    overrides:new Map([[fixtureEntry,sameLine]]),includeDynamic:false
  })),'CLOSURE_VIOLATION');
  assert.ok(ordinary.paths.includes(fixtureEntry));
});

test('SC72-SC90 wrong package, self-package, unknown and extra legacy edges reject',async()=>{
  const base=fixture();
  await buildSourceClosure(base.options());
  for(const specifier of [
    'squire/artifact-verifier','/tmp/unpinned.mjs',
    'https://example.invalid/unpinned.mjs','node:unknown-squire-builtin'
  ]){
    const source=`import '${specifier}';\n`+base.sources.get(fixtureFailure);
    await assertClosureCode(()=>buildSourceClosure(base.options({
      overrides:new Map([[fixtureFailure,source]])
    })),'INVALID_SPECIFIER');
  }
  const legacy=join(fixtureRoot,'src/legacy.mjs');
  const extraDynamic=`${base.sources.get(legacy)}\nconst load=()=>import('./unlisted.mjs');`;
  await assertClosureCode(()=>buildSourceClosure(base.options({
    overrides:new Map([[legacy,extraDynamic]])
  })),'CLOSURE_VIOLATION');
  const eagerCompanion=`import '../src/desktop-readiness-evidence.mjs';\n`+
    base.sources.get(fixtureEntry);
  await assertClosureCode(()=>buildSourceClosure(base.options({
    overrides:new Map([[fixtureEntry,eagerCompanion]]),includeDynamic:false
  })),'CLOSURE_VIOLATION');
});

test('companion edges must match the directed DAG exactly and stay static',async()=>{
  const base=fixture();
  const baseline=await buildSourceClosure(base.options());
  const wrongDagSource=`import './job-spec.mjs';`;
  await assertClosureCode(()=>buildSourceClosure(base.options({
    overrides:new Map([[fixtureReadiness,wrongDagSource]])
  })),'CLOSURE_VIOLATION');
  const unknownSource=`import './unregistered-companion.mjs';`;
  await assertClosureCode(()=>buildSourceClosure(base.options({
    overrides:new Map([[fixtureReadiness,unknownSource]])
  })),'CLOSURE_VIOLATION');
  const dynamicSource=`import('./artifact-verifier.mjs');`;
  await assertClosureCode(()=>buildSourceClosure(base.options({
    overrides:new Map([[fixtureReadiness,dynamicSource]])
  })),'CLOSURE_VIOLATION');
  const cyclic=new Map(base.companionEdges);
  cyclic.set(fixtureVerifier,new Set([fixtureReadiness]));
  await assertClosureCode(()=>buildSourceClosure({
    ...base.options(),companionEdges:cyclic
  }),'CLOSURE_VIOLATION');
  assert.ok(baseline.paths.includes(fixtureReadiness));
});

test('SC90 dynamic builtins are tied to the exact source and import kind',async()=>{
  const base=fixture();
  const ordinary=await buildSourceClosure(base.options());
  const legacy=join(fixtureRoot,'src/legacy.mjs');
  const pinned=base.sources.get(legacy)+`\nimport('node:fs');`;
  const expected=replaceBuiltinSnapshot(ordinary);
  expected.set(legacy,[
    ...(expected.get(legacy)??[]),{kind:'dynamic',specifier:'node:fs'}
  ]);
  const accepted=await buildSourceClosure(base.options({
    overrides:new Map([[legacy,pinned]]),
    approvedBuiltinEdges:expected
  }));
  assert.ok(accepted.edges.some(edge=>
    edge.from===legacy&&edge.kind==='dynamic'&&edge.specifier==='node:fs'
  ));
  const wrongKind=new Map(expected);
  wrongKind.set(legacy,[
    ...wrongKind.get(legacy).filter(edge=>edge.specifier!=='node:fs'),
    {kind:'static',specifier:'node:fs'}
  ]);
  await assertClosureCode(()=>buildSourceClosure(base.options({
    overrides:new Map([[legacy,pinned]]),
    approvedBuiltinEdges:wrongKind
  })),'CLOSURE_VIOLATION');
  const wrongSource=new Map(expected);
  wrongSource.delete(legacy);
  wrongSource.set(join(fixtureRoot,'src/job-spec.mjs'),[
    {kind:'dynamic',specifier:'node:fs'}
  ]);
  await assertClosureCode(()=>buildSourceClosure(base.options({
    overrides:new Map([[legacy,pinned]]),
    approvedBuiltinEdges:wrongSource
  })),'CLOSURE_VIOLATION');
});

test('resource limits are fixed, lowerable for fixtures and fail without partial results',()=>{
  assert.deepEqual(SOURCE_CLOSURE_LIMITS,{
    sourceBytes:1048576,aggregateBytes:8388608,
    modules:64,nodes:500000,depth:512
  });
  for(const [source,limits] of [
    ['const value=1;',{sourceBytes:4}],
    ['const value=1;',{nodes:1}],
    ['function nested(){return 1;}',{depth:2}]
  ]){
    assertCode(()=>analyzeModuleSource(source,{
      modulePath:fixtureEntry,sourceRoot:fixtureRoot,limits
    }),'RESOURCE_LIMIT');
  }
  assertCode(()=>analyzeModuleSource('const value=1;',{
    modulePath:fixtureEntry,sourceRoot:fixtureRoot,
    limits:{sourceBytes:1048577}
  }),'INVALID_ARGUMENT');
  assertCode(()=>analyzeModuleSource('const value=1;',{
    modulePath:fixtureEntry,sourceRoot:fixtureRoot,
    limits:{nodes:SOURCE_CLOSURE_LIMITS.nodes+1}
  }),'INVALID_ARGUMENT');
  assertCode(()=>analyzeModuleSource('\uD800',{
    modulePath:fixtureEntry,sourceRoot:fixtureRoot
  }),'INVALID_SOURCE');
});

test('closure aggregate, module, node and depth overflows reject',async()=>{
  const base=fixture();
  await buildSourceClosure(base.options());
  for(const limits of [
    {aggregateBytes:1},{modules:1},{nodes:1},{depth:1}
  ]){
    await assertClosureCode(()=>buildSourceClosure(base.options({limits})),
      'RESOURCE_LIMIT');
  }
});

test('injected read failures are sanitized and overrides must belong to the traversed closure',async()=>{
  const base=fixture();
  await buildSourceClosure(base.options());
  const failed={...base.options(),readSource:async()=>{
    throw Error('PRIVATE_READ_FAILURE_SENTINEL');
  }};
  await assert.rejects(buildSourceClosure(failed),error=>
    error?.code==='SOURCE_UNAVAILABLE'&&
    error.message==='SOURCE_UNAVAILABLE'&&
    !error.message.includes('PRIVATE_READ_FAILURE_SENTINEL')
  );
  await assertClosureCode(()=>buildSourceClosure(base.options({
    overrides:new Map([[join(fixtureRoot,'src/not-in-closure.mjs'),'export {};']])
  })),'CLOSURE_VIOLATION');
});

test('attribute-free side-effect imports pass while empty and nonempty clauses reject',()=>{
  const accepted=analyzeModuleSource(
    `import 'node:util';`,
    {modulePath:fixtureEntry,sourceRoot:fixtureRoot}
  );
  assert.deepEqual(accepted.imports.map(edge=>[
    edge.kind,edge.specifier,edge.resolution
  ]),[['static','node:util','builtin']]);
  for(const source of [
    `import 'node:util' with {};`,
    `import 'node:util' with {type:"json"};`
  ]){
    assertCode(()=>analyzeModuleSource(source,{
      modulePath:fixtureEntry,sourceRoot:fixtureRoot
    }),'UNSUPPORTED_IMPORT_FORM');
  }
});

test('attribute-free named re-exports pass while empty and nonempty clauses reject',()=>{
  const accepted=analyzeModuleSource(
    `export {value} from 'node:util';`,
    {modulePath:fixtureEntry,sourceRoot:fixtureRoot}
  );
  assert.deepEqual(accepted.imports.map(edge=>[
    edge.kind,edge.specifier,edge.resolution
  ]),[['static','node:util','builtin']]);
  for(const source of [
    `export {value} from 'node:util' with {};`,
    `export {value} from 'node:util' with {type:"json"};`
  ]){
    assertCode(()=>analyzeModuleSource(source,{
      modulePath:fixtureEntry,sourceRoot:fixtureRoot
    }),'UNSUPPORTED_IMPORT_FORM');
  }
});

test('attribute-free export-all declarations pass while empty and nonempty clauses reject',()=>{
  const accepted=analyzeModuleSource(
    `export * from 'node:util';`,
    {modulePath:fixtureEntry,sourceRoot:fixtureRoot}
  );
  assert.deepEqual(accepted.imports.map(edge=>[
    edge.kind,edge.specifier,edge.resolution
  ]),[['static','node:util','builtin']]);
  for(const source of [
    `export * from 'node:util' with {};`,
    `export * from 'node:util' with {type:"json"};`
  ]){
    assertCode(()=>analyzeModuleSource(source,{
      modulePath:fixtureEntry,sourceRoot:fixtureRoot
    }),'UNSUPPORTED_IMPORT_FORM');
  }
});

test('attribute-clause evidence follows actual Acorn tokens across comments, ASI and neighboring declarations',()=>{
  const source=`const before='💡 with {}';
/* with {} */
import value from './caf\\u00e9.mjs' /* with {} */;
const withValue='with {}';
const object={with:'with'};
const member=object.with;`;
  const result=analyzeModuleSource(source,{
    modulePath:fixtureEntry,sourceRoot:fixtureRoot
  });
  assert.deepEqual(result.imports.map(edge=>[
    edge.kind,edge.specifier,edge.resolution,edge.to
  ]),[[
    'static','./café.mjs','relative',
    join(fixtureRoot,'acceptance/café.mjs')
  ]]);
  const edge=result.imports[0];
  assert.equal(edge.sourceStart,source.indexOf("'./caf"));
  assert.equal(source.slice(edge.sourceStart,edge.sourceEnd),
    "'./caf\\u00e9.mjs'");
  assert.equal(edge.offsetUnit,'utf16-code-units');

  for(const changed of [
    `import 'node:util' /* gap */ \n with /* gap */ {};`,
    `import 'node:util';\nimport 'node:path' with {};`,
    `import 'node:util'\nimport 'node:path' with {};`,
    `export * from 'node:util';\nexport {value} from 'node:path' with {};`
  ]){
    assertCode(()=>analyzeModuleSource(changed,{
      modulePath:fixtureEntry,sourceRoot:fixtureRoot
    }),'UNSUPPORTED_IMPORT_FORM');
  }

  const textDecoys=analyzeModuleSource([
    `const text="with {}";`,
    `// with {}`,
    `const withValue='with';`,
    `const object={with:'value'};`,
    `const member=object.with;`,
    `import 'node:util';`
  ].join('\n'),{
    modulePath:fixtureEntry,sourceRoot:fixtureRoot
  });
  assert.deepEqual(textDecoys.imports.map(edge=>edge.specifier),['node:util']);
});
