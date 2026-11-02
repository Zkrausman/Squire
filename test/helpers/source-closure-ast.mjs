import {parse} from 'acorn';
import {builtinModules} from 'node:module';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';

export const COMPANION_SOURCE_PATHS=Object.freeze([
  'src/desktop-readiness-evidence.mjs',
  'src/project-artifact-check-evidence.mjs',
  'src/artifact-verifier.mjs',
  'src/job-record.mjs'
]);

export const SOURCE_CLOSURE_LIMITS=Object.freeze({
  sourceBytes:1048576,
  aggregateBytes:8388608,
  modules:64,
  nodes:500000,
  depth:512
});

const protectedNames=Object.freeze([
  'READINESS_COMPANION_PATHS','ARTIFACT_COMPANION_PATHS'
]);
const knownNodeTypes=new Set([
  'Program','Identifier','PrivateIdentifier','Literal','ExpressionStatement',
  'BlockStatement','EmptyStatement','DebuggerStatement','WithStatement',
  'ReturnStatement','LabeledStatement','BreakStatement','ContinueStatement',
  'IfStatement','SwitchStatement','SwitchCase','ThrowStatement','TryStatement',
  'CatchClause','WhileStatement','DoWhileStatement','ForStatement',
  'ForInStatement','ForOfStatement','FunctionDeclaration','FunctionExpression',
  'VariableDeclaration','VariableDeclarator','ThisExpression','Super',
  'ArrayExpression','ObjectExpression','Property','UnaryExpression',
  'UpdateExpression','BinaryExpression','AssignmentExpression','LogicalExpression',
  'MemberExpression','ConditionalExpression','CallExpression','NewExpression',
  'SequenceExpression','SpreadElement','ArrowFunctionExpression',
  'YieldExpression','TemplateLiteral','TaggedTemplateExpression','TemplateElement',
  'ObjectPattern','ArrayPattern','RestElement','AssignmentPattern',
  'ClassDeclaration','ClassExpression','ClassBody','MethodDefinition',
  'MetaProperty','ImportDeclaration','ImportSpecifier',
  'ImportDefaultSpecifier','ImportNamespaceSpecifier','ImportAttribute',
  'ExportNamedDeclaration','ExportSpecifier','ExportDefaultDeclaration',
  'ExportAllDeclaration','AwaitExpression','ChainExpression','ImportExpression',
  'ParenthesizedExpression','PropertyDefinition','StaticBlock'
]);
const ignoredNodeFields=new Set(['loc','range']);
const builtinNames=new Set(builtinModules.map(name=>
  name.startsWith('node:')?name.slice(5):name
));
const encoder=new TextEncoder();
const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});

function reject(code){
  const error=new Error(code);
  error.code=code;
  throw error;
}

function validAbsolutePath(value){
  return typeof value==='string'&&value.length>0&&value.length<=4096&&
    isAbsolute(value)&&resolve(value)===value&&!value.includes('\0')&&
    !value.includes('\\');
}

function limitsFor(value){
  const limits={...SOURCE_CLOSURE_LIMITS};
  if(value===undefined)return limits;
  if(!value||typeof value!=='object'||Array.isArray(value))reject('INVALID_ARGUMENT');
  for(const key of Reflect.ownKeys(value)){
    if(typeof key!=='string'||!Object.hasOwn(SOURCE_CLOSURE_LIMITS,key)){
      reject('INVALID_ARGUMENT');
    }
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor||!Object.hasOwn(descriptor,'value')||
       !Number.isSafeInteger(descriptor.value)||descriptor.value<1||
       descriptor.value>SOURCE_CLOSURE_LIMITS[key]){
      reject('INVALID_ARGUMENT');
    }
    limits[key]=descriptor.value;
  }
  return limits;
}

function newBudget(limits){
  return {limits,sourceBytes:0,modules:0,nodes:0};
}

function sourceByteLength(source,limits){
  if(typeof source!=='string'||source.length>limits.sourceBytes){
    reject('RESOURCE_LIMIT');
  }
  const bytes=encoder.encode(source);
  if(bytes.length>limits.sourceBytes)reject('RESOURCE_LIMIT');
  try{
    if(decoder.decode(bytes)!==source)reject('INVALID_SOURCE');
  }catch{
    reject('INVALID_SOURCE');
  }
  return bytes.length;
}

function parseSource(source,budget){
  const bytes=sourceByteLength(source,budget.limits);
  if(bytes>budget.limits.aggregateBytes-budget.sourceBytes||
     budget.modules>=budget.limits.modules){
    reject('RESOURCE_LIMIT');
  }
  budget.sourceBytes+=bytes;
  budget.modules++;
  // Keep only actual Acorn keyword-token offsets. Their count is bounded by
  // this source's bytes, which sourceByteLength has already limited.
  const staticAttributeClauseStarts=[];
  try{
    return {
      ast:parse(source,{
        ecmaVersion:2025,sourceType:'module',allowHashBang:true,
        onToken(token){
          if(token.type.keyword==='with'){
            staticAttributeClauseStarts.push(token.start);
          }
        }
      }),
      bytes,staticAttributeClauseStarts
    };
  }catch{
    reject('INVALID_OR_UNSUPPORTED_SOURCE');
  }
}

function astChildren(node){
  if(!knownNodeTypes.has(node.type))reject('UNSUPPORTED_AST');
  const children=[];
  for(const key of Object.keys(node)){
    if(key==='type'||key==='start'||key==='end'||ignoredNodeFields.has(key)){
      continue;
    }
    if(node.type==='Literal'&&(key==='value'||key==='regex'))continue;
    if(node.type==='TemplateElement'&&key==='value')continue;
    const value=node[key];
    if(value===null||value===undefined||typeof value!=='object')continue;
    if(Array.isArray(value)){
      for(let index=0;index<value.length;index++){
        if(!Object.hasOwn(value,String(index)))reject('UNSUPPORTED_AST');
        const child=value[index];
        if(child===null)continue;
        if(!child||typeof child!=='object'||typeof child.type!=='string'){
          reject('UNSUPPORTED_AST');
        }
        children.push(child);
      }
      continue;
    }
    if(typeof value.type!=='string')reject('UNSUPPORTED_AST');
    children.push(value);
  }
  return children;
}

function identifier(node){
  return node?.type==='Identifier'&&typeof node.name==='string';
}

