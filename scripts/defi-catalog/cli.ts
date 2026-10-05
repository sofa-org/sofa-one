import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { assembleCatalogFromSources, assembleV5SourceCandidates, assembleV6SourceCandidates, assembleV7SourceCandidates, assembleV8SourceCandidates, assembleV9SourceCandidates, assertBaselinePreserved, catalogDiff, parseCatalogCliArgs, prepareV6Sources, prepareV7Sources, prepareV8Sources, prepareV9Sources, renderGeneratedModule, validateBaseline, validateCatalogDocument, V5_ASSEMBLY_PLAN_PATH, V6_ASSEMBLY_PLAN_PATH, V6_SOURCE_PATHS, V7_ASSEMBLY_PLAN_PATH, validateV5AssemblyPlan, validateV6AssemblyPlan, validateV7AssemblyPlan, validateV8AssemblyPlan, validateV9AssemblyPlan } from '../../src/modules/defi/catalog-tooling/catalog-generator';
import { V8_ASSEMBLY_PLAN_PATH, V8_SOURCE_PATHS } from '../../src/modules/defi/catalog-tooling/v8-identities';
import { V9_ASSEMBLY_PLAN_PATH, V9_SOURCE_PATHS, V9_SOURCE_RAW_SHA256 } from '../../src/modules/defi/catalog-tooling/v9-identities';
import { assembleCatalogUpdate, prepareCatalogUpdate, validateUpdatePlan } from '../../src/modules/defi/catalog-tooling/catalog-update';
import { parseUpdateArgs } from './update-cli-args';
import { assertSavedUpdateCatalogParity, assertUpdateRepositoryFile } from './update-cli-files';
import { createCatalogUpdateCliReport } from './update-cli-report';
import { isBareLegacyV9Check, selectBareCatalogUpdateArgs } from './update-cli-current';

const root = process.cwd();
const baselinePath = resolve(root, 'data/defi-catalog/v1/pre-migration-baseline.json');
const outputPath = resolve(root, 'src/modules/defi/registry/generated/production-catalog.ts');
const sourcePaths = ['data/defi-catalog/v2/sources/dex.json', 'data/defi-catalog/v2/sources/lending-yield.json'];
const admissionsPath = resolve(root, 'data/defi-catalog/v2/admissions.json');
const assembledCatalogPath = resolve(root, 'data/defi-catalog/v2/catalog.json');
const v3SourcePath = resolve(root, 'data/defi-catalog/v3/sources/workflow-extensions.json');
const v3AdmissionsPath = resolve(root, 'data/defi-catalog/v3/admissions.json');
const v3CatalogPath = resolve(root, 'data/defi-catalog/v3/catalog.json');
const v4SourcePaths = ['data/defi-catalog/v4/sources/ordinary-protocols.json', 'data/defi-catalog/v4/sources/yearn.json'];
const v4AdmissionsPath = resolve(root, 'data/defi-catalog/v4/admissions.json');
const v4CatalogPath = resolve(root, 'data/defi-catalog/v4/catalog.json');
const v5PlanPath = resolve(root, V5_ASSEMBLY_PLAN_PATH);
const v5AdmissionsPath = resolve(root, 'data/defi-catalog/v5/admissions.json');
const v5CatalogPath = resolve(root, 'data/defi-catalog/v5/catalog.json');
const v6PlanPath = resolve(root, V6_ASSEMBLY_PLAN_PATH);
const v6AdmissionsPath = resolve(root, 'data/defi-catalog/v6/admissions.json');
const v6CatalogPath = resolve(root, 'data/defi-catalog/v6/catalog.json');
const v7PlanPath = resolve(root, V7_ASSEMBLY_PLAN_PATH);
const v7AdmissionsPath = resolve(root, 'data/defi-catalog/v7/admissions.json');
const v7CatalogPath = resolve(root, 'data/defi-catalog/v7/catalog.json');
const v8PlanPath = resolve(root, V8_ASSEMBLY_PLAN_PATH);
const v8AdmissionsPath = resolve(root, 'data/defi-catalog/v8/admissions.json');
const v8CatalogPath = resolve(root, 'data/defi-catalog/v8/catalog.json');
const v9PlanPath = resolve(root, V9_ASSEMBLY_PLAN_PATH);
const v9AdmissionsPath = resolve(root, 'data/defi-catalog/v9/admissions.json');
const v9CatalogPath = resolve(root, 'data/defi-catalog/v9/catalog.json');

