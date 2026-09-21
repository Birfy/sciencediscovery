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

/**
 * L1 contract scenarios: replay a scripted list of HTTP requests against a backend,
 * record what came back (normalised), and compare a run against a stored baseline.
 * No browser and no model: it checks the interface, not the agent.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createNormalizer, diff } from "./normalize.mjs";

export function loadCases(directory) {
  return readdirSync(directory).filter((name) => name.endsWith(".json")).sort()
    .flatMap((name) => JSON.parse(readFileSync(join(directory, name), "utf8")).cases
      .map((testCase) => ({ ...testCase, file: name })));
}

/** $.a.b[0] style lookups, enough for capturing ids out of a response. */
export function lookup(value, expression) {
  const parts = expression.replace(/^\$\.?/, "").split(/[.\[\]]+/).filter(Boolean);
  return parts.reduce((current, part) => (current === undefined || current === null ? undefined : current[part]), value);
}

function substitute(value, variables) {
  if (typeof value === "string") {
    return value.replace(/\{\{(\w+)\}\}/g, (_, name) => {
      if (!(name in variables)) throw new Error(`variable {{${name}}} was never captured`);
      return String(variables[name]);
    });
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, variables));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, variables)]));
  return value;
}

async function readSse(response, stream) {
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + (stream.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ done: true }), Math.max(1, deadline - Date.now()))),
    ]);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let boundary = buffer.indexOf("\n\n"); boundary >= 0; boundary = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!data) continue;
      try { events.push(JSON.parse(data)); } catch { events.push({ raw: data }); }
      const last = events[events.length - 1];
      const type = last?.event?.type ?? last?.type;
      if (stream.until?.includes(type) || events.length >= (stream.maxEvents ?? 1_000)) {
        await reader.cancel().catch(() => undefined);
        return events;
      }
    }
  }
  await reader.cancel().catch(() => undefined);
  return events;
}

/** Run one case; returns one record per step. Steps marked always:true run even after a failure. */
export async function runCase(testCase, { base, token, fetchImpl = fetch }) {
  const normalize = createNormalizer();
  const variables = {};
  const records = [];
  let failed = false;
  for (const step of testCase.steps) {
    if (failed && !step.always) continue;
    const record = { name: step.name };
    try {
      const request = substitute(step.request, variables);
      const response = await fetchImpl(`${base}${request.path}`, {
        method: request.method,
        headers: { authorization: `Bearer ${token}`, ...(request.body !== undefined ? { "content-type": "application/json" } : {}), ...(request.headers ?? {}) },
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      });
      record.status = response.status;
      record.contentType = (response.headers.get("content-type") ?? "").split(";")[0];
      if (step.stream) {
        record.events = (await readSse(response, step.stream)).map((event) => normalize.json(event));
      } else {
        const raw = await response.text();
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
        if (parsed !== undefined) {
          for (const [name, expression] of Object.entries(step.capture ?? {})) variables[name] = lookup(parsed, expression);
          record.body = normalize.json(parsed);
        } else if (raw) {
          record.text = normalize.text(raw).slice(0, 2_000);
        }
      }
      if (step.expectStatus !== undefined && response.status !== step.expectStatus) {
        record.error = `expected status ${step.expectStatus}, got ${response.status}`;
        failed = true;
      }
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      failed = true;
    }
    records.push(record);
  }
  return records;
}

export async function runAll(cases, options) {
  const result = {};
  for (const testCase of cases) result[testCase.id] = await runCase(testCase, options);
  return result;
}

/** Differences between a baseline recording and a fresh one, as readable lines. */
export function compareRecordings(baseline, actual) {
  const problems = [];
  for (const [id, expectedSteps] of Object.entries(baseline)) {
    const actualSteps = actual[id];
    if (!actualSteps) { problems.push(`${id}: case was not run`); continue; }
    expectedSteps.forEach((expected, index) => {
      const got = actualSteps[index];
      if (!got) { problems.push(`${id} / ${expected.name}: step missing`); return; }
      for (const difference of diff(expected, got)) {
        problems.push(`${id} / ${expected.name}: ${difference.path} expected ${JSON.stringify(difference.expected)} got ${JSON.stringify(difference.actual)}`);
      }
    });
  }
  return problems;
}

/** Coverage of the interface inventory by the cases; rows marked not-migrated need none. */
export function coverage(routes, cases) {
  const covered = new Set(cases.flatMap((testCase) => testCase.steps.flatMap((step) => step.covers ?? [])));
  const rows = routes.rows.map((row) => ({ ...row, key: `${row.method} ${row.path}`, exempt: row.handling === "not-migrated" }));
  const unknown = [...covered].filter((key) => !rows.some((row) => row.key === key));
  return {
    unknown,
    total: rows.length,
    exempt: rows.filter((row) => row.exempt).length,
    covered: rows.filter((row) => !row.exempt && covered.has(row.key)).length,
    missing: rows.filter((row) => !row.exempt && !covered.has(row.key)),
  };
}