function bindingRecords(pattern,context,output,limits){
  const stack=[{node:pattern,depth:1}];
  while(stack.length){
    const {node,depth}=stack.pop();
    if(depth>limits.depth)reject('RESOURCE_LIMIT');
    if(!node||typeof node!=='object'||!knownNodeTypes.has(node.type)){
      reject('UNSUPPORTED_BINDING_PATTERN');
    }
    if(node.type==='Identifier'){
      output.push({
        name:node.name,kind:context.kind,start:node.start,end:node.end,
        declarationKind:context.declarationKind??null,
        directProgram:context.directProgram??false,
        declaration:context.declaration??null,
        declarator:context.declarator??null
      });
      continue;
    }
    if(node.type==='AssignmentPattern'){
      stack.push({node:node.left,depth:depth+1});
      continue;
    }
    if(node.type==='RestElement'){
      stack.push({node:node.argument,depth:depth+1});
      continue;
    }
    if(node.type==='ArrayPattern'){
      for(let index=node.elements.length-1;index>=0;index--){
        if(node.elements[index]){
          stack.push({node:node.elements[index],depth:depth+1});
        }
      }
      continue;
    }
    if(node.type==='ObjectPattern'){
      for(let index=node.properties.length-1;index>=0;index--){
        const property=node.properties[index];
        if(property.type==='RestElement'){
          stack.push({node:property.argument,depth:depth+1});
        }else if(property.type==='Property'&&property.kind==='init'&&
                 !property.method){
          // Only the value binds; computed and ordinary keys are references.
          stack.push({node:property.value,depth:depth+1});
        }else{
          reject('UNSUPPORTED_BINDING_PATTERN');
        }
      }
      continue;
    }
    reject('UNSUPPORTED_BINDING_PATTERN');
  }
}

function literalString(node){
  return node?.type==='Literal'&&typeof node.value==='string';
}

function hasStaticAttributeClause(node,staticAttributeClauseStarts){
  let low=0,high=staticAttributeClauseStarts.length;
  while(low<high){
    const middle=low+Math.floor((high-low)/2);
    if(staticAttributeClauseStarts[middle]<node.source.end){
      low=middle+1;
    }else{
      high=middle;
    }
  }
  return low<staticAttributeClauseStarts.length&&
    staticAttributeClauseStarts[low]<node.end;
}

function extractedImport(node,staticAttributeClauseStarts){
  if(node.type==='ImportDeclaration'){
    if(node.attributes?.length||
       hasStaticAttributeClause(node,staticAttributeClauseStarts)||
       !literalString(node.source)){
      reject('UNSUPPORTED_IMPORT_FORM');
    }
    return {
      kind:'static',specifier:node.source.value,nodeType:node.type,
      start:node.start,end:node.end,
      sourceStart:node.source.start,sourceEnd:node.source.end,node
    };
  }
  if(node.type==='ExportNamedDeclaration'&&node.source){
    if(node.attributes?.length||
       hasStaticAttributeClause(node,staticAttributeClauseStarts)||
       !literalString(node.source)){
      reject('UNSUPPORTED_IMPORT_FORM');
    }
    return {
      kind:'static',specifier:node.source.value,nodeType:node.type,
      start:node.start,end:node.end,
      sourceStart:node.source.start,sourceEnd:node.source.end,node
    };
  }
  if(node.type==='ExportAllDeclaration'){
    if(node.attributes?.length||
       hasStaticAttributeClause(node,staticAttributeClauseStarts)||
       !literalString(node.source)){
      reject('UNSUPPORTED_IMPORT_FORM');
    }
    return {
      kind:'static',specifier:node.source.value,nodeType:node.type,
      start:node.start,end:node.end,
      sourceStart:node.source.start,sourceEnd:node.source.end,node
    };
  }
  if(node.type==='ImportExpression'){
    if((node.options!==null&&node.options!==undefined)||
       !literalString(node.source)){
      reject('UNSUPPORTED_IMPORT_FORM');
    }
    return {
      kind:'dynamic',specifier:node.source.value,nodeType:node.type,
      start:node.start,end:node.end,
      sourceStart:node.source.start,sourceEnd:node.source.end,node
    };
  }
  return null;
}

function inspectAst(
  source,ast,budget,bytes,staticAttributeClauseStarts
){
  const nodes=[],edges=[],bindings=[],parents=new Map();
  const stack=[{node:ast,parent:null,depth:1}];
  while(stack.length){
    const frame=stack.pop(),node=frame.node;
    if(!knownNodeTypes.has(node.type))reject('UNSUPPORTED_AST');
    if(!Number.isSafeInteger(node.start)||!Number.isSafeInteger(node.end)||
       node.start<0||node.end<node.start||node.end>source.length){
      reject('UNSUPPORTED_AST');
    }
    if(frame.depth>budget.limits.depth)reject('RESOURCE_LIMIT');
    if(++budget.nodes>budget.limits.nodes)reject('RESOURCE_LIMIT');
    nodes.push(node);
    parents.set(node,frame.parent);
    const edge=extractedImport(node,staticAttributeClauseStarts);
    if(edge)edges.push(edge);

    if(node.type==='VariableDeclarator'){
      const declaration=frame.parent;
      const declarationParent=declaration&&parents.get(declaration);
      if(!declaration||declaration.type!=='VariableDeclaration'){
        reject('UNSUPPORTED_AST');
      }
      bindingRecords(node.id,{
        kind:'variable',declarationKind:declaration.kind,
        directProgram:declarationParent?.type==='Program',
        declaration,declarator:node
      },bindings,budget.limits);
    }else if(node.type==='FunctionDeclaration'||
             node.type==='FunctionExpression'){
      if(node.id)bindingRecords(node.id,{kind:'function-name'},bindings,budget.limits);
      for(const parameter of node.params){
        bindingRecords(parameter,{kind:'parameter'},bindings,budget.limits);
      }
    }else if(node.type==='ArrowFunctionExpression'){
      for(const parameter of node.params){
        bindingRecords(parameter,{kind:'parameter'},bindings,budget.limits);
      }
    }else if(node.type==='ClassDeclaration'||node.type==='ClassExpression'){
      if(node.id)bindingRecords(node.id,{kind:'class-name'},bindings,budget.limits);
    }else if(node.type==='ImportSpecifier'||
             node.type==='ImportDefaultSpecifier'||
             node.type==='ImportNamespaceSpecifier'){
      bindingRecords(node.local,{kind:'import'},bindings,budget.limits);
    }else if(node.type==='CatchClause'&&node.param){
      bindingRecords(node.param,{kind:'catch'},bindings,budget.limits);
    }

    const children=astChildren(node);
    for(let index=children.length-1;index>=0;index--){
      stack.push({
        node:children[index],parent:node,depth:frame.depth+1
      });
    }
  }
  return {
    ast,nodes,parents,edges,bindings,
    sourceBytes:bytes,sourceLength:source.length
  };
}