function loadV6Assembly() {
  const plan = validateV6AssemblyPlan(readJson(assertFixedFilePath(v6PlanPath, V6_ASSEMBLY_PLAN_PATH)));
  const base = validateCatalogDocument(readJson(assertFixedFilePath(resolve(root, plan.baselinePath), plan.baselinePath)));
  const inputs = plan.sourcePaths.map((relativePath) => ({ sourcePath: relativePath, document: readJson(assertFixedFilePath(resolve(root, relativePath), relativePath)) }));
  const admissions = readJson(assertFixedFilePath(v6AdmissionsPath, 'data/defi-catalog/v6/admissions.json'));
  const assembled = assembleV6SourceCandidates({ chains: base.chains }, inputs, admissions);
  return { plan, base, inputs, assembled };
}

function loadV7Assembly() {
  const plan = validateV7AssemblyPlan(readJson(assertFixedFilePath(v7PlanPath, V7_ASSEMBLY_PLAN_PATH)));
  const base = validateCatalogDocument(readJson(assertFixedFilePath(resolve(root, plan.baselinePath), plan.baselinePath)));
  const inputs = plan.sourcePaths.map((relativePath) => ({ sourcePath: relativePath, document: readJson(assertFixedFilePath(resolve(root, relativePath), relativePath)) }));
  const admissions = readJson(assertFixedFilePath(v7AdmissionsPath, 'data/defi-catalog/v7/admissions.json'));
  const assembled = assembleV7SourceCandidates({ chains: base.chains }, plan, inputs, admissions);
  return { plan, base, inputs, assembled };
}

function loadV8Preparation() {
  const plan = validateV8AssemblyPlan(readJson(assertFixedFilePath(v8PlanPath, V8_ASSEMBLY_PLAN_PATH)));
  const baselineBytes = readFileSync(assertFixedFilePath(resolve(root, plan.baselinePath), plan.baselinePath));
  const baselineRawSha256 = createHash('sha256').update(baselineBytes).digest('hex');
  const base = validateCatalogDocument(JSON.parse(baselineBytes.toString('utf8')) as unknown);
  const inputs = V8_SOURCE_PATHS.map((relativePath) => ({ sourcePath: relativePath, document: readJson(assertFixedFilePath(resolve(root, relativePath), relativePath)) }));
  const report = prepareV8Sources(inputs);
  const assembled = assembleV8SourceCandidates({ chains: base.chains }, plan, inputs, baselineRawSha256);
  return { plan, base, inputs, report, assembled };
}

function loadV8Assembly() {
  const prepared = loadV8Preparation();
  const admissions = readJson(assertFixedFilePath(v8AdmissionsPath, 'data/defi-catalog/v8/admissions.json'));
  const assembled = assembleV8SourceCandidates({ chains: prepared.base.chains }, prepared.plan, prepared.inputs, prepared.plan.baselineRawSha256, admissions);
  return { ...prepared, admissions, assembled };
}

function loadV9Preparation() {
  const plan = validateV9AssemblyPlan(readJson(assertFixedFilePath(v9PlanPath, V9_ASSEMBLY_PLAN_PATH)));
  const baselineBytes = readFileSync(assertFixedFilePath(resolve(root, plan.baselinePath), plan.baselinePath));
  const baselineRawSha256 = createHash('sha256').update(baselineBytes).digest('hex');
  const base = validateCatalogDocument(JSON.parse(baselineBytes.toString('utf8')) as unknown);
  const inputs = V9_SOURCE_PATHS.map((relativePath) => {
    const sourceBytes = readFileSync(assertFixedFilePath(resolve(root, relativePath), relativePath));
    if (createHash('sha256').update(sourceBytes).digest('hex') !== V9_SOURCE_RAW_SHA256) throw new Error('V9 raw sDAI source file does not match its frozen byte digest');
    return { sourcePath: relativePath, document: JSON.parse(sourceBytes.toString('utf8')) as unknown };
  });
  const report = prepareV9Sources(inputs);
  const assembled = assembleV9SourceCandidates({ chains: base.chains }, plan, inputs, baselineRawSha256);
  return { plan, base, inputs, report, assembled };
}

