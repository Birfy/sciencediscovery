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
// limitations under the License.

import assert from "node:assert/strict";
import test from "node:test";

import { importSkillsToJiuwenSwarm, skillLoadedBy } from "./jiuwenswarm-skills.js";

const ids = new Map([["evolve-design", "evolve-design"], ["sciencediscovery-skill-creator", "skill-creator"]]);

test("skill_tool on a skill's SKILL.md, or read_file of it, loads that skill", () => {
  assert.equal(skillLoadedBy({ name: "skill_tool", args: { skill_name: "evolve-design" } }, ids), "evolve-design");
  assert.equal(skillLoadedBy({ name: "skill_tool", args: { skill_name: "sciencediscovery-skill-creator", relative_file_path: "SKILL.md" } }, ids), "skill-creator");
  assert.equal(skillLoadedBy({ name: "read_file", args: { file_path: "/root/.jiuwenswarm-instances/x/agent/workspace/skills/evolve-design/SKILL.md" } }, ids), "evolve-design");
});

test("a supporting file, another skill or another tool is not a load", () => {
  assert.equal(skillLoadedBy({ name: "skill_tool", args: { skill_name: "evolve-design", relative_file_path: "references/a.md" } }, ids), undefined);
  assert.equal(skillLoadedBy({ name: "skill_tool", args: { skill_name: "skill-creator" } }, ids), undefined, "JiuwenSwarm's own skill-creator is not ours");
  assert.equal(skillLoadedBy({ name: "read_file", args: { file_path: "/w/notes/SKILL.md" } }, ids), undefined);
  assert.equal(skillLoadedBy({ name: "bash", args: { command: "cat skills/evolve-design/SKILL.md" } }, ids), undefined);
});

test("an adapter that cannot install skills leaves them all ours", async () => {
  const failing = (async () => new Response("down", { status: 502 })) as unknown as typeof fetch;
  const imported = await importSkillsToJiuwenSwarm({ adapterUrl: "http://a", fetch: failing }, [{ id: "x", hash: "h" }], "/root");
  assert.equal(imported.size, 0);
});