function internalAnalysis(source,budget){
  const parsed=parseSource(source,budget);
  return inspectAst(
    source,parsed.ast,budget,parsed.bytes,
    parsed.staticAttributeClauseStarts
  );
}

export function classifyModuleSpecifier(specifier,modulePath,sourceRoot){
  if(typeof specifier!=='string'||specifier.length===0||
     !validAbsolutePath(modulePath)||!validAbsolutePath(sourceRoot)){
    reject('INVALID_ARGUMENT');
  }
  if(specifier.startsWith('./')||specifier.startsWith('../')){
    if(specifier.includes('\\')||specifier.includes('\0')||
       /[\u0000-\u001f\u007f]/u.test(specifier)||
       specifier.includes('?')||specifier.includes('#')){
      reject('INVALID_SPECIFIER');
    }
    const target=resolve(dirname(modulePath),specifier);
    const pathFromRoot=relative(sourceRoot,target);
    if(pathFromRoot===''||pathFromRoot==='..'||
       pathFromRoot.startsWith(`..${sep}`)||isAbsolute(pathFromRoot)){
      reject('INVALID_SPECIFIER');
    }
    return Object.freeze({resolution:'relative',to:target});
  }
  const builtin=specifier.startsWith('node:')?specifier.slice(5):specifier;
  if(builtinNames.has(builtin)&&!specifier.includes('\\')&&
     !specifier.includes('\0')&&!/[\u0000-\u001f\u007f]/u.test(specifier)&&
     !specifier.includes('?')&&!specifier.includes('#')){
    return Object.freeze({resolution:'builtin',to:null});
  }
  reject('INVALID_SPECIFIER');
}

function publicEdge(edge,modulePath,sourceRoot){
  const classified=classifyModuleSpecifier(
    edge.specifier,modulePath,sourceRoot
  );
  return Object.freeze({
    kind:edge.kind,specifier:edge.specifier,nodeType:edge.nodeType,
    resolution:classified.resolution,to:classified.to,
    start:edge.start,end:edge.end,
    sourceStart:edge.sourceStart,sourceEnd:edge.sourceEnd,
    offsetUnit:'utf16-code-units'
  });
}

export function analyzeModuleSource(source,options){
  if(!options||typeof options!=='object'||Array.isArray(options)||
     Reflect.ownKeys(options).some(key=>
       !['limits','modulePath','sourceRoot'].includes(key)
     )){
    reject('INVALID_ARGUMENT');
  }
  if(!validAbsolutePath(options.modulePath)||
     !validAbsolutePath(options.sourceRoot)){
    reject('INVALID_ARGUMENT');
  }
  const budget=newBudget(limitsFor(options.limits));
  const analysis=internalAnalysis(source,budget);
  return Object.freeze({
    sourceBytes:analysis.sourceBytes,
    sourceLength:analysis.sourceLength,
    offsetUnit:'utf16-code-units',
    nodeCount:analysis.nodes.length,
    imports:Object.freeze(analysis.edges.map(edge=>
      publicEdge(edge,options.modulePath,options.sourceRoot)
    )),
    bindings:Object.freeze(analysis.bindings.map(binding=>Object.freeze({
      name:binding.name,kind:binding.kind,start:binding.start,end:binding.end,
      declarationKind:binding.declarationKind,
      directProgram:binding.directProgram,
      offsetUnit:'utf16-code-units'
    })))
  });
}

function parentOf(analysis,node){
  return analysis.parents.get(node)??null;
}

function isIdentifier(node,name){
  return identifier(node)&&(name===undefined||node.name===name);
}

function hasAncestor(analysis,node,ancestor){
  for(let current=parentOf(analysis,node);current;
      current=parentOf(analysis,current)){
    if(current===ancestor)return true;
  }
  return false;
}

function enclosingFunction(analysis,node){
  for(let current=parentOf(analysis,node);current;
      current=parentOf(analysis,current)){
    if(current.type==='FunctionDeclaration'||
       current.type==='FunctionExpression'||
       current.type==='ArrowFunctionExpression'){
      return current;
    }
  }
  return null;
}

function nodesOfType(analysis,type){
  return analysis.nodes.filter(node=>node.type===type);
}

function functionDeclaration(analysis,name){
  const matches=nodesOfType(analysis,'FunctionDeclaration').filter(node=>
    isIdentifier(node.id,name)
  );
  if(matches.length!==1)reject('LOADER_MISMATCH');
  return matches[0];
}

function exportedWrapper(analysis,name){
  const wrapper=functionDeclaration(analysis,name);
  if(parentOf(analysis,wrapper)?.type!=='ExportNamedDeclaration'||
     !wrapper.async){
    reject('LOADER_MISMATCH');
  }
  return wrapper;
}

function validateLoaderFunction(analysis,edge,name){
  const returned=parentOf(analysis,edge.node);
  const body=returned&&parentOf(analysis,returned);
  const owner=body&&parentOf(analysis,body);
  const loader=functionDeclaration(analysis,name);
  if(returned?.type!=='ReturnStatement'||returned.argument!==edge.node||
     body?.type!=='BlockStatement'||body.body.length!==1||
     owner!==loader||parentOf(analysis,loader)?.type!=='Program'||
     !loader.async||loader.params.length!==0){
    reject('LOADER_MISMATCH');
  }
  return loader;
}

function callExpressions(analysis,name){
  return nodesOfType(analysis,'CallExpression').filter(node=>
    isIdentifier(node.callee,name)
  );
}

function bindingsInside(analysis,name,owner){
  return analysis.bindings.filter(binding=>
    binding.name===name&&binding.start>=owner.start&&binding.end<=owner.end
  );
}

function validateModuleBinding(analysis,owner){
  const moduleBindings=bindingsInside(analysis,'module',owner);
  const observerBindings=bindingsInside(analysis,'observer',owner);
  if(moduleBindings.length!==1||observerBindings.length!==1){
    reject('LOADER_MISMATCH');
  }
  const binding=moduleBindings[0],declaration=binding.declaration;
  const declarator=binding.declarator;
  if(binding.kind!=='variable'||binding.declarationKind!=='let'||
     binding.directProgram||!declaration||!declarator||
     parentOf(analysis,declaration)!==owner.body||
     declaration.kind!=='let'||declaration.declarations.length!==2||
     declaration.declarations[0]!==declarator||
     !isIdentifier(declarator.id,'module')||
     declarator.init?.type!=='Literal'||declarator.init.value!==null){
    reject('LOADER_MISMATCH');
  }
  const observerDeclarator=declaration.declarations[1];
  if(!isIdentifier(observerDeclarator.id,'observer')||
     observerDeclarator.init?.type!=='Literal'||
     observerDeclarator.init.value!==null||
     observerBindings[0].declarator!==observerDeclarator||
     observerBindings[0].declaration!==declaration||
     observerBindings[0].declarationKind!=='let'){
    reject('LOADER_MISMATCH');
  }
  return binding;
}