function loadV9Assembly() {
  const prepared = loadV9Preparation();
  const admissions = readJson(assertFixedFilePath(v9AdmissionsPath, 'data/defi-catalog/v9/admissions.json'));
  const assembled = assembleV9SourceCandidates({ chains: prepared.base.chains }, prepared.plan, prepared.inputs, prepared.plan.baselineRawSha256, admissions);
  return { ...prepared, admissions, assembled };
}

function resolveSourceCatalogPath(rootPath: string, inputPath: string): string {
  const repositoryRoot = realpathSync(rootPath);
  const dataRoot = realpathSync(resolve(repositoryRoot, 'data/defi-catalog'));
  const sourcePath = realpathSync(resolve(repositoryRoot, inputPath));
  const sourceRelative = relative(dataRoot, sourcePath);
  const selectedRelative = inputPath.replace(/^data\/defi-catalog\//, '').replaceAll('/', sep);
  if (sourceRelative !== selectedRelative || sourceRelative.startsWith(`..${sep}`) || sourceRelative === '..' || !/^v[1-9][0-9]*[\\/]catalog\.json$/.test(sourceRelative)) {
    throw new Error('Catalog input must resolve inside data/defi-catalog/vN/catalog.json');
  }
  return sourcePath;
}

function assertFixedOutputPath(): void {
  const repositoryRoot = realpathSync(root);
  const expectedParent = resolve(repositoryRoot, 'src/modules/defi/registry/generated');
  const actualParent = realpathSync(dirname(outputPath));
  let outputIsSymlink = false;
  try { outputIsSymlink = lstatSync(outputPath).isSymbolicLink(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (actualParent !== expectedParent || outputIsSymlink) {
    throw new Error('Generated output path must be the repository-owned production catalog file');
  }
}

function assertFixedFilePath(path: string, relativePath: string): string {
  const repositoryRoot = realpathSync(root);
  const expected = resolve(repositoryRoot, relativePath);
  const actual = realpathSync(path);
  if (actual !== expected || lstatSync(path).isSymbolicLink()) throw new Error(`Input path must be the fixed repository-owned file ${relativePath}`);
  return actual;
}

function assertFixedDataOutputPath(path: string, relativePath: string): string {
  const repositoryRoot = realpathSync(root);
  const expected = resolve(repositoryRoot, relativePath);
  const actualParent = realpathSync(dirname(path));
  let isSymlink = false;
  try { isSymlink = lstatSync(path).isSymbolicLink(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (actualParent !== resolve(dirname(expected)) || resolve(path) !== expected || isSymlink) {
    throw new Error(`Output path must be the fixed repository-owned file ${relativePath}`);
  }
  return path;
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')) as unknown; }
  catch (error) { throw new Error(`Unable to read valid JSON at ${path}: ${(error as Error).message}`); }
}

try {
  const argv = [...selectBareCatalogUpdateArgs(root,process.argv.slice(2))];
  if (['update-preview','update-build','generate','check','diff'].includes(argv[0]) && (['update-preview','update-build'].includes(argv[0])||argv.includes('--plan'))) {
    const mode=argv.shift()! as 'update-preview'|'update-build'|'generate'|'check'|'diff';
    const { planPath: planArg, write } = parseUpdateArgs(mode, argv);
    const planFile=assertUpdateRepositoryFile(root,planArg), plan=validateUpdatePlan(readJson(planFile),planArg);
    const baseFile=assertUpdateRepositoryFile(root,plan.baseline.path), baseBytes=readFileSync(baseFile), baseline=validateCatalogDocument(JSON.parse(baseBytes.toString('utf8')) as unknown);
    const inputs=plan.sources.map(s=>({sourcePath:s.path,document:readJson(assertUpdateRepositoryFile(root,s.path))}));
    const prepared=prepareCatalogUpdate({chains:baseline.chains},plan,inputs,createHash('sha256').update(baseBytes).digest('hex'));
    if(mode==='update-preview'){const baselineDefinitions=baseline.chains.reduce((n,c)=>n+c.contracts.reduce((m,k)=>m+k.functions.length,0),0);process.stdout.write(`${JSON.stringify(createCatalogUpdateCliReport(prepared,plan,baselineDefinitions),null,2)}\n`);}
    else if(write){if(plan.deactivations.length)throw new Error('Applying deactivations is deferred');const target=assertUpdateRepositoryFile(root,`${planArg.slice(0,planArg.lastIndexOf('/'))}/catalog.json`,true);const assembled=assembleCatalogUpdate({chains:baseline.chains},plan,inputs,createHash('sha256').update(baseBytes).digest('hex'));writeFileSync(target,`${JSON.stringify({schemaVersion:1,chains:assembled.chains},null,2)}\n`,'utf8');process.stdout.write('Update catalog written to the selected update folder.\n');}
    else if(mode==='update-build')process.stdout.write(`${JSON.stringify({projectedDiff:prepared.projectedDiff,sourceDigests:prepared.sourceDigests,writePerformed:false},null,2)}\n`);
    else {
      if(plan.deactivations.length)throw new Error('Applying deactivations is deferred');
      const assembled=assembleCatalogUpdate({chains:baseline.chains},plan,inputs,createHash('sha256').update(baseBytes).digest('hex'));
      const savedPath=`${planArg.slice(0,planArg.lastIndexOf('/'))}/catalog.json`;
      if(mode==='diff') process.stdout.write(`${JSON.stringify(prepared.projectedDiff,null,2)}\n`);
       else { const expected=JSON.stringify({schemaVersion:1,chains:assembled.chains}); assertSavedUpdateCatalogParity(root,savedPath,expected,(value)=>{const saved=validateCatalogDocument(value);return JSON.stringify({schemaVersion:1,chains:saved.chains});}); const modulePath=assertUpdateRepositoryFile(root,'src/modules/defi/registry/generated/production-catalog.ts',mode==='generate'); if(mode==='generate') { writeFileSync(modulePath,renderGeneratedModule(assembled),'utf8'); process.stdout.write('Production module generated from the saved, pinned update catalog.\n'); } else { if(readFileSync(modulePath,'utf8')!==renderGeneratedModule(assembled))throw new Error('Production module is not generated from this update plan'); process.stdout.write('Plan catalog and production module match.\n'); } }
    }
    process.exit(0);
  }
  const options = parseCatalogCliArgs(argv);
  if (options.mode === 'prepare-v5') {
    const plan = validateV5AssemblyPlan(readJson(assertFixedFilePath(v5PlanPath, V5_ASSEMBLY_PLAN_PATH)));
    const base = validateCatalogDocument(readJson(assertFixedFilePath(resolve(root, plan.baselinePath), plan.baselinePath)));
    const inputs = plan.sourcePaths.map((relativePath) => ({ sourcePath: relativePath, document: readJson(assertFixedFilePath(resolve(root, relativePath), relativePath)) }));
    const candidate = assembleV5SourceCandidates({ chains: base.chains }, plan, inputs);
    const beforeIds = new Set(base.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions.map((fn) => fn.capabilityId))));
    const added = candidate.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).filter((fn) => !beforeIds.has(fn.capabilityId));
    process.stdout.write(`Prepared ${added.length} inactive v5 source candidates from ${inputs.length} explicit snapshots; no admission or catalog file was written.\n`);
  } else if (options.mode === 'prepare-v6') {
    const inputs = V6_SOURCE_PATHS.map((relativePath) => ({ sourcePath: relativePath, document: readJson(assertFixedFilePath(resolve(root, relativePath), relativePath)) }));
    const report = prepareV6Sources(inputs);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (options.mode === 'prepare-v7') {
    const plan = validateV7AssemblyPlan(readJson(assertFixedFilePath(v7PlanPath, V7_ASSEMBLY_PLAN_PATH)));
    const base = validateCatalogDocument(readJson(assertFixedFilePath(resolve(root, plan.baselinePath), plan.baselinePath)));
    const inputs = plan.sourcePaths.map((relativePath) => ({ sourcePath: relativePath, document: readJson(assertFixedFilePath(resolve(root, relativePath), relativePath)) }));
    const report = prepareV7Sources(inputs);
    const assembled = assembleV7SourceCandidates({ chains: base.chains }, plan, inputs);
    const diff = catalogDiff(base, assembled);
    const candidates = assembled.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).filter((fn) => diff.added.includes(fn.capabilityId));
    if (diff.added.length !== 28 || diff.removed.length || diff.authorityChanged.length || diff.abiChanged.length || diff.metadataChanged.length || candidates.length !== 28 || candidates.some((fn) => fn.status !== 'inactive' || fn.provenance.status !== 'candidate')) throw new Error('V7 preparation did not produce exactly 28 inactive, source-qualified candidates over unchanged v6');
    process.stdout.write(`${JSON.stringify({ ...report, candidateStatus: 'inactive', baselineDefinitions: 640, baselineScopes: 15, assembledDefinitions: 668, admissionsWritten: false, catalogWritten: false }, null, 2)}\n`);
  } else if (options.mode === 'prepare-v8') {
    const { base, report, assembled } = loadV8Preparation();
    const diff = catalogDiff(base, assembled);
    const added = assembled.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).filter((fn) => diff.added.includes(fn.capabilityId));
    const scopeCount = assembled.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).filter((fn) => fn.executionScope).length;
    if (diff.added.length !== 1 || diff.removed.length || diff.authorityChanged.length || diff.abiChanged.length || diff.metadataChanged.length
      || added.length !== 1 || added[0].status !== 'inactive' || added[0].provenance.status !== 'candidate'
      || added[0].executionScope?.kind !== 'enso-static-weiroll-v1' || scopeCount !== 16
      || renderGeneratedModule(assembled).length === 0) throw new Error('V8 preparation did not produce exactly one inactive mandatory-scope Enso candidate over unchanged v7');
    process.stdout.write(`${JSON.stringify({ ...report, candidateStatus: 'inactive', baselineDefinitions: 668, baselineScopes: 15, assembledDefinitions: 669, assembledScopes: 16, candidateCapabilityId: added[0].capabilityId, admissionsApplied: false, admissionsWritten: false, catalogWritten: false, productionModuleWritten: false }, null, 2)}\n`);
  } else if (options.mode === 'prepare-v9') {
    const { base, report, assembled } = loadV9Preparation();
    const diff = catalogDiff(base, assembled);
    const added = assembled.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).filter((fn) => diff.added.includes(fn.capabilityId));
    const allFunctions = assembled.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
    const scopeCount = allFunctions.filter((fn) => fn.executionScope).length;
    const approvalCount = allFunctions.filter((fn) => fn.operation === 'approve').length;
    if (diff.added.length !== 4 || diff.removed.length || diff.authorityChanged.length || diff.abiChanged.length || diff.metadataChanged.length
      || added.length !== 4 || added.some((fn) => fn.status !== 'inactive' || fn.provenance.status !== 'candidate' || fn.executionScope != null)
      || scopeCount !== 16 || approvalCount !== 23 || allFunctions.length - approvalCount !== 650
      || renderGeneratedModule(assembled).length === 0) throw new Error('V9 preparation did not produce exactly four inactive scope-free candidates over unchanged v8');
    process.stdout.write(`${JSON.stringify({ ...report, candidateStatus: 'inactive', baselineDefinitions: 669, baselineScopes: 16, assembledDefinitions: 673, assembledActions: 650, assembledApprovals: 23, assembledScopes: 16, candidateCapabilityIds: added.map((fn) => fn.capabilityId), admissionsApplied: false, admissionsWritten: false, catalogWritten: false, productionModuleWritten: false }, null, 2)}\n`);
  } else if (options.mode === 'assemble') {
    if (options.inputPath === 'data/defi-catalog/v9/catalog.json') {
      const { inputs, assembled } = loadV9Assembly();
      const target = assertFixedDataOutputPath(v9CatalogPath, 'data/defi-catalog/v9/catalog.json');
      writeFileSync(target, `${JSON.stringify({ schemaVersion: 1, chains: assembled.chains }, null, 2)}\n`, 'utf8');
      process.stdout.write(`Assembled 673 v9 definitions from ${inputs.length} exact source snapshot over immutable v8 with four explicit sDAI admissions.\n`);
    } else if (options.inputPath === 'data/defi-catalog/v8/catalog.json') {
      const { inputs, assembled } = loadV8Assembly();
      const target = assertFixedDataOutputPath(v8CatalogPath, 'data/defi-catalog/v8/catalog.json');
      writeFileSync(target, `${JSON.stringify({ schemaVersion: 1, chains: assembled.chains }, null, 2)}\n`, 'utf8');
      process.stdout.write(`Assembled 669 v8 definitions from ${inputs.length} exact source snapshots over immutable v7 with one explicit scoped Enso admission.\n`);
    } else if (options.inputPath === 'data/defi-catalog/v7/catalog.json') {
      const { inputs, assembled } = loadV7Assembly();
      const target = assertFixedDataOutputPath(v7CatalogPath, 'data/defi-catalog/v7/catalog.json');
      writeFileSync(target, `${JSON.stringify({ schemaVersion: 1, chains: assembled.chains }, null, 2)}\n`, 'utf8');
      process.stdout.write(`Assembled ${assembled.chains.reduce((count, chain) => count + chain.contracts.reduce((sum, contract) => sum + contract.functions.length, 0), 0)} v7 definitions from ${inputs.length} exact admitted source snapshots over v6.\n`);
    } else if (options.inputPath === 'data/defi-catalog/v6/catalog.json') {
      const { inputs, assembled } = loadV6Assembly();
      const target = assertFixedDataOutputPath(v6CatalogPath, 'data/defi-catalog/v6/catalog.json');
      writeFileSync(target, `${JSON.stringify({ schemaVersion: 1, chains: assembled.chains }, null, 2)}\n`, 'utf8');
      process.stdout.write(`Assembled ${assembled.chains.reduce((count, chain) => count + chain.contracts.reduce((sum, contract) => sum + contract.functions.length, 0), 0)} v6 definitions from ${inputs.length} exact admitted source snapshots.\n`);
    } else if (options.inputPath === 'data/defi-catalog/v5/catalog.json') {
      const plan = validateV5AssemblyPlan(readJson(assertFixedFilePath(v5PlanPath, V5_ASSEMBLY_PLAN_PATH)));
      const base = validateCatalogDocument(readJson(assertFixedFilePath(v4CatalogPath, 'data/defi-catalog/v4/catalog.json')));
      const inputs = plan.sourcePaths.map((relativePath) => ({ sourcePath: relativePath, document: readJson(assertFixedFilePath(resolve(root, relativePath), relativePath)) }));
      const admissions = readJson(assertFixedFilePath(v5AdmissionsPath, 'data/defi-catalog/v5/admissions.json'));
      const assembled = assembleCatalogFromSources({ chains: base.chains }, inputs, admissions);
      const target = assertFixedDataOutputPath(v5CatalogPath, 'data/defi-catalog/v5/catalog.json');
      writeFileSync(target, `${JSON.stringify({ schemaVersion: 1, chains: assembled.chains }, null, 2)}\n`, 'utf8');
      process.stdout.write(`Assembled ${assembled.chains.reduce((count, chain) => count + chain.contracts.reduce((sum, contract) => sum + contract.functions.length, 0), 0)} v5 definitions from ${inputs.length} admitted source snapshots.\n`);
    } else {
    const isV3 = options.inputPath === 'data/defi-catalog/v3/catalog.json';
    const isV4 = options.inputPath === 'data/defi-catalog/v4/catalog.json';
    const baseline = validateBaseline(readJson(assertFixedFilePath(baselinePath, 'data/defi-catalog/v1/pre-migration-baseline.json')));
    const basePath = isV4 ? 'data/defi-catalog/v3/catalog.json' : isV3 ? 'data/defi-catalog/v2/catalog.json' : 'data/defi-catalog/v1/catalog.json';
    const base = validateCatalogDocument(readJson(assertFixedFilePath(resolve(root, basePath), basePath)));
    const inputs = isV4
      ? v4SourcePaths.map((relativePath) => ({ sourcePath: relativePath, document: readJson(assertFixedFilePath(resolve(root, relativePath), relativePath)) }))
      : isV3
      ? [{ sourcePath: 'data/defi-catalog/v3/sources/workflow-extensions.json', document: readJson(assertFixedFilePath(v3SourcePath, 'data/defi-catalog/v3/sources/workflow-extensions.json')) }]
      : sourcePaths.map((relativePath) => ({ sourcePath: relativePath, document: readJson(assertFixedFilePath(resolve(root, relativePath), relativePath)) }));
    const admissionFile = isV4 ? v4AdmissionsPath : isV3 ? v3AdmissionsPath : admissionsPath;
    const admissionRelative = isV4 ? 'data/defi-catalog/v4/admissions.json' : isV3 ? 'data/defi-catalog/v3/admissions.json' : 'data/defi-catalog/v2/admissions.json';
    const admissions = readJson(assertFixedFilePath(admissionFile, admissionRelative));
    const assembled = assembleCatalogFromSources({ chains: base.chains }, inputs, admissions);
    const target = isV4
      ? assertFixedDataOutputPath(v4CatalogPath, 'data/defi-catalog/v4/catalog.json')
      : assertFixedFilePath(isV3 ? v3CatalogPath : assembledCatalogPath, isV3 ? 'data/defi-catalog/v3/catalog.json' : 'data/defi-catalog/v2/catalog.json');
    writeFileSync(target, `${JSON.stringify({ schemaVersion: 1, chains: assembled.chains }, null, 2)}\n`, 'utf8');
    process.stdout.write(`Assembled ${assembled.chains.reduce((count, chain) => count + chain.contracts.reduce((sum, contract) => sum + contract.functions.length, 0), 0)} source-qualified definitions.\n`);
    }
  } else {
  const inputPath = resolveSourceCatalogPath(root, options.inputPath);
  assertFixedOutputPath();
  const baseline = validateBaseline(readJson(baselinePath));
  const isV9 = options.inputPath === 'data/defi-catalog/v9/catalog.json';
  const isV8 = options.inputPath === 'data/defi-catalog/v8/catalog.json';
  const isV7 = options.inputPath === 'data/defi-catalog/v7/catalog.json';
  const isV6 = options.inputPath === 'data/defi-catalog/v6/catalog.json';
  const isV5 = options.inputPath === 'data/defi-catalog/v5/catalog.json';
  let current: ReturnType<typeof validateCatalogDocument>;
  if (isV9) {
    const { assembled } = loadV9Assembly();
    current = validateCatalogDocument({ schemaVersion: 1, chains: assembled.chains });
    const saved = validateCatalogDocument(readJson(assertFixedFilePath(v9CatalogPath, 'data/defi-catalog/v9/catalog.json')));
    if (JSON.stringify({ schemaVersion: 1, chains: current.chains }) !== JSON.stringify({ schemaVersion: 1, chains: saved.chains })) throw new Error('V9 catalog does not match the exact fixed sDAI source, admissions, and immutable v8 baseline');
  } else if (isV8) {
    const { assembled } = loadV8Assembly();
    current = validateCatalogDocument({ schemaVersion: 1, chains: assembled.chains });
    const saved = validateCatalogDocument(readJson(assertFixedFilePath(v8CatalogPath, 'data/defi-catalog/v8/catalog.json')));
    if (JSON.stringify({ schemaVersion: 1, chains: current.chains }) !== JSON.stringify({ schemaVersion: 1, chains: saved.chains })) throw new Error('V8 catalog does not match the exact fixed source, identity, admission, and immutable v7 baseline');
  } else if (isV7) {
    const { assembled } = loadV7Assembly();
    current = validateCatalogDocument({ schemaVersion: 1, chains: assembled.chains });
    const saved = validateCatalogDocument(readJson(assertFixedFilePath(v7CatalogPath, 'data/defi-catalog/v7/catalog.json')));
    if (JSON.stringify({ schemaVersion: 1, chains: current.chains }) !== JSON.stringify({ schemaVersion: 1, chains: saved.chains })) throw new Error('V7 catalog does not match the exact source snapshots, identity map, and admissions');
  } else if (isV6) {
    const { assembled } = loadV6Assembly();
    current = validateCatalogDocument({ schemaVersion: 1, chains: assembled.chains });
    const saved = validateCatalogDocument(readJson(assertFixedFilePath(v6CatalogPath, 'data/defi-catalog/v6/catalog.json')));
    if (JSON.stringify({ schemaVersion: 1, chains: current.chains }) !== JSON.stringify({ schemaVersion: 1, chains: saved.chains })) throw new Error('V6 catalog does not match the exact source snapshots, identity map, and admissions');
  } else if (isV5) {
    const plan = validateV5AssemblyPlan(readJson(assertFixedFilePath(v5PlanPath, V5_ASSEMBLY_PLAN_PATH)));
    const base = validateCatalogDocument(readJson(assertFixedFilePath(v4CatalogPath, 'data/defi-catalog/v4/catalog.json')));
    const inputs = plan.sourcePaths.map((relativePath) => ({ sourcePath: relativePath, document: readJson(assertFixedFilePath(resolve(root, relativePath), relativePath)) }));
    const admissions = readJson(assertFixedFilePath(v5AdmissionsPath, 'data/defi-catalog/v5/admissions.json'));
    current = validateCatalogDocument({ schemaVersion: 1, chains: assembleCatalogFromSources({ chains: base.chains }, inputs, admissions).chains });
    const saved = validateCatalogDocument(readJson(assertFixedFilePath(v5CatalogPath, 'data/defi-catalog/v5/catalog.json')));
    if (JSON.stringify({ schemaVersion: 1, chains: current.chains }) !== JSON.stringify({ schemaVersion: 1, chains: saved.chains })) throw new Error('V5 catalog does not match the current explicit plan, sources, and admissions');
  } else current = validateCatalogDocument(readJson(inputPath));
  const comparison = isV9
    ? validateCatalogDocument(readJson(assertFixedFilePath(v8CatalogPath, 'data/defi-catalog/v8/catalog.json')))
    : isV8
    ? validateCatalogDocument(readJson(assertFixedFilePath(v7CatalogPath, 'data/defi-catalog/v7/catalog.json')))
    : isV7
    ? validateCatalogDocument(readJson(assertFixedFilePath(v6CatalogPath, 'data/defi-catalog/v6/catalog.json')))
    : isV6
    ? validateCatalogDocument(readJson(assertFixedFilePath(v5CatalogPath, 'data/defi-catalog/v5/catalog.json')))
    : isV5
    ? validateCatalogDocument(readJson(assertFixedFilePath(v4CatalogPath, 'data/defi-catalog/v4/catalog.json')))
    : options.inputPath === 'data/defi-catalog/v4/catalog.json'
    ? validateCatalogDocument(readJson(assertFixedFilePath(resolve(root, 'data/defi-catalog/v3/catalog.json'), 'data/defi-catalog/v3/catalog.json')))
    : options.inputPath === 'data/defi-catalog/v3/catalog.json'
    ? validateCatalogDocument(readJson(assertFixedFilePath(resolve(root, 'data/defi-catalog/v2/catalog.json'), 'data/defi-catalog/v2/catalog.json')))
    : { chains: baseline.chains };
  const diff = catalogDiff(comparison, current);
  if (options.mode === 'diff') {
    process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
  } else if (options.mode === 'generate') {
    assertBaselinePreserved(current, baseline);
    writeFileSync(outputPath, renderGeneratedModule(current), 'utf8');
  } else if (options.mode === 'check') {
    assertBaselinePreserved(current, baseline);
    if (isV9 && isBareLegacyV9Check(process.argv.slice(2))) {
      const expected = renderGeneratedModule(current);
      const actual = readFileSync(outputPath, 'utf8');
      if (actual !== expected) throw new Error('V9 catalog and generated production registry are stale; run npm run defi:catalog:generate');
      process.stdout.write('V9 catalog and generated production registry are current against fixed sDAI source/admissions and immutable v8 baseline.\n');
    } else if (isV9) {
      process.stdout.write('Historical v9 catalog is current against fixed sDAI source/admissions and immutable v8 baseline; production-module selection is separate.\n');
    } else if (isV8) {
      process.stdout.write('Historical v8 catalog is current against fixed Enso source/admission and immutable v7 baseline; production-module selection is separate.\n');
    } else if (isV7) {
      process.stdout.write('Historical v7 catalog is current against its fixed v6 baseline, sources, identity map, and admissions; production-module selection is separate.\n');
    } else if (isV6) {
      process.stdout.write('V6 catalog is current against its fixed sources and admissions; production-module selection is separate.\n');
    } else if (isV5) {
      process.stdout.write('V5 catalog is current against its fixed sources and admissions; production-module selection is separate.\n');
    } else {
    const expected = renderGeneratedModule(current);
    const actual = readFileSync(outputPath, 'utf8');
    if (actual !== expected) throw new Error(`Generated catalog is stale; run npm run defi:catalog:generate -- --input ${options.inputPath}`);
    process.stdout.write('Generated DeFi catalog is current.\n');
    }
  }
  }
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
}
