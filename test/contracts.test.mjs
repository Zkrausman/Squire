import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
test("phase schemas and executable validators agree",()=>{assert.match(execFileSync(process.execPath,["scripts/validate-contracts.mjs"],{encoding:"utf8"}),/Validated two/);});