function awaitedCall(analysis,call){
  const awaited=parentOf(analysis,call);
  if(awaited?.type!=='AwaitExpression'||awaited.argument!==call||
     call.optional||call.arguments.length!==0){
    reject('LOADER_MISMATCH');
  }
  return awaited;
}

function tryContainingDirectAssignment(analysis,assignment,owner){
  const statement=parentOf(analysis,assignment);
  const block=statement&&parentOf(analysis,statement);
  const attempt=block&&parentOf(analysis,block);
  if(statement?.type!=='ExpressionStatement'||
     statement.expression!==assignment||block?.type!=='BlockStatement'||
     block.body[0]!==statement||attempt?.type!=='TryStatement'||
     attempt.block!==block||parentOf(analysis,attempt)!==owner.body){
    reject('LOADER_MISMATCH');
  }
}

function validateFailureLegacyCall(analysis,call,owner){
  const awaited=awaitedCall(analysis,call);
  const declarator=parentOf(analysis,awaited);
  const declaration=declarator&&parentOf(analysis,declarator);
  const expected=[
    'createProjectFailureObserver',
    'createProjectFailureBinding',
    'createProjectFailureEvidence'
  ];
  const pattern=declarator?.id;
  if(enclosingFunction(analysis,call)!==owner||
     declarator?.type!=='VariableDeclarator'||declarator.init!==awaited||
     declaration?.type!=='VariableDeclaration'||declaration.kind!=='const'||
     declaration.declarations.length!==1||
     parentOf(analysis,declaration)!==owner.body||
     declaration.declarations[0]!==declarator||
     pattern?.type!=='ObjectPattern'||pattern.properties.length!==expected.length){
    reject('LOADER_MISMATCH');
  }
  const names=pattern.properties.map(property=>{
    if(property.type!=='Property'||property.computed||property.method||
       !property.shorthand||!isIdentifier(property.key)||
       !isIdentifier(property.value)){
      reject('LOADER_MISMATCH');
    }
    return property.value.name;
  });
  if(names.some((name,index)=>name!==expected[index])){
    reject('LOADER_MISMATCH');
  }
}

function validatePhaseLegacyCall(analysis,call,owner){
  const awaited=awaitedCall(analysis,call);
  const assignment=parentOf(analysis,awaited);
  if(enclosingFunction(analysis,call)!==owner||
     assignment?.type!=='AssignmentExpression'||assignment.operator!=='='||
     assignment.right!==awaited||!isIdentifier(assignment.left,'module')){
    reject('LOADER_MISMATCH');
  }
  validateModuleBinding(analysis,owner);
  tryContainingDirectAssignment(analysis,assignment,owner);
}

function validateSharedLoaderCall(analysis,call,owner,kind){
  const awaited=awaitedCall(analysis,call);
  const conditional=parentOf(analysis,awaited);
  const assignment=conditional&&parentOf(analysis,conditional);
  const condition=conditional?.test;
  const selected=kind==='failure'
    ?conditional?.consequent:conditional?.alternate;
  if(enclosingFunction(analysis,call)!==owner||
     conditional?.type!=='ConditionalExpression'||selected!==awaited||
     condition?.type!=='BinaryExpression'||condition.operator!=='==='||
     !isIdentifier(condition.left,'kind')||
     condition.right?.type!=='Literal'||
     condition.right.value!=='FAILURE'||
     assignment?.type!=='AssignmentExpression'||assignment.operator!=='='||
     assignment.right!==conditional||!isIdentifier(assignment.left,'module')){
    reject('LOADER_MISMATCH');
  }
  validateModuleBinding(analysis,owner);
  const kindBindings=bindingsInside(analysis,'kind',owner);
  const firstParameter=owner.params[0];
  if(kindBindings.length!==1||kindBindings[0].kind!=='parameter'||
     kindBindings[0].declarator!==null||owner.params.length!==5||
     !isIdentifier(firstParameter,'kind')||
     kindBindings[0].start!==firstParameter.start||
     kindBindings[0].end!==firstParameter.end){
    reject('LOADER_MISMATCH');
  }
  tryContainingDirectAssignment(analysis,assignment,owner);
}
function validateLoaderReferences(analysis,name,loader,calls){
  const allowed=new Set([loader.id,...calls.map(call=>call.callee)]);
  for(const node of nodesOfType(analysis,'Identifier')){
    if(node.name===name&&!allowed.has(node)){
      reject('LOADER_MISMATCH');
    }
  }
}

function validateLoaderCaller(analysis,loaderName,wrapperName,kind){
  const loader=functionDeclaration(analysis,loaderName);
  const wrapper=exportedWrapper(analysis,wrapperName);
  const shared=functionDeclaration(analysis,'runLargeObservationDiagnostics');
  const calls=callExpressions(analysis,loaderName);
  const loaderBindings=analysis.bindings.filter(item=>
    item.name===loaderName
  );
  if(parentOf(analysis,loader)?.type!=='Program'||
     !loader.async||loader.params.length!==0||
     loaderBindings.length!==1||loaderBindings[0].kind!=='function-name'||
     loaderBindings[0].start!==loader.id.start||
     parentOf(analysis,shared)?.type!=='Program'||!shared.async||
     calls.length!==2){
    reject('LOADER_MISMATCH');
  }
  const legacyCalls=calls.filter(call=>
    enclosingFunction(analysis,call)===wrapper
  );
  const sharedCalls=calls.filter(call=>
    enclosingFunction(analysis,call)===shared
  );
  if(legacyCalls.length!==1||sharedCalls.length!==1||
     legacyCalls.length+sharedCalls.length!==calls.length){
    reject('LOADER_MISMATCH');
  }
  if(kind==='failure'){
    validateFailureLegacyCall(analysis,legacyCalls[0],wrapper);
  }else{
    validatePhaseLegacyCall(analysis,legacyCalls[0],wrapper);
  }
  validateSharedLoaderCall(analysis,sharedCalls[0],shared,kind);
  validateLoaderReferences(analysis,loaderName,loader,calls);
}
function lexicalScopeNode(node){
  return node?.type==='Program'||node?.type==='BlockStatement'||
    node?.type==='CatchClause'||node?.type==='ForStatement'||
    node?.type==='ForInStatement'||node?.type==='ForOfStatement'||
    node?.type==='SwitchStatement'||node?.type==='StaticBlock'||
    node?.type==='ClassBody'||node?.type==='FunctionDeclaration'||
    node?.type==='FunctionExpression'||
    node?.type==='ArrowFunctionExpression'||
    node?.type==='ClassDeclaration'||node?.type==='ClassExpression';
}

