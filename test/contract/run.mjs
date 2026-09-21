#!/usr/bin/env node
//!/usr/bin/env bash
// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and

// node test/contract/run.mjs --record baseline.json          record against $E2E_BASE_URL
// node test/contract/run.mjs --compare baseline.json         replay and diff against a recording
// node test/contract/run.mjs --coverage                      which interface rows have no case yet
// Options: --base URL (default $E2E_BASE_URL), --token T (default $E2E_API_TOKEN), --case ID (repeatable)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compareRecordings, coverage, loadCases, runAll } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const all = (name) => args.flatMap((value, at) => (value === name ? [args[at + 1]] : []));
const cases = loadCases(join(here, "cases"));

if (args.includes("--coverage")) {
  const report = coverage(JSON.parse(readFileSync(join(here, "routes.json"), "utf8")), cases);
  console.log(`${report.covered} of ${report.total - report.exempt} interface rows have a case (${report.exempt} marked not-migrated).`);
  for (const key of report.unknown) console.log(`  UNKNOWN in cases (not in the inventory): ${key}`);
  const byDomain = Map.groupBy(report.missing, (row) => row.domain);
  for (const [domain, rows] of byDomain) console.log(`  ${domain}: ${rows.length} without a case`);
  process.exit(report.unknown.length ? 1 : 0);
}

const base = option("--base") ?? process.env.E2E_BASE_URL;
const token = option("--token") ?? process.env.E2E_API_TOKEN;
if (!base || !token) { console.error("Need --base/--token or E2E_BASE_URL/E2E_API_TOKEN."); process.exit(2); }
const only = all("--case");
const selected = only.length ? cases.filter((testCase) => only.includes(testCase.id)) : cases;
const recording = await runAll(selected, { base, token });
const errors = Object.entries(recording).flatMap(([id, steps]) => steps.filter((step) => step.error).map((step) => `${id} / ${step.name}: ${step.error}`));
if (option("--record")) { writeFileSync(option("--record"), JSON.stringify(recording, null, 1) + "\n"); console.log(`recorded ${selected.length} cases to ${option("--record")}`); }
if (option("--compare")) {
  const baseline = JSON.parse(readFileSync(option("--compare"), "utf8"));
  const wanted = Object.fromEntries(Object.entries(baseline).filter(([id]) => selected.some((testCase) => testCase.id === id)));
  const problems = compareRecordings(wanted, recording);
  console.log(problems.length ? problems.join("\n") : `${Object.keys(wanted).length} cases match the baseline.`);
  if (problems.length) process.exitCode = 1;
}
if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
