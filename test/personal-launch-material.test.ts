import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { TEST_MATERIAL } from "./helpers/personal-launch.js";
import { validateLaunchMaterial, composeSystemPrompt } from "../src/personal/launch-material.js";
test("launch capture binds exactly two core prompts with no retired dispatcher",async()=>{
 assert.ok(Object.isFrozen(validateLaunchMaterial(TEST_MATERIAL)));
 assert.throws(()=>validateLaunchMaterial({...TEST_MATERIAL,coreDigest:"a".repeat(64)}));
 for(const phase of ["implement","verify"] as const){const prompt=composeSystemPrompt(TEST_MATERIAL,phase);assert.match(prompt,/immutable/);assert.doesNotMatch(prompt,/remediation_required/);}
 const files=await readdir("src/personal");
 assert.ok(files.every(f=>! /plan-|staged-|report-correction/u.test(f)));
 const index=await readFile("src/index.ts","utf8");assert.doesNotMatch(index,/control\/|plan\/|pi\//);
 const runner=await readFile("src/personal/pi-phase-runner.ts","utf8");assert.doesNotMatch(runner,/correctReport|supervisor|stagedProfile/);
});