function nearestLexicalScope(analysis,node,predicate=lexicalScopeNode){
  for(let current=node;current;current=parentOf(analysis,current)){
    if(predicate(current))return current;
  }
  return null;
}

function lexicalScopesAt(analysis,node){
  const scopes=[];
  for(let current=node;current;current=parentOf(analysis,current)){
    if(lexicalScopeNode(current))scopes.push(current);
  }
  return scopes;
}

function bindingIdentifier(analysis,binding){
  const matches=analysis.nodes.filter(node=>
    node.type==='Identifier'&&node.name===binding.name&&
    node.start===binding.start&&node.end===binding.end
  );
  if(matches.length!==1)reject('LOADER_MISMATCH');
  return matches[0];
}

function bindingScope(analysis,binding){
  const node=bindingIdentifier(analysis,binding);
  if(binding.kind==='parameter'){
    const scope=nearestLexicalScope(analysis,parentOf(analysis,node),current=>
      current.type==='FunctionDeclaration'||
      current.type==='FunctionExpression'||
      current.type==='ArrowFunctionExpression'
    );
    return scope;
  }
  if(binding.kind==='catch'){
    return nearestLexicalScope(analysis,parentOf(analysis,node),current=>
      current.type==='CatchClause'
    );
  }
  if(binding.kind==='import')return analysis.ast;
  if(binding.kind==='function-name'){
    const declaration=nearestLexicalScope(analysis,parentOf(analysis,node),current=>
      current.type==='FunctionDeclaration'||
      current.type==='FunctionExpression'
    );
    if(!declaration)return null;
    return declaration.type==='FunctionExpression'
      ?declaration
      :nearestLexicalScope(analysis,parentOf(analysis,declaration));
  }
  if(binding.kind==='class-name'){
    const declaration=nearestLexicalScope(analysis,parentOf(analysis,node),current=>
      current.type==='ClassDeclaration'||current.type==='ClassExpression'
    );
    if(!declaration)return null;
    return declaration.type==='ClassExpression'
      ?declaration
      :nearestLexicalScope(analysis,parentOf(analysis,declaration));
  }
  if(binding.kind==='variable'){
    const declaration=binding.declaration;
    if(!declaration||declaration.type!=='VariableDeclaration')return null;
    const parent=parentOf(analysis,declaration);
    if(binding.declarationKind==='var'){
      return nearestLexicalScope(analysis,parent,current=>
        current.type==='Program'||current.type==='FunctionDeclaration'||
        current.type==='FunctionExpression'||
        current.type==='ArrowFunctionExpression'||
        current.type==='StaticBlock'
      );
    }
    if(parent?.type==='ForStatement'&&parent.init===declaration||
       (parent?.type==='ForInStatement'||parent?.type==='ForOfStatement')&&
         parent.left===declaration){
      return parent;
    }
    return nearestLexicalScope(analysis,parent);
  }
  return null;
}

function lexicalBindingAt(analysis,name,reference){
  const bindings=analysis.bindings.filter(binding=>binding.name===name);
  for(const scope of lexicalScopesAt(analysis,reference)){
    const matches=bindings.filter(binding=>
      bindingScope(analysis,binding)===scope
    );
    if(matches.length>1)return null;
    if(matches.length===1)return matches[0];
  }
  return null;
}

function validateArtifactBootstrapBinding(analysis,call,wrapper){
  const declarations=nodesOfType(analysis,'FunctionDeclaration').filter(node=>
    isIdentifier(node.id,'awaitArtifactBootstrap')&&
    parentOf(analysis,node)?.type==='Program'
  );
  if(declarations.length!==1)reject('LOADER_MISMATCH');
  const declaration=declarations[0];
  const bindings=analysis.bindings.filter(binding=>
    binding.name==='awaitArtifactBootstrap'&&
    binding.kind==='function-name'&&
    binding.start===declaration.id.start&&
    binding.end===declaration.id.end
  );
  if(bindings.length!==1||!declaration.async||
     declaration.params.length!==2||
     !isIdentifier(declaration.params[0],'operation')||
     !isIdentifier(declaration.params[1],'signal')||
     parentOf(analysis,declaration)!==analysis.ast||
     bindingScope(analysis,bindings[0])!==analysis.ast||
     lexicalBindingAt(analysis,'awaitArtifactBootstrap',call)!==bindings[0]){
    reject('LOADER_MISMATCH');
  }
}

function readinessBootstrapBinding(analysis,binding,wrapper){
  if(binding.kind!=='variable'||binding.declarationKind!=='const'||
     binding.directProgram||!binding.declaration||!binding.declarator){
    return false;
  }
  const declaration=binding.declaration;
  const declarator=binding.declarator;
  const block=parentOf(analysis,declaration);
  const attempt=block&&parentOf(analysis,block);
  const arrow=declarator.init;
  return declaration.kind==='const'&&declaration.declarations.length===1&&
    declaration.declarations[0]===declarator&&
    isIdentifier(declarator.id,'awaitPreflight')&&
    block?.type==='BlockStatement'&&attempt?.type==='TryStatement'&&
    attempt.block===block&&enclosingFunction(analysis,declarator)===wrapper&&
    arrow?.type==='ArrowFunctionExpression'&&arrow.async&&
    arrow.params.length===1&&isIdentifier(arrow.params[0],'operation')&&
    arrow.body?.type==='BlockStatement'&&
    bindingScope(analysis,binding)===block;
}

function validateReadinessBootstrapBinding(analysis,call,wrapper){
  const candidates=analysis.bindings.filter(binding=>
    binding.name==='awaitPreflight'&&
    readinessBootstrapBinding(analysis,binding,wrapper)
  );
  if(candidates.length!==1||
     lexicalBindingAt(analysis,'awaitPreflight',call)!==candidates[0]){
    reject('LOADER_MISMATCH');
  }
}

