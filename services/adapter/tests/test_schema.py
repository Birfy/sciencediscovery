# Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from sciencediscovery_adapter.llm_proxy import LlmRoute, rewrite_request
from sciencediscovery_adapter.schema import relax_schema

TASK = {
    "type": "object", "additionalProperties": False, "required": ["prompt"],
    "properties": {
        "prompt": {"type": "string", "minLength": 1, "maxLength": 100},
        "timeout_seconds": {"type": "integer", "minimum": 7200, "maximum": 86400, "default": 7200},
        "tools": {"anyOf": [{"type": "null"}, {"type": "array", "items": {"type": "string", "minLength": 1}, "maxItems": 32}]},
        "mode": {"enum": ["a", "b"]},
    },
}


def test_bounds_that_only_make_validation_stricter_are_removed_everywhere():
    relaxed = relax_schema(TASK)
    assert relaxed["properties"]["timeout_seconds"] == {"type": "integer", "default": 7200}
    assert relaxed["properties"]["prompt"] == {"type": "string"}
    assert relaxed["properties"]["tools"]["anyOf"][1] == {"type": "array", "items": {"type": "string"}}


def test_what_a_call_is_made_of_is_kept():
    relaxed = relax_schema(TASK)
    assert relaxed["required"] == ["prompt"] and relaxed["type"] == "object"
    assert relaxed["properties"]["mode"] == {"enum": ["a", "b"]}
    assert "additionalProperties" not in relaxed


def test_relaxing_copies_and_does_not_touch_the_original():
    relax_schema(TASK)
    assert TASK["properties"]["timeout_seconds"]["minimum"] == 7200


def test_additional_properties_that_carry_a_schema_are_kept():
    schema = {"type": "object", "additionalProperties": {"type": "string", "maxLength": 3}}
    assert relax_schema(schema) == {"type": "object", "additionalProperties": {"type": "string"}}


def test_the_model_gets_the_original_schema_and_description_back():
    route = LlmRoute(base_url="u", api_key="k", model="m", tool_prefix="mcp_sci_", tool_names=frozenset({"task"}),
                     tool_specs={"task": {"description": "Run a subagent.", "parameters": TASK}})
    body = {"tools": [{"type": "function", "function": {"name": "mcp_sci_task", "description": "relaxed", "parameters": relax_schema(TASK)}}],
            "messages": []}
    function = rewrite_request(body, route)["tools"][0]["function"]
    assert function["name"] == "task" and function["description"] == "Run a subagent."
    assert function["parameters"]["properties"]["timeout_seconds"]["minimum"] == 7200
