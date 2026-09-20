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

"""JSON-schema handling for tools handed to JiuwenSwarm."""

from __future__ import annotations

from typing import Any

# Keywords that make a validator reject a call. ScienceDiscovery's own agent treats
# a tool's schema as guidance for the model and lets the tool decide what it accepts
# (out-of-range values are clamped or explained by the tool), while JiuwenSwarm
# validates strictly and would refuse the call before the tool ever ran.
_VALIDATION_KEYWORDS = frozenset({
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
    "minLength", "maxLength", "pattern", "format",
    "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties",
})


def relax_schema(schema: Any) -> Any:
    """A copy of `schema` without the constraints that only make validators stricter.

    Types, `required`, `enum`, `items`, `properties` and combinators stay: they say what
    a call is made of. `additionalProperties: false` becomes permissive.
    """
    if isinstance(schema, list):
        return [relax_schema(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    relaxed: dict[str, Any] = {}
    for key, value in schema.items():
        if key in _VALIDATION_KEYWORDS:
            continue
        if key == "additionalProperties" and value is False:
            continue
        relaxed[key] = relax_schema(value)
    return relaxed