function validateBootstrapImport(analysis,edge,site,wrapperName){
  const arrow=parentOf(analysis,edge.node);
  const call=arrow&&parentOf(analysis,arrow);
  const awaited=call&&parentOf(analysis,call);
  const declarator=awaited&&parentOf(analysis,awaited);
  const declaration=declarator&&parentOf(analysis,declarator);
  const wrapper=exportedWrapper(analysis,wrapperName);
  const expectedCallee=site==='readiness'
    ?'awaitPreflight':'awaitArtifactBootstrap';
  const expectedId=site==='readiness'?'readinessModule':'module';
  const expectedArguments=site==='readiness'?1:2;
  if(arrow?.type!=='ArrowFunctionExpression'||arrow.body!==edge.node||
     arrow.params.length!==0||arrow.async||
     call?.type!=='CallExpression'||call.arguments[0]!==arrow||
     !isIdentifier(call.callee,expectedCallee)||
     call.arguments.length!==expectedArguments||
     awaited?.type!=='AwaitExpression'||awaited.argument!==call||
     declarator?.type!=='VariableDeclarator'||declarator.init!==awaited||
     !isIdentifier(declarator.id,expectedId)||
     declaration?.type!=='VariableDeclaration'||declaration.kind!=='const'||
     declaration.declarations.length!==1||
     enclosingFunction(analysis,call)!==wrapper){
    reject('LOADER_MISMATCH');
  }
  if(site==='artifact'&&!isIdentifier(call.arguments[1],'abortSignal')){
    reject('LOADER_MISMATCH');
  }
  if(site==='artifact'){
    validateArtifactBootstrapBinding(analysis,call,wrapper);
  }else if(site==='readiness'){
    validateReadinessBootstrapBinding(analysis,call,wrapper);
  }else{
    reject('LOADER_MISMATCH');
  }
}

function validateCompanionDeclarationsFromAnalysis(analysis){
  const declarations=[];
  for(const name of protectedNames){
    const bindings=analysis.bindings.filter(item=>item.name===name);
    if(bindings.length!==1)reject('DECLARATION_MISMATCH');
    const binding=bindings[0],declaration=binding.declaration;
    const declarator=binding.declarator;
    if(binding.kind!=='variable'||binding.declarationKind!=='const'||
       !binding.directProgram||!declaration||!declarator||
       declaration.declarations.length!==1||
       declaration.declarations[0]!==declarator||
       !isIdentifier(declarator.id,name)||
       parentOf(analysis,declaration)?.type!=='Program'||
       declarator.init?.type!=='CallExpression'){
      reject('DECLARATION_MISMATCH');
    }
    const init=declarator.init,callee=init.callee;
    if(init.optional||init.arguments.length!==1||
       callee?.type!=='MemberExpression'||callee.computed||callee.optional||
       !isIdentifier(callee.object,'Object')||
       !isIdentifier(callee.property,'freeze')){
      reject('DECLARATION_MISMATCH');
    }
    const array=init.arguments[0];
    if(array?.type!=='ArrayExpression'||
       array.elements.length!==COMPANION_SOURCE_PATHS.length||
       array.elements.some(element=>
         !element||element.type!=='Literal'||typeof element.value!=='string'
       )){
      reject('DECLARATION_MISMATCH');
    }
    const values=array.elements.map(element=>element.value);
    if(values.some((value,index)=>
      value!==COMPANION_SOURCE_PATHS[index]||
      array.elements[index].raw!==`'${COMPANION_SOURCE_PATHS[index]}'`
    )){
      reject('DECLARATION_MISMATCH');
    }
    declarations.push(Object.freeze({
      name,values:Object.freeze(values),
      declarationStart:declaration.start,declarationEnd:declaration.end,
      initializerStart:init.start,initializerEnd:init.end,
      arrayStart:array.start,arrayEnd:array.end,
      offsetUnit:'utf16-code-units'
    }));
  }
  return Object.freeze(declarations);
}

export function validateCompanionDeclarations(source,options={}){
  if(!options||typeof options!=='object'||Array.isArray(options)||
     Reflect.ownKeys(options).some(key=>key!=='limits')){
    reject('INVALID_ARGUMENT');
  }
  const analysis=internalAnalysis(source,newBudget(limitsFor(options.limits)));
  return validateCompanionDeclarationsFromAnalysis(analysis);
}

function assertEntrypointLoaderSitesFromAnalysis(
  analysis,entryPath,sourceRoot
){
  if(entryPath!==resolve(sourceRoot,'acceptance/project-entrypoint.mjs')){
    reject('LOADER_MISMATCH');
  }
  validateCompanionDeclarationsFromAnalysis(analysis);
  const expected=[
    {
      site:'failure',specifier:'../src/project-failure-diagnostics.mjs',
      target:resolve(sourceRoot,'src/project-failure-diagnostics.mjs')
    },
    {
      site:'phase',specifier:'../src/project-phase-diagnostics.mjs',
      target:resolve(sourceRoot,'src/project-phase-diagnostics.mjs')
    },
    {
      site:'readiness',specifier:'../src/desktop-readiness-evidence.mjs',
      target:resolve(sourceRoot,'src/desktop-readiness-evidence.mjs')
    },
    {
      site:'artifact',specifier:'../src/project-artifact-check-evidence.mjs',
      target:resolve(sourceRoot,'src/project-artifact-check-evidence.mjs')
    }
  ];
  if(analysis.edges.filter(edge=>edge.kind==='dynamic').length!==expected.length){
    reject('LOADER_MISMATCH');
  }
  const result=[];
  const seenSites=new Set();
  for(const edge of analysis.edges.filter(item=>item.kind==='dynamic')){
    const owner=enclosingFunction(analysis,edge.node);
    let site;
    if(isIdentifier(owner?.id,'loadProjectFailureDiagnostics')){
      validateLoaderFunction(analysis,edge,'loadProjectFailureDiagnostics');
      site='failure';
    }else if(isIdentifier(owner?.id,'loadProjectPhaseDiagnostics')){
      validateLoaderFunction(analysis,edge,'loadProjectPhaseDiagnostics');
      site='phase';
    }else{
      const readinessArrow=parentOf(analysis,edge.node);
      const readinessCall=readinessArrow&&parentOf(analysis,readinessArrow);
      const readinessCaller=readinessCall?.type==='CallExpression'&&
        isIdentifier(readinessCall.callee,'awaitPreflight');
      const artifactCaller=readinessCall?.type==='CallExpression'&&
        isIdentifier(readinessCall.callee,'awaitArtifactBootstrap');
      if(readinessCaller){
        site='readiness';
        validateBootstrapImport(
          analysis,edge,site,
          'runProjectDesktopCodingLargeObservationWithReadinessWithPorts'
        );
      }else if(artifactCaller){
        site='artifact';
        validateBootstrapImport(
          analysis,edge,site,'verifyProjectArtifactChecksWithPorts'
        );
      }else{
        reject('LOADER_MISMATCH');
      }
    }
    const specification=expected.find(item=>item.site===site);
    if(!specification||seenSites.has(site)||
       edge.specifier!==specification.specifier){
      reject('LOADER_MISMATCH');
    }
    const classified=classifyModuleSpecifier(
      edge.specifier,entryPath,sourceRoot
    );
    if(classified.resolution!=='relative'||
       classified.to!==specification.target){
      reject('LOADER_MISMATCH');
    }
    seenSites.add(site);
    result.push({
      site,kind:'dynamic',specifier:edge.specifier,to:classified.to,
      start:edge.start,end:edge.end,
      sourceStart:edge.sourceStart,sourceEnd:edge.sourceEnd,
      offsetUnit:'utf16-code-units'
    });
  }
  if(seenSites.size!==expected.length)reject('LOADER_MISMATCH');
  validateLoaderCaller(
    analysis,'loadProjectFailureDiagnostics',
    'runProjectDesktopCodegenWithFailureDiagnosticsWithPorts','failure'
  );
  validateLoaderCaller(
    analysis,'loadProjectPhaseDiagnostics',
    'runProjectDesktopCodegenWithPhaseDiagnosticsWithPorts','phase'
  );
  return Object.freeze(expected.map(item=>{
    const found=result.find(site=>site.site===item.site);
    if(!found)reject('LOADER_MISMATCH');
    return Object.freeze(found);
  }));
}

