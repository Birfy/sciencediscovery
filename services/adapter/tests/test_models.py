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

import asyncio

from sciencediscovery_adapter.models import ModelProfile, ModelSync

URL = "ws://gw/ws"


class FakeGateway:
    def __init__(self, models=()):
        self.models = [dict(m) for m in models]
        self.replacements = []

    async def rpc(self, url, method, params=None, **kwargs):
        await asyncio.sleep(0)  # let another task interleave, as a real socket would
        if method == "models.list":
            return {"models": [dict(m) for m in self.models]}
        assert method == "models.replace_all"
        self.replacements.append(params["models"])
        self.models = [dict(m) for m in params["models"]]
        return {"count": len(self.models)}


def entry(name, base="http://a/v1", key="k", default=False, **extra):
    return {"model_name": name, "api_base": base, "api_key": key, "model_provider": "OpenAI", "is_default": default, **extra}


async def test_an_already_configured_model_changes_nothing():
    gateway = FakeGateway([entry("m1", default=True)])
    name = await ModelSync(gateway.rpc, URL).ensure(ModelProfile("m1", "http://a/v1", "k"))
    assert name == "m1" and gateway.replacements == []


async def test_a_new_model_is_added_and_the_others_are_kept():
    gateway = FakeGateway([entry("m1", default=True, origin_index=0, temperature=0.2)])
    name = await ModelSync(gateway.rpc, URL).ensure(ModelProfile("m2", "http://b/v1", "k2"))
    assert name == "m2"
    added, = gateway.replacements
    assert [m["model_name"] for m in added] == ["m1", "m2"]
    assert added[0]["temperature"] == 0.2 and "origin_index" not in added[0]  # kept, minus derived fields
    assert added[0]["is_default"] is True and added[1]["is_default"] is False
    assert added[1]["api_base"] == "http://b/v1" and added[1]["api_key"] == "k2"


async def test_a_changed_endpoint_or_key_replaces_the_entry_in_place():
    gateway = FakeGateway([entry("m1", default=True), entry("m2", key="old")])
    await ModelSync(gateway.rpc, URL).ensure(ModelProfile("m2", "http://a/v1", "new"))
    result, = gateway.replacements
    assert [m["model_name"] for m in result] == ["m1", "m2"] and result[1]["api_key"] == "new"
    assert sum(1 for m in result if m["model_name"] == "m2") == 1


async def test_the_first_model_becomes_the_default_when_there_is_none():
    gateway = FakeGateway([])
    await ModelSync(gateway.rpc, URL).ensure(ModelProfile("m1", "http://a/v1", "k"))
    assert gateway.replacements[0][0]["is_default"] is True


async def test_concurrent_runs_do_not_lose_each_others_models():
    gateway = FakeGateway([entry("m0", default=True)])
    sync = ModelSync(gateway.rpc, URL)
    await asyncio.gather(*(sync.ensure(ModelProfile(f"m{i}", f"http://h{i}/v1", "k")) for i in range(1, 6)))
    assert sorted(m["model_name"] for m in gateway.models) == [f"m{i}" for i in range(6)]
