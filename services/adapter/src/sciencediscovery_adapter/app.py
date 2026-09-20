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

"""Adapter application: migrated routes first, legacy proxy for the rest."""

from __future__ import annotations

from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import Response

from .config import Settings
from .proxy import proxy_to_legacy


def create_app(settings: Settings | None = None, *, transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # No read timeout: SSE runs stay open for the whole agent run.
        async with httpx.AsyncClient(
            base_url=settings.legacy_url,
            transport=transport,
            timeout=httpx.Timeout(connect=5.0, read=None, write=60.0, pool=5.0),
            follow_redirects=False,
        ) as client:
            app.state.legacy = client
            yield

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    # Migrated routes are registered above this line, one router per domain.

    @app.api_route(
        "/{path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        include_in_schema=False,
    )
    async def legacy(request: Request) -> Response:
        return await proxy_to_legacy(app.state.legacy, request)

    return app