export function assertEntrypointLoaderSites(source,entryPath,sourceRoot){
  if(!validAbsolutePath(entryPath)||!validAbsolutePath(sourceRoot)){
    reject('INVALID_ARGUMENT');
  }
  const analysis=internalAnalysis(
    source,newBudget(limitsFor())
  );
  return assertEntrypointLoaderSitesFromAnalysis(
    analysis,entryPath,sourceRoot
  );
}

function pathSet(value){
  if(value instanceof Set)return new Set(value);
  if(Array.isArray(value))return new Set(value);
  reject('INVALID_ARGUMENT');
}

function companionDag(value,companions,legacy){
  if(!(value instanceof Map)||value.size!==companions.size){
    reject('INVALID_ARGUMENT');
  }
  const result=new Map();
  for(const from of companions){
    if(!value.has(from))reject('INVALID_ARGUMENT');
    const targets=pathSet(value.get(from));
    for(const target of targets){
      if(!validAbsolutePath(target)||
         (!companions.has(target)&&!legacy.has(target))){
        reject('INVALID_ARGUMENT');
      }
    }
    result.set(from,targets);
  }
  const indegree=new Map([...companions].map(path=>[path,0]));
  for(const targets of result.values()){
    for(const target of targets){
      if(companions.has(target)){
        indegree.set(target,indegree.get(target)+1);
      }
    }
  }
  const queue=[...indegree].filter(([,degree])=>degree===0).map(([path])=>path);
  let visited=0;
  while(queue.length){
    const path=queue.pop();
    visited++;
    for(const target of result.get(path)){
      if(!companions.has(target))continue;
      const next=indegree.get(target)-1;
      indegree.set(target,next);
      if(next===0)queue.push(target);
    }
  }
  if(visited!==companions.size)reject('CLOSURE_VIOLATION');
  return result;
}

function builtinExpectedMap(value){
  if(value===undefined)return new Map();
  if(!(value instanceof Map))reject('INVALID_ARGUMENT');
  const result=new Map();
  for(const [path,edges]of value){
    if(!validAbsolutePath(path)||!Array.isArray(edges)){
      reject('INVALID_ARGUMENT');
    }
    result.set(path,edges.map(edge=>{
      if(!edge||typeof edge!=='object'||
         !['static','dynamic'].includes(edge.kind)||
         typeof edge.specifier!=='string'){
        reject('INVALID_ARGUMENT');
      }
      return {kind:edge.kind,specifier:edge.specifier};
    }));
  }
  return result;
}

function builtinKey(edge){
  return `${edge.kind}\0${edge.specifier}`;
}

function assertBuiltinEdges(path,actual,overridden,expectedMap,output){
  const hasExpected=expectedMap.has(path);
  if(overridden&&!hasExpected)reject('CLOSURE_VIOLATION');
  if(hasExpected){
    const remaining=new Map();
    for(const edge of expectedMap.get(path)){
      const key=builtinKey(edge);
      remaining.set(key,(remaining.get(key)??0)+1);
    }
    for(const edge of actual){
      const key=builtinKey(edge),count=remaining.get(key)??0;
      if(count===0)reject('CLOSURE_VIOLATION');
      remaining.set(key,count-1);
    }
    if([...remaining.values()].some(count=>count!==0)){
      reject('CLOSURE_VIOLATION');
    }
  }
  output.set(path,actual.map(edge=>Object.freeze({
    kind:edge.kind,specifier:edge.specifier
  })));
}

function exactCompanionTargets(from,actual,expected){
  const targets=[];
  for(const edge of actual){
    if(edge.resolution!=='relative'||edge.kind!=='static'){
      reject('CLOSURE_VIOLATION');
    }
    targets.push(edge.to);
  }
  if(new Set(targets).size!==targets.length||
     targets.length!==expected.size||
     targets.some(target=>!expected.has(target))){
    reject('CLOSURE_VIOLATION');
  }
}

function relativeEdgePolicy(from,edge,context){
  const {
    entryPath,companions,legacy,failurePath,phasePath,loaderSites,
    companionEdges
  }=context;
  if(edge.resolution!=='relative')return;
  if(from===entryPath){
    if(edge.kind==='static'){
      if(companions.has(edge.to)||edge.to===failurePath||
         edge.to===phasePath||!legacy.has(edge.to)){
        reject('CLOSURE_VIOLATION');
      }
    }else if(!loaderSites.some(site=>
      site.start===edge.start&&site.to===edge.to&&
      site.specifier===edge.specifier
    )){
      reject('CLOSURE_VIOLATION');
    }
    return;
  }
  if(companions.has(from)){
    if(edge.kind!=='static'||
       !companionEdges.get(from)?.has(edge.to)||
       edge.to===failurePath||edge.to===phasePath){
      reject('CLOSURE_VIOLATION');
    }
    return;
  }
  if(from===failurePath){
    if(edge.kind==='dynamic'){
      if(edge.to!==phasePath)reject('CLOSURE_VIOLATION');
    }else if(!legacy.has(edge.to)||companions.has(edge.to)||
             edge.to===phasePath){
      reject('CLOSURE_VIOLATION');
    }
    return;
  }
  if(from===phasePath){
    if(edge.kind!=='static'||!legacy.has(edge.to)||
       companions.has(edge.to)){
      reject('CLOSURE_VIOLATION');
    }
    return;
  }
  if(edge.kind!=='static'||!legacy.has(edge.to)||
     companions.has(edge.to)||edge.to===failurePath||edge.to===phasePath){
    reject('CLOSURE_VIOLATION');
  }
}

export async function buildSourceClosure(options){
  const allowedKeys=[
    'entryPath','preparePath','sourceRoot','legacyInventory','companions',
    'failurePath','phasePath','companionEdges','readSource','overrides',
    'approvedBuiltinEdges','includeDynamic','limits'
  ];
  if(!options||typeof options!=='object'||Array.isArray(options)||
     Reflect.ownKeys(options).some(key=>!allowedKeys.includes(key))){
    reject('INVALID_ARGUMENT');
  }
  const {
    entryPath,preparePath,sourceRoot,failurePath,phasePath,readSource,
    includeDynamic=true
  }=options;
  if(!validAbsolutePath(entryPath)||!validAbsolutePath(preparePath)||
     !validAbsolutePath(sourceRoot)||!validAbsolutePath(failurePath)||
     !validAbsolutePath(phasePath)||typeof readSource!=='function'||
     typeof includeDynamic!=='boolean'||entryPath===preparePath){
    reject('INVALID_ARGUMENT');
  }
  const legacy=pathSet(options.legacyInventory);
  const companions=pathSet(options.companions);
  const expectedCompanions=new Set(COMPANION_SOURCE_PATHS.map(name=>
    resolve(sourceRoot,name)
  ));
  if(legacy.has(entryPath)===false||legacy.has(preparePath)===false||
     !legacy.has(failurePath)||!legacy.has(phasePath)||
     [...companions].some(path=>!expectedCompanions.has(path))||
     expectedCompanions.size!==companions.size||
     [...companions].some(path=>legacy.has(path))){
    reject('INVALID_ARGUMENT');
  }
  for(const path of [...legacy,...companions]){
    if(!validAbsolutePath(path)){
      reject('INVALID_ARGUMENT');
    }
    const fromRoot=relative(sourceRoot,path);
    if(fromRoot===''||fromRoot==='..'||fromRoot.startsWith(`..${sep}`)||
       isAbsolute(fromRoot)){
      reject('INVALID_ARGUMENT');
    }
  }
  const dag=companionDag(options.companionEdges,companions,legacy);
  const overrides=options.overrides??new Map();
  if(!(overrides instanceof Map))reject('INVALID_ARGUMENT');
  for(const [path,source]of overrides){
    if(!validAbsolutePath(path)||typeof source!=='string'){
      reject('INVALID_ARGUMENT');
    }
  }
  const expectedBuiltins=builtinExpectedMap(options.approvedBuiltinEdges);
  const limits=limitsFor(options.limits),budget=newBudget(limits);
  const context={
    entryPath,companions,legacy,failurePath,phasePath,
    companionEdges:dag,loaderSites:[]
  };
  const queue=[entryPath,preparePath],seen=new Set(),edges=[];
  const builtinSnapshots=new Map();

  while(queue.length){
    const from=queue.pop();
    if(seen.has(from))continue;
    if(!legacy.has(from)&&!companions.has(from)){
      reject('CLOSURE_VIOLATION');
    }
    seen.add(from);
    let source;
    if(overrides.has(from)){
      source=overrides.get(from);
    }else{
      try{
        source=await readSource(from);
      }catch{
        reject('SOURCE_UNAVAILABLE');
      }
    }
    if(typeof source!=='string')reject('SOURCE_UNAVAILABLE');
    const analysis=internalAnalysis(source,budget);
    if(from===entryPath){
      context.loaderSites=assertEntrypointLoaderSitesFromAnalysis(
        analysis,entryPath,sourceRoot
      );
    }
    const actualBuiltins=[];
    const moduleEdges=[];
    for(const raw of analysis.edges){
      const classified=classifyModuleSpecifier(raw.specifier,from,sourceRoot);
      const edge={
        from,kind:raw.kind,specifier:raw.specifier,
        nodeType:raw.nodeType,resolution:classified.resolution,
        to:classified.to,start:raw.start,end:raw.end,
        sourceStart:raw.sourceStart,sourceEnd:raw.sourceEnd,
        offsetUnit:'utf16-code-units'
      };
      moduleEdges.push(edge);
      if(edge.resolution==='builtin'){
        actualBuiltins.push(edge);
        if(companions.has(from)&&edge.kind!=='static'){
          reject('CLOSURE_VIOLATION');
        }
        if(from===entryPath||from===failurePath){
          if(edge.kind==='dynamic')reject('CLOSURE_VIOLATION');
        }
        continue;
      }
      relativeEdgePolicy(from,edge,context);
      if(edge.kind==='static'||includeDynamic)queue.push(edge.to);
    }
    if(companions.has(from)){
      exactCompanionTargets(
        from,moduleEdges.filter(edge=>edge.resolution==='relative'),
        dag.get(from)
      );
    }
    assertBuiltinEdges(
      from,actualBuiltins,overrides.has(from),expectedBuiltins,builtinSnapshots
    );
    edges.push(...moduleEdges.map(edge=>Object.freeze(edge)));
  }
  for(const path of overrides.keys()){
    if(!seen.has(path))reject('CLOSURE_VIOLATION');
  }
  const approvedBuiltinEdges=Object.freeze(
    [...builtinSnapshots].sort(([left],[right])=>left.localeCompare(right))
      .map(([path,items])=>Object.freeze({
        path,edges:Object.freeze(items)
      }))
  );
  return Object.freeze({
    entryPath,preparePath,includeDynamic,
    paths:Object.freeze([...seen].sort()),
    edges:Object.freeze(edges),
    approvedBuiltinEdges,
    sourceBytes:budget.sourceBytes,moduleCount:budget.modules,
    nodeCount:budget.nodes,
    offsetUnit:'utf16-code-units'
  });
}
